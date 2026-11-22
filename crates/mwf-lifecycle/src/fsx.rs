//! File operations under a base directory that never go through a symbolic link (ADRs 0037,
//! 0052). The base itself (`$HOME`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`) may be a link, as in
//! dotfile setups; every path component below it must be a real directory or file.
//!
//! [`read`] returns a [`Snapshot`]: the file's bytes and the (device, inode) of the file and of
//! every directory on the way. [`write`] and [`remove`] take that snapshot from planning time
//! and refuse (`CHANGED`) when any of them is no longer the same object, even with the same
//! contents. While they work they hold each directory open, as `mwf-store` does for `.mwf/`
//! (ADR 0048), and check before every create, rename or unlink, cleanup included, that each
//! path still names the directory they hold; once that fails nothing more is created, renamed
//! or unlinked. Writes are atomic (temporary file created with mode 0600 before any byte is
//! written, fsync, recheck, rename); a removal first renames the file aside and deletes it only
//! when the renamed file is still the one that was read. An existing file is copied to a 0600
//! backup first when asked.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::Error;

/// (device, inode); mwf targets only Unix (ADR 0012).
type Id = (u64, u64);

#[cfg(unix)]
fn id(meta: &Metadata) -> Id {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn id(_meta: &Metadata) -> Id {
    (0, 0)
}

fn wrong_type(path: &Path, what: &str) -> Error {
    Error::new(
        "WRONG_FILE_TYPE",
        format!("{} {what}; nothing was changed", path.display()),
    )
}

fn changed(path: &Path) -> Error {
    Error::new(
        "CHANGED",
        format!(
            "{} changed while mwf was working (a running agent may have rewritten it); run the command again",
            path.display()
        ),
    )
}

/// `meta` of `path` is a real directory (`file == false`) or regular file (`file == true`).
fn check_type(path: &Path, meta: &Metadata, file: bool) -> Result<(), Error> {
    if meta.file_type().is_symlink() {
        Err(wrong_type(
            path,
            "is a symbolic link, and mwf does not write through links",
        ))
    } else if file && !meta.is_file() {
        Err(wrong_type(path, "is not a regular file"))
    } else if !file && !meta.is_dir() {
        Err(wrong_type(path, "is not a directory"))
    } else {
        Ok(())
    }
}

/// The metadata of `path`: followed for the base (`follow`), never below it.
fn stat(path: &Path, follow: bool) -> io::Result<Metadata> {
    if follow {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    }
}

/// Opens `path`, which `meta` (from [`stat`]) says is a directory or file, and checks that
/// what was opened is that object: a link swapped in between is `CHANGED`.
fn open_checked(path: &Path, meta: &Metadata) -> Result<File, Error> {
    let f = File::open(path).map_err(|e| Error::io(path, &e))?;
    let opened = f.metadata().map_err(|e| Error::io(path, &e))?;
    if id(&opened) != id(meta) {
        return Err(changed(path));
    }
    Ok(f)
}

/// A file as planning saw it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    /// The contents; `None` when the file (or a directory on the way) did not exist.
    pub(crate) bytes: Option<Vec<u8>>,
    file: Option<Id>,
    /// The base, then each directory below it that existed, in order.
    dirs: Vec<Id>,
}

/// The contents and identities of `base/rel` and the directories on the way.
pub(crate) fn read(base: &Path, rel: &Path) -> Result<Snapshot, Error> {
    let meta = fs::metadata(base).map_err(|e| Error::io(base, &e))?;
    if !meta.is_dir() {
        return Err(wrong_type(base, "is not a directory"));
    }
    let mut snap = Snapshot {
        bytes: None,
        file: None,
        dirs: vec![id(&meta)],
    };
    let comps: Vec<_> = rel.components().collect();
    let mut cur = base.to_path_buf();
    for (i, c) in comps.iter().enumerate() {
        cur.push(c);
        let meta = match fs::symlink_metadata(&cur) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(snap),
            Err(e) => return Err(Error::io(&cur, &e)),
        };
        let last = i + 1 == comps.len();
        check_type(&cur, &meta, last)?;
        if !last {
            snap.dirs.push(id(&meta));
        }
    }
    let meta = fs::symlink_metadata(&cur).map_err(|e| Error::io(&cur, &e))?;
    let mut file = open_checked(&cur, &meta)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| Error::io(&cur, &e))?;
    snap.bytes = Some(bytes);
    snap.file = Some(id(&meta));
    Ok(snap)
}

/// `base/rel` is still the file `old` saw (or still absent): same contents, same inode.
fn verify(base: &Path, rel: &Path, old: &Snapshot) -> Result<(), Error> {
    let now = read(base, rel)?;
    if now.bytes == old.bytes && now.file == old.file {
        Ok(())
    } else {
        Err(changed(&base.join(rel)))
    }
}

/// The directories from the base down to a file's directory, each held open.
struct Pins(Vec<(PathBuf, File)>);

impl Pins {
    /// Opens `base` (followed, it may be a link) and the directories of `rel` below it,
    /// creating missing ones when `create`; a missing one without `create` is `CHANGED`. The
    /// first `expect.len()` of them must still be the directories planning saw.
    fn new(base: &Path, rel: &Path, create: bool, expect: &[Id]) -> Result<Pins, Error> {
        let mut pins = Pins(Vec::new());
        let mut cur = base.to_path_buf();
        let comps: Vec<_> = rel.components().collect();
        for i in 0..=comps.len() {
            if i > 0 {
                cur.push(comps[i - 1]);
            }
            let meta = match stat(&cur, i == 0) {
                Ok(m) => m,
                Err(e) if e.kind() == io::ErrorKind::NotFound && create && i >= expect.len() => {
                    pins.hold()?;
                    match fs::create_dir(&cur) {
                        Ok(()) => sync(pins.0.last().map(|p| &p.1)),
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(e) => return Err(Error::io(&cur, &e)),
                    }
                    fs::symlink_metadata(&cur).map_err(|e| Error::io(&cur, &e))?
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(changed(&cur)),
                Err(e) => return Err(Error::io(&cur, &e)),
            };
            check_type(&cur, &meta, false)?;
            if expect.get(i).is_some_and(|want| *want != id(&meta)) {
                return Err(changed(&cur));
            }
            let held = open_checked(&cur, &meta)?;
            pins.0.push((cur.clone(), held));
        }
        Ok(pins)
    }

    /// Every path still names the real directory held open for it.
    fn hold(&self) -> Result<(), Error> {
        for (i, (path, held)) in self.0.iter().enumerate() {
            let meta = match stat(path, i == 0) {
                Ok(m) => m,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(changed(path)),
                Err(e) => return Err(Error::io(path, &e)),
            };
            check_type(path, &meta, false)?;
            let want = held.metadata().map_err(|e| Error::io(path, &e))?;
            if id(&meta) != id(&want) {
                return Err(changed(path));
            }
        }
        Ok(())
    }

    fn dir(&self) -> &Path {
        self.0.last().map_or(Path::new(""), |(p, _)| p)
    }

    /// Unlinks `name` in the held directory, only while every pin holds.
    fn unlink(&self, path: &Path) -> Result<(), Error> {
        self.hold()?;
        fs::remove_file(path).map_err(|e| Error::io(path, &e))
    }

    fn sync(&self) {
        sync(self.0.last().map(|p| &p.1));
    }
}

fn sync(dir: Option<&File>) {
    if let Some(f) = dir {
        let _ = f.sync_all();
    }
}

// A test seam run right before the last check of a write or removal, so a test can change
// the file or swap a directory at exactly that moment.
#[cfg(test)]
thread_local! {
    pub(crate) static BEFORE_COMMIT: std::cell::RefCell<Option<Box<dyn Fn()>>> =
        std::cell::RefCell::new(None);
}

fn before_commit() {
    #[cfg(test)]
    BEFORE_COMMIT.with(|f| {
        if let Some(f) = &*f.borrow() {
            f();
        }
    });
}

/// A new file in the held directory named `<prefix><name><infix>[-n]`, created exclusively
/// with mode 0600 before anything is written to it.
fn create_new(
    pins: &Pins,
    name: &str,
    prefix: &str,
    infix: &str,
) -> Result<(PathBuf, File), Error> {
    for n in 0..1000 {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = pins.dir().join(format!("{prefix}{name}{infix}{suffix}"));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        pins.hold()?;
        match opts.open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(Error::io(&candidate, &e)),
        }
    }
    Err(Error::new(
        "IO",
        format!("cannot find a free file name in {}", pins.dir().display()),
    ))
}

fn file_name(rel: &Path) -> String {
    rel.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Copies `old` to `<name>.mwf-bak-<unix seconds>[-n]` (mode 0600) in the held directory.
fn backup(pins: &Pins, name: &str, old: &[u8]) -> Result<PathBuf, Error> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (bak, mut f) = create_new(pins, name, "", &format!(".mwf-bak-{secs}"))?;
    f.write_all(old)
        .and_then(|()| f.sync_all())
        .map_err(|e| Error::io(&bak, &e))?;
    pins.sync();
    Ok(bak)
}

/// Writes `new` to `base/rel` if it is still the file `old` saw at planning; returns the
/// backup made, if any. A new file gets mode 0600; an existing one keeps its permissions.
pub(crate) fn write(
    base: &Path,
    rel: &Path,
    old: &Snapshot,
    new: &[u8],
    keep_backup: bool,
) -> Result<Option<PathBuf>, Error> {
    let pins = Pins::new(base, rel.parent().unwrap_or(Path::new("")), true, &old.dirs)?;
    let name = file_name(rel);
    let path = pins.dir().join(&name);
    verify(base, rel, old)?;
    let bak = match &old.bytes {
        Some(bytes) if keep_backup => Some(backup(&pins, &name, bytes)?),
        _ => None,
    };
    let (tmp, mut f) = create_new(
        &pins,
        &name,
        ".",
        &format!(".mwf-tmp-{}", std::process::id()),
    )?;
    let result = (|| {
        f.write_all(new)
            .and_then(|()| {
                if old.bytes.is_some() {
                    let perms = fs::symlink_metadata(&path)?.permissions();
                    f.set_permissions(perms)?;
                }
                f.sync_all()
            })
            .map_err(|e| Error::io(&tmp, &e))?;
        before_commit();
        pins.hold()?;
        verify(base, rel, old)?;
        pins.hold()?;
        if old.bytes.is_some() {
            fs::rename(&tmp, &path).map_err(|e| Error::io(&path, &e))
        } else {
            // A link never replaces a file that appeared in the meantime.
            match fs::hard_link(&tmp, &path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(changed(&path)),
                Err(e) => Err(Error::io(&path, &e)),
            }
        }
    })();
    // After a rename the name is gone; otherwise it is removed only through the same
    // directory. If that no longer holds, the 0600 temporary file is left where it is.
    if fs::symlink_metadata(&tmp).is_ok() {
        let _ = pins.unlink(&tmp);
    }
    result?;
    pins.sync();
    Ok(bak)
}

/// Removes `base/rel` if it is still the file `old` saw at planning; returns the backup made,
/// if any. The file is renamed aside first and deleted only if what was renamed is still that
/// file; otherwise it is put back (or left beside, if a new file took its place) and the
/// result is `CHANGED`.
pub(crate) fn remove(
    base: &Path,
    rel: &Path,
    old: &Snapshot,
    keep_backup: bool,
) -> Result<Option<PathBuf>, Error> {
    let path = base.join(rel);
    let Some(bytes) = old.bytes.as_deref() else {
        return Err(changed(&path));
    };
    let pins = Pins::new(
        base,
        rel.parent().unwrap_or(Path::new("")),
        false,
        &old.dirs,
    )?;
    let name = file_name(rel);
    let path = pins.dir().join(&name);
    verify(base, rel, old)?;
    let bak = if keep_backup {
        Some(backup(&pins, &name, bytes)?)
    } else {
        None
    };
    before_commit();
    pins.hold()?;
    verify(base, rel, old)?;
    let (aside, placeholder) = create_new(
        &pins,
        &name,
        ".",
        &format!(".mwf-del-{}", std::process::id()),
    )?;
    drop(placeholder);
    pins.hold()?;
    if let Err(e) = fs::rename(&path, &aside) {
        let _ = pins.unlink(&aside);
        return Err(Error::io(&path, &e));
    }
    let moved = fs::symlink_metadata(&aside)
        .ok()
        .filter(Metadata::is_file)
        .and_then(|m| fs::read(&aside).ok().map(|b| (b, id(&m))));
    if moved.as_ref().map(|(b, i)| (b.as_slice(), Some(*i))) != Some((bytes, old.file)) {
        // Someone else's file: put it back without overwriting anything new.
        if pins.hold().is_ok() && fs::hard_link(&aside, &path).is_ok() {
            let _ = pins.unlink(&aside);
        }
        return Err(changed(&path));
    }
    pins.unlink(&aside)?;
    pins.sync();
    Ok(bak)
}

/// Removes the directory `base/rel` if it is a real, empty directory reached without links
/// (each directory on the way held open and checked); whether it is gone.
pub(crate) fn remove_empty_dir(base: &Path, rel: &Path) -> bool {
    match fs::symlink_metadata(base.join(rel)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return true,
        Err(_) => return false,
        Ok(_) => {}
    }
    let Ok(pins) = Pins::new(base, rel, false, &[]) else {
        return false;
    };
    let path = pins.dir().to_path_buf();
    if pins.hold().is_err() || fs::remove_dir(&path).is_err() {
        return false;
    }
    if let Some((_, parent)) = pins.0.len().checked_sub(2).and_then(|i| pins.0.get(i)) {
        let _ = parent.sync_all();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes `new` over what is there now.
    fn put(
        base: &Path,
        rel: &str,
        new: &[u8],
        keep_backup: bool,
    ) -> Result<Option<PathBuf>, Error> {
        let rel = Path::new(rel);
        write(base, rel, &read(base, rel)?, new, keep_backup)
    }

    fn bytes(base: &Path, rel: &str) -> Option<Vec<u8>> {
        read(base, Path::new(rel)).unwrap().bytes
    }

    /// Runs `f` with `hook` as the [`BEFORE_COMMIT`] seam.
    fn with_seam<T>(hook: impl Fn() + 'static, f: impl FnOnce() -> T) -> T {
        BEFORE_COMMIT.with(|s| *s.borrow_mut() = Some(Box::new(hook)));
        let out = f();
        BEFORE_COMMIT.with(|s| *s.borrow_mut() = None);
        out
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn writes_creates_dirs_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        assert_eq!(bytes(base, "a/b/f.json"), None);
        assert_eq!(put(base, "a/b/f.json", b"one", true).unwrap(), None);
        assert_eq!(bytes(base, "a/b/f.json").unwrap(), b"one");
        let bak = put(base, "a/b/f.json", b"two", true).unwrap().unwrap();
        assert_eq!(fs::read(&bak).unwrap(), b"one");
        let bak_name = bak.file_name().unwrap().to_str().unwrap().to_owned();
        assert!(bak_name.starts_with("f.json.mwf-bak-"), "{bak_name}");
        // A second backup in the same second gets another name.
        let bak2 = put(base, "a/b/f.json", b"three", true).unwrap().unwrap();
        assert_ne!(bak, bak2);
        assert_eq!(fs::read(&bak2).unwrap(), b"two");
        // No temporary file is left behind.
        assert_eq!(names(&base.join("a/b")).len(), 3);
        let rel = Path::new("a/b/f.json");
        assert_eq!(
            remove(base, rel, &read(base, rel).unwrap(), false).unwrap(),
            None
        );
        assert_eq!(bytes(base, "a/b/f.json"), None);
        assert_eq!(names(&base.join("a/b")).len(), 2);
    }

    #[test]
    fn refuses_a_file_that_changed_since_it_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let rel = Path::new("f");
        let absent = read(base, rel).unwrap();
        fs::write(base.join(rel), "mine").unwrap();
        let mine = read(base, rel).unwrap();
        fs::write(base.join(rel), "theirs").unwrap();
        assert_eq!(
            write(base, rel, &mine, b"new", true).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(
            write(base, rel, &absent, b"new", true).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(remove(base, rel, &mine, true).unwrap_err().code, "CHANGED");
        assert_eq!(fs::read(base.join(rel)).unwrap(), b"theirs");
        assert_eq!(names(base), ["f"]);
    }

    #[test]
    fn a_same_content_replacement_between_plan_and_apply_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let rel = Path::new("d/f");
        put(base, "d/f", b"same", false).unwrap();
        let planned = read(base, rel).unwrap();
        // Another file with the same bytes (a new inode) takes its place. The old one is
        // kept, so the file system cannot hand its inode number to the new one.
        fs::rename(base.join(rel), base.join("kept")).unwrap();
        fs::write(base.join(rel), "same").unwrap();
        assert_eq!(
            write(base, rel, &planned, b"new", false).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(
            remove(base, rel, &planned, false).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(fs::read(base.join(rel)).unwrap(), b"same");
        // A directory on the way replaced by an identical one is refused too, for a file
        // that exists and for one that does not yet.
        let planned = read(base, rel).unwrap();
        let planned_new = read(base, Path::new("d/g")).unwrap();
        fs::rename(base.join("d"), base.join("d-old")).unwrap();
        fs::create_dir(base.join("d")).unwrap();
        fs::write(base.join(rel), "same").unwrap();
        assert_eq!(
            write(base, rel, &planned, b"new", false).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(
            remove(base, rel, &planned, false).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(
            write(base, Path::new("d/g"), &planned_new, b"new", false)
                .unwrap_err()
                .code,
            "CHANGED"
        );
        assert_eq!(names(&base.join("d")), ["f"]);
        // A directory that existed at planning and is gone now is not recreated.
        fs::remove_dir_all(base.join("d")).unwrap();
        assert_eq!(
            write(base, rel, &planned_new, b"new", false)
                .unwrap_err()
                .code,
            "CHANGED"
        );
        assert!(!base.join("d").exists());
    }

    #[test]
    fn an_edit_right_before_the_rename_or_removal_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let rel = Path::new("d/f");
        put(&base, "d/f", b"old", false).unwrap();
        let target = base.join(rel);
        let t = target.clone();
        let snap = read(&base, rel).unwrap();
        let err = with_seam(
            move || fs::write(&t, "theirs").unwrap(),
            || write(&base, rel, &snap, b"new", false).unwrap_err(),
        );
        assert_eq!(err.code, "CHANGED");
        assert_eq!(fs::read(&target).unwrap(), b"theirs");
        // Not deleted: the edit made after the backup survives.
        let t = target.clone();
        let snap = read(&base, rel).unwrap();
        let err = with_seam(
            move || fs::write(&t, "edited again").unwrap(),
            || remove(&base, rel, &snap, true).unwrap_err(),
        );
        assert_eq!(err.code, "CHANGED");
        assert_eq!(fs::read(&target).unwrap(), b"edited again");
        // Replaced by another file with the same contents: still not removed.
        let t = target.clone();
        let snap = read(&base, rel).unwrap();
        let err = with_seam(
            move || {
                fs::rename(&t, t.with_file_name("kept")).unwrap();
                fs::write(&t, "edited again").unwrap();
            },
            || remove(&base, rel, &snap, false).unwrap_err(),
        );
        assert_eq!(err.code, "CHANGED");
        assert_eq!(fs::read(&target).unwrap(), b"edited again");
        // Only the file, the one backup and the kept original: no temporary or set-aside
        // files.
        let left = names(&base.join("d"));
        assert_eq!(left.len(), 3, "{left:?}");
        assert!(left[1].starts_with("f.mwf-bak-"), "{left:?}");
        assert_eq!(left[2], "kept");
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_swapped_for_a_link_is_never_written_or_unlinked_through() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let elsewhere = base.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("f"), "outside").unwrap();
        // A file outside with the temporary file's name: cleanup must not unlink it.
        let tmp_name = format!(".f.mwf-tmp-{}", std::process::id());
        fs::write(elsewhere.join(&tmp_name), "outside tmp").unwrap();
        let rel = Path::new("d/f");
        put(&base, "d/f", b"old", false).unwrap();
        let swap = {
            let (d, e) = (base.join("d"), elsewhere.clone());
            let moved = base.join("d-moved");
            move || {
                fs::rename(&d, &moved).unwrap();
                symlink(&e, &d).unwrap();
            }
        };
        let snap = read(&base, rel).unwrap();
        let err = with_seam(swap, || {
            write(&base, rel, &snap, b"new", false).unwrap_err()
        });
        assert_eq!(err.code, "WRONG_FILE_TYPE", "{}", err.message);
        assert_eq!(names(&elsewhere), [tmp_name.as_str(), "f"]);
        assert_eq!(fs::read(elsewhere.join("f")).unwrap(), b"outside");
        assert_eq!(fs::read(elsewhere.join(&tmp_name)).unwrap(), b"outside tmp");
        // The real temporary file stays, 0600, in the directory that was moved away.
        assert!(base.join("d-moved").join(&tmp_name).is_file());
        fs::remove_file(base.join("d-moved").join(&tmp_name)).unwrap();
        // The same for a removal, and for a parent replaced by another real directory.
        fs::remove_file(base.join("d")).unwrap();
        fs::rename(base.join("d-moved"), base.join("d")).unwrap();
        let swap = {
            let d = base.join("d");
            let moved = base.join("d-moved");
            move || {
                fs::rename(&d, &moved).unwrap();
                fs::create_dir(&d).unwrap();
                fs::write(d.join("f"), "old").unwrap();
            }
        };
        let snap = read(&base, rel).unwrap();
        let err = with_seam(swap, || remove(&base, rel, &snap, false).unwrap_err());
        assert_eq!(err.code, "CHANGED", "{}", err.message);
        assert_eq!(fs::read(base.join("d/f")).unwrap(), b"old");
        assert_eq!(fs::read(base.join("d-moved/f")).unwrap(), b"old");
    }

    #[cfg(unix)]
    #[test]
    fn remove_empty_dir_does_not_go_through_links() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join("elsewhere/b")).unwrap();
        symlink(base.join("elsewhere"), base.join("a")).unwrap();
        assert!(!remove_empty_dir(base, Path::new("a/b")));
        assert!(base.join("elsewhere/b").is_dir());
        symlink(base.join("elsewhere/b"), base.join("c")).unwrap();
        assert!(!remove_empty_dir(base, Path::new("c")));
        assert!(base.join("elsewhere/b").is_dir());
        fs::create_dir_all(base.join("x/y")).unwrap();
        fs::write(base.join("x/f"), "").unwrap();
        assert!(remove_empty_dir(base, Path::new("x/y")));
        assert!(!remove_empty_dir(base, Path::new("x")));
        assert!(remove_empty_dir(base, Path::new("x/missing")));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_below_the_base_but_not_the_base() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir(&real).unwrap();
        let base = dir.path().join("home");
        symlink(&real, &base).unwrap();
        // The base may be a link.
        put(&base, "x/f", b"1", false).unwrap();
        assert_eq!(fs::read(real.join("x/f")).unwrap(), b"1");
        // A link to a directory below it is refused, as is a link to a file.
        symlink(real.join("x"), real.join("y")).unwrap();
        let err = read(&base, Path::new("y/f")).unwrap_err();
        assert_eq!(err.code, "WRONG_FILE_TYPE");
        assert!(
            err.message.contains("is a symbolic link"),
            "{}",
            err.message
        );
        assert_eq!(
            put(&base, "y/g", b"1", false).unwrap_err().code,
            "WRONG_FILE_TYPE"
        );
        assert!(!real.join("x/g").exists());
        symlink(real.join("x/f"), real.join("lf")).unwrap();
        assert_eq!(
            read(&base, Path::new("lf")).unwrap_err().code,
            "WRONG_FILE_TYPE"
        );
        // A dangling link is a link too.
        symlink(real.join("nowhere"), real.join("dangling")).unwrap();
        assert_eq!(
            put(&base, "dangling", b"1", false).unwrap_err().code,
            "WRONG_FILE_TYPE"
        );
        assert!(!real.join("nowhere").exists());
        // A file where a directory should be, and a directory where a file should be.
        let err = read(&base, Path::new("x/f/z")).unwrap_err();
        assert!(
            err.message.contains("is not a directory"),
            "{}",
            err.message
        );
        let err = read(&base, Path::new("x")).unwrap_err();
        assert!(
            err.message.contains("is not a regular file"),
            "{}",
            err.message
        );
    }

    #[cfg(unix)]
    #[test]
    fn new_files_are_0600_and_existing_files_keep_their_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        put(base, "n", b"1", false).unwrap();
        assert_eq!(mode(&base.join("n")), 0o600);
        fs::write(base.join("e"), "1").unwrap();
        fs::set_permissions(base.join("e"), fs::Permissions::from_mode(0o644)).unwrap();
        // Seen at the last moment: the temporary file got the target's mode only after its
        // bytes were written (it was created 0600).
        let seen = std::rc::Rc::new(std::cell::Cell::new(0));
        let (s, b) = (seen.clone(), base.to_path_buf());
        let snap = read(base, Path::new("e")).unwrap();
        with_seam(
            move || {
                for e in fs::read_dir(&b).unwrap() {
                    let p = e.unwrap().path();
                    let n = p.file_name().unwrap().to_string_lossy().into_owned();
                    if n.contains(".mwf-tmp-") {
                        s.set(mode(&p));
                    }
                }
            },
            || write(base, Path::new("e"), &snap, b"2", true).unwrap(),
        );
        assert_eq!(seen.get(), 0o644);
        assert_eq!(mode(&base.join("e")), 0o644);
        let bak = names(base)
            .into_iter()
            .find(|n| n.starts_with("e.mwf-bak-"))
            .unwrap();
        assert_eq!(mode(&base.join(bak)), 0o600);
    }
}
