//! File operations under a base directory that never go through a symbolic link (ADRs 0037,
//! 0052). The base itself (`$HOME`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`) may be a link, as in
//! dotfile setups; every path component below it must be a real directory or file.
//!
//! Every directory on the way is pinned by its (device, inode) when it is first checked, and
//! checked again right before each step that creates, renames or removes a file, as `mwf-store`
//! does for `.mwf/` (ADR 0048): a directory swapped for a link or another directory in between
//! is `WRONG_FILE_TYPE` / `CHANGED`, and nothing more is written. Writes are atomic (temporary
//! file created with mode 0600 before any byte is written, fsync, recheck, rename); a removal
//! first renames the file aside and only deletes it once the renamed file is still what was
//! read. An existing file is copied to a 0600 backup first when asked.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
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

/// The directories from the base down to a file's directory, each with the identity it had
/// when it was checked.
struct Pins(Vec<(PathBuf, Id)>);

impl Pins {
    /// Pins `base` (followed, it may be a link) and the directories of `rel` below it,
    /// creating missing ones when `create`; a missing one without `create` is `CHANGED`.
    fn new(base: &Path, rel: &Path, create: bool) -> Result<Pins, Error> {
        let meta = fs::metadata(base).map_err(|e| Error::io(base, &e))?;
        if !meta.is_dir() {
            return Err(wrong_type(base, "is not a directory"));
        }
        let mut pins = vec![(base.to_path_buf(), id(&meta))];
        let mut cur = base.to_path_buf();
        for c in rel.components() {
            cur.push(c);
            let meta = match fs::symlink_metadata(&cur) {
                Ok(m) => m,
                Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                    pins_hold(&pins)?;
                    match fs::create_dir(&cur) {
                        Ok(()) => sync_dir(cur.parent()),
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(e) => return Err(Error::io(&cur, &e)),
                    }
                    fs::symlink_metadata(&cur).map_err(|e| Error::io(&cur, &e))?
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(changed(&cur)),
                Err(e) => return Err(Error::io(&cur, &e)),
            };
            check_type(&cur, &meta, false)?;
            pins.push((cur.clone(), id(&meta)));
        }
        Ok(Pins(pins))
    }

    /// Every pinned directory is still the same real directory.
    fn hold(&self) -> Result<(), Error> {
        pins_hold(&self.0)
    }

    fn dir(&self) -> &Path {
        self.0.last().map_or(Path::new(""), |(p, _)| p)
    }
}

fn pins_hold(pins: &[(PathBuf, Id)]) -> Result<(), Error> {
    for (i, (path, want)) in pins.iter().enumerate() {
        // The base is followed (it may be a link); below it nothing is.
        let meta = if i == 0 {
            fs::metadata(path)
        } else {
            fs::symlink_metadata(path)
        };
        let meta = match meta {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(changed(path)),
            Err(e) => return Err(Error::io(path, &e)),
        };
        check_type(path, &meta, false)?;
        if id(&meta) != *want {
            return Err(changed(path));
        }
    }
    Ok(())
}

/// The contents of `base/rel`, `None` when it (or a directory on the way) does not exist.
pub(crate) fn read(base: &Path, rel: &Path) -> Result<Option<Vec<u8>>, Error> {
    Ok(snapshot(base, rel)?.map(|(bytes, _)| bytes))
}

/// The contents and identity of `base/rel`, `None` when it does not exist.
fn snapshot(base: &Path, rel: &Path) -> Result<Option<(Vec<u8>, Id)>, Error> {
    let comps: Vec<_> = rel.components().collect();
    let mut cur = base.to_path_buf();
    for (i, c) in comps.iter().enumerate() {
        cur.push(c);
        let meta = match fs::symlink_metadata(&cur) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::io(&cur, &e)),
        };
        check_type(&cur, &meta, i + 1 == comps.len())?;
    }
    let file = File::open(&cur).map_err(|e| Error::io(&cur, &e))?;
    let meta = file.metadata().map_err(|e| Error::io(&cur, &e))?;
    let mut bytes = Vec::new();
    io::Read::read_to_end(&mut &file, &mut bytes).map_err(|e| Error::io(&cur, &e))?;
    Ok(Some((bytes, id(&meta))))
}

/// `base/rel` still holds `old` (`None`: still does not exist); its identity.
fn verify(base: &Path, rel: &Path, old: Option<&[u8]>) -> Result<Option<Id>, Error> {
    let now = snapshot(base, rel)?;
    if now.as_ref().map(|(b, _)| b.as_slice()) == old {
        Ok(now.map(|(_, i)| i))
    } else {
        Err(changed(&base.join(rel)))
    }
}

fn sync_dir(dir: Option<&Path>) {
    if let Some(dir) = dir
        && let Ok(f) = File::open(dir)
    {
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

/// A new file in `dir` named `<prefix><name><infix>[-n]`, created exclusively with mode 0600
/// before anything is written to it.
fn create_new(dir: &Path, name: &str, prefix: &str, infix: &str) -> Result<(PathBuf, File), Error> {
    for n in 0..1000 {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = dir.join(format!("{prefix}{name}{infix}{suffix}"));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(Error::io(&candidate, &e)),
        }
    }
    Err(Error::new(
        "IO",
        format!("cannot find a free file name in {}", dir.display()),
    ))
}

fn file_name(rel: &Path) -> String {
    rel.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Copies `old` to `<name>.mwf-bak-<unix seconds>[-n]` (mode 0600) in the pinned directory.
fn backup(pins: &Pins, name: &str, old: &[u8]) -> Result<PathBuf, Error> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    pins.hold()?;
    let (bak, mut f) = create_new(pins.dir(), name, "", &format!(".mwf-bak-{secs}"))?;
    f.write_all(old)
        .and_then(|()| f.sync_all())
        .map_err(|e| Error::io(&bak, &e))?;
    sync_dir(Some(pins.dir()));
    Ok(bak)
}

/// Writes `new` to `base/rel` if it still holds `old`; returns the backup made, if any. A new
/// file gets mode 0600; an existing one keeps its permissions.
pub(crate) fn write(
    base: &Path,
    rel: &Path,
    old: Option<&[u8]>,
    new: &[u8],
    keep_backup: bool,
) -> Result<Option<PathBuf>, Error> {
    let pins = Pins::new(base, rel.parent().unwrap_or(Path::new("")), true)?;
    let name = file_name(rel);
    let path = pins.dir().join(&name);
    let first = verify(base, rel, old)?;
    let bak = match old {
        Some(old) if keep_backup => Some(backup(&pins, &name, old)?),
        _ => None,
    };
    pins.hold()?;
    let (tmp, mut f) = create_new(
        pins.dir(),
        &name,
        ".",
        &format!(".mwf-tmp-{}", std::process::id()),
    )?;
    let result = (|| {
        f.write_all(new)
            .and_then(|()| {
                if old.is_some() {
                    let perms = fs::symlink_metadata(&path)?.permissions();
                    f.set_permissions(perms)?;
                }
                f.sync_all()
            })
            .map_err(|e| Error::io(&tmp, &e))?;
        before_commit();
        pins.hold()?;
        if verify(base, rel, old)? != first {
            return Err(changed(&path));
        }
        if old.is_some() {
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
    let _ = fs::remove_file(&tmp);
    result?;
    sync_dir(Some(pins.dir()));
    Ok(bak)
}

/// Removes `base/rel` if it still holds `old`; returns the backup made, if any. The file is
/// renamed aside first and deleted only if what was renamed is still `old`; otherwise it is put
/// back (or left beside, if a new file took its place) and the result is `CHANGED`.
pub(crate) fn remove(
    base: &Path,
    rel: &Path,
    old: &[u8],
    keep_backup: bool,
) -> Result<Option<PathBuf>, Error> {
    let pins = Pins::new(base, rel.parent().unwrap_or(Path::new("")), false)?;
    let name = file_name(rel);
    let path = pins.dir().join(&name);
    let first = verify(base, rel, Some(old))?;
    let bak = if keep_backup {
        Some(backup(&pins, &name, old)?)
    } else {
        None
    };
    before_commit();
    pins.hold()?;
    if verify(base, rel, Some(old))? != first {
        return Err(changed(&path));
    }
    let (aside, _placeholder) = create_new(
        pins.dir(),
        &name,
        ".",
        &format!(".mwf-del-{}", std::process::id()),
    )?;
    if let Err(e) = fs::rename(&path, &aside) {
        let _ = fs::remove_file(&aside);
        return Err(Error::io(&path, &e));
    }
    let moved = fs::symlink_metadata(&aside)
        .ok()
        .filter(|m| m.is_file())
        .and_then(|m| fs::read(&aside).ok().map(|b| (b, id(&m))));
    if moved.as_ref().map(|(b, i)| (b.as_slice(), Some(*i))) != Some((old, first)) {
        // Someone else's file: put it back without overwriting anything new.
        if fs::hard_link(&aside, &path).is_ok() {
            let _ = fs::remove_file(&aside);
        }
        return Err(changed(&path));
    }
    fs::remove_file(&aside).map_err(|e| Error::io(&aside, &e))?;
    sync_dir(Some(pins.dir()));
    Ok(bak)
}

/// Removes the directory `base/rel` if it is a real, empty directory; whether it is gone.
pub(crate) fn remove_empty_dir(base: &Path, rel: &Path) -> bool {
    let path = base.join(rel);
    match fs::symlink_metadata(&path) {
        Ok(m) if m.is_dir() => {
            let gone = fs::remove_dir(&path).is_ok();
            if gone {
                sync_dir(path.parent());
            }
            gone
        }
        Ok(_) => false,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_creates_dirs_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let rel = Path::new("a/b/f.json");
        assert_eq!(read(base, rel).unwrap(), None);
        assert_eq!(write(base, rel, None, b"one", true).unwrap(), None);
        assert_eq!(read(base, rel).unwrap().unwrap(), b"one");
        let bak = write(base, rel, Some(b"one"), b"two", true)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(&bak).unwrap(), b"one");
        assert!(
            bak.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("f.json.mwf-bak-")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&bak).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        // A second backup in the same second gets another name.
        let bak2 = write(base, rel, Some(b"two"), b"three", true)
            .unwrap()
            .unwrap();
        assert_ne!(bak, bak2);
        assert_eq!(fs::read(&bak2).unwrap(), b"two");
        // No temporary file is left behind.
        let names: Vec<_> = fs::read_dir(base.join("a/b"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert_eq!(remove(base, rel, b"three", false).unwrap(), None);
        assert_eq!(read(base, rel).unwrap(), None);
    }

    #[test]
    fn refuses_a_file_that_changed() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let rel = Path::new("f");
        fs::write(base.join(rel), "theirs").unwrap();
        let err = write(base, rel, Some(b"mine"), b"new", true).unwrap_err();
        assert_eq!(err.code, "CHANGED");
        let err = write(base, rel, None, b"new", true).unwrap_err();
        assert_eq!(err.code, "CHANGED");
        assert_eq!(
            remove(base, rel, b"mine", true).unwrap_err().code,
            "CHANGED"
        );
        assert_eq!(fs::read(base.join(rel)).unwrap(), b"theirs");
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
        write(&base, Path::new("x/f"), None, b"1", false).unwrap();
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
        let err = write(&base, Path::new("y/g"), None, b"1", false).unwrap_err();
        assert_eq!(err.code, "WRONG_FILE_TYPE");
        assert!(!real.join("x/g").exists());
        symlink(real.join("x/f"), real.join("lf")).unwrap();
        assert_eq!(
            read(&base, Path::new("lf")).unwrap_err().code,
            "WRONG_FILE_TYPE"
        );
        // A dangling link is a link too.
        symlink(real.join("nowhere"), real.join("dangling")).unwrap();
        assert_eq!(
            write(&base, Path::new("dangling"), None, b"1", false)
                .unwrap_err()
                .code,
            "WRONG_FILE_TYPE"
        );
        assert!(!real.join("nowhere").exists());
        // A file where a directory should be, and a directory where a file should be.
        assert!(
            read(&base, Path::new("x/f/z"))
                .unwrap_err()
                .message
                .contains("is not a directory")
        );
        assert!(
            read(&base, Path::new("x"))
                .unwrap_err()
                .message
                .contains("is not a regular file")
        );
        // remove_empty_dir leaves links and non-empty directories alone.
        assert!(!remove_empty_dir(&base, Path::new("y")));
        assert!(real.join("y").exists());
        assert!(!remove_empty_dir(&base, Path::new("x")));
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
    fn an_edit_right_before_the_rename_or_removal_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let rel = Path::new("d/f");
        write(&base, rel, None, b"old", false).unwrap();
        let target = base.join(rel);
        let t = target.clone();
        let err = with_seam(
            move || fs::write(&t, "theirs").unwrap(),
            || write(&base, rel, Some(b"old"), b"new", false).unwrap_err(),
        );
        assert_eq!(err.code, "CHANGED");
        assert_eq!(fs::read(&target).unwrap(), b"theirs");
        // Not deleted: the edit made after the backup survives.
        let t = target.clone();
        let err = with_seam(
            move || fs::write(&t, "edited again").unwrap(),
            || remove(&base, rel, b"theirs", true).unwrap_err(),
        );
        assert_eq!(err.code, "CHANGED");
        assert_eq!(fs::read(&target).unwrap(), b"edited again");
        // Replaced by another file with the same contents: still not removed.
        let t = target.clone();
        let err = with_seam(
            move || {
                fs::remove_file(&t).unwrap();
                fs::write(&t, "edited again").unwrap();
            },
            || remove(&base, rel, b"edited again", false).unwrap_err(),
        );
        assert_eq!(err.code, "CHANGED");
        assert_eq!(fs::read(&target).unwrap(), b"edited again");
        // Only the file and the one backup: no temporary or set-aside files.
        let left = names(&base.join("d"));
        assert_eq!(left.len(), 2, "{left:?}");
        assert!(left[1].starts_with("f.mwf-bak-"), "{left:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_swapped_for_a_link_is_refused_before_writing_through_it() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let elsewhere = base.join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        fs::write(elsewhere.join("f"), "outside").unwrap();
        let rel = Path::new("d/f");
        write(&base, rel, None, b"old", false).unwrap();
        let swap = {
            let (d, e) = (base.join("d"), elsewhere.clone());
            let moved = base.join("d-moved");
            move || {
                fs::rename(&d, &moved).unwrap();
                symlink(&e, &d).unwrap();
            }
        };
        let err = with_seam(swap, || {
            write(&base, rel, Some(b"old"), b"new", false).unwrap_err()
        });
        assert_eq!(err.code, "WRONG_FILE_TYPE", "{}", err.message);
        assert_eq!(names(&elsewhere), ["f"]);
        assert_eq!(fs::read(elsewhere.join("f")).unwrap(), b"outside");
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
        let err = with_seam(swap, || remove(&base, rel, b"old", false).unwrap_err());
        assert_eq!(err.code, "CHANGED", "{}", err.message);
        assert_eq!(fs::read(base.join("d/f")).unwrap(), b"old");
        assert_eq!(fs::read(base.join("d-moved/f")).unwrap(), b"old");
    }

    #[cfg(unix)]
    #[test]
    fn new_files_are_0600_and_existing_files_keep_their_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        write(base, Path::new("n"), None, b"1", false).unwrap();
        assert_eq!(mode(&base.join("n")), 0o600);
        fs::write(base.join("e"), "1").unwrap();
        fs::set_permissions(base.join("e"), fs::Permissions::from_mode(0o644)).unwrap();
        // Seen at the last moment: the temporary file is 0600 while its bytes are written.
        let seen = std::rc::Rc::new(std::cell::Cell::new(0));
        let (s, b) = (seen.clone(), base.to_path_buf());
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
            || write(base, Path::new("e"), Some(b"1"), b"2", true).unwrap(),
        );
        // The temporary file had the target's mode only after its bytes were written; the
        // backup was 0600 from its creation.
        assert_eq!(seen.get(), 0o644);
        assert_eq!(mode(&base.join("e")), 0o644);
        let bak = names(base)
            .into_iter()
            .find(|n| n.starts_with("e.mwf-bak-"))
            .unwrap();
        assert_eq!(mode(&base.join(bak)), 0o600);
    }
}
