//! File operations under a base directory that never go through a symbolic link (ADRs 0037,
//! 0052). The base itself (`$HOME`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`) may be a link, as in
//! dotfile setups; every path component below it must be a real directory or file.
//!
//! Writes are atomic (temporary file, fsync, rename) and check, just before the rename, that the
//! file still holds what was read; an existing file is copied to a backup first when asked.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::Error;

fn wrong_type(path: &Path, what: &str) -> Error {
    Error::new(
        "WRONG_FILE_TYPE",
        format!("{} {what}; nothing was changed", path.display()),
    )
}

/// `meta` of `path` is a real directory (`file == false`) or regular file (`file == true`).
fn check_type(path: &Path, meta: &fs::Metadata, file: bool) -> Result<(), Error> {
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

/// The contents of `base/rel`, `None` when it (or a directory on the way) does not exist.
pub(crate) fn read(base: &Path, rel: &Path) -> Result<Option<Vec<u8>>, Error> {
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
    fs::read(&cur).map(Some).map_err(|e| Error::io(&cur, &e))
}

/// Creates the missing directories of `base/rel`, one at a time, refusing links on the way.
fn ensure_dirs(base: &Path, rel: &Path) -> Result<(), Error> {
    let mut cur = base.to_path_buf();
    for c in rel.components() {
        cur.push(c);
        let meta = match fs::symlink_metadata(&cur) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&cur) {
                    Ok(()) => sync_dir(cur.parent()),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(Error::io(&cur, &e)),
                }
                fs::symlink_metadata(&cur).map_err(|e| Error::io(&cur, &e))?
            }
            Err(e) => return Err(Error::io(&cur, &e)),
        };
        check_type(&cur, &meta, false)?;
    }
    Ok(())
}

fn sync_dir(dir: Option<&Path>) {
    if let Some(dir) = dir
        && let Ok(f) = File::open(dir)
    {
        let _ = f.sync_all();
    }
}

/// `base/rel` still holds `old` (`None`: still does not exist).
fn verify(base: &Path, rel: &Path, old: Option<&[u8]>) -> Result<(), Error> {
    if read(base, rel)?.as_deref() == old {
        Ok(())
    } else {
        Err(Error::new(
            "CHANGED",
            format!(
                "{} changed while mwf was working (a running agent may have rewritten it); run the command again",
                base.join(rel).display()
            ),
        ))
    }
}

/// A new file next to `path` named `<name><infix><n>`, created exclusively.
fn create_beside(
    path: &Path,
    prefix: &str,
    infix: &str,
    private: bool,
) -> Result<(PathBuf, File), Error> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    for n in 0..1000 {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = path.with_file_name(format!("{prefix}{name}{infix}{suffix}"));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        match opts.open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(Error::io(&candidate, &e)),
        }
    }
    Err(Error::new(
        "IO",
        format!("cannot find a free file name next to {}", path.display()),
    ))
}

/// Copies `old` to `<file>.mwf-bak-<unix seconds>[-n]` (mode 0600) next to `path`.
fn backup(path: &Path, old: &[u8]) -> Result<PathBuf, Error> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let (bak, mut f) = create_beside(path, "", &format!(".mwf-bak-{secs}"), true)?;
    f.write_all(old)
        .and_then(|()| f.sync_all())
        .map_err(|e| Error::io(&bak, &e))?;
    sync_dir(path.parent());
    Ok(bak)
}

/// Writes `new` to `base/rel` if it still holds `old`; returns the backup made, if any.
pub(crate) fn write(
    base: &Path,
    rel: &Path,
    old: Option<&[u8]>,
    new: &[u8],
    keep_backup: bool,
) -> Result<Option<PathBuf>, Error> {
    if let Some(dir) = rel.parent() {
        ensure_dirs(base, dir)?;
    }
    let path = base.join(rel);
    verify(base, rel, old)?;
    let bak = match old {
        Some(old) if keep_backup => Some(backup(&path, old)?),
        _ => None,
    };
    let (tmp, mut f) = create_beside(
        &path,
        ".",
        &format!(".mwf-tmp-{}", std::process::id()),
        false,
    )?;
    let result = (|| {
        f.write_all(new)
            .and_then(|()| {
                if old.is_some() {
                    let perms = fs::metadata(&path)?.permissions();
                    fs::set_permissions(&tmp, perms)?;
                }
                f.sync_all()
            })
            .map_err(|e| Error::io(&tmp, &e))?;
        verify(base, rel, old)?;
        if old.is_some() {
            fs::rename(&tmp, &path).map_err(|e| Error::io(&path, &e))
        } else {
            // A link never replaces a file that appeared in the meantime.
            match fs::hard_link(&tmp, &path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => verify(base, rel, old),
                Err(e) => Err(Error::io(&path, &e)),
            }
        }
    })();
    let _ = fs::remove_file(&tmp);
    result?;
    sync_dir(path.parent());
    Ok(bak)
}

/// Removes `base/rel` if it still holds `old`; returns the backup made, if any.
pub(crate) fn remove(
    base: &Path,
    rel: &Path,
    old: &[u8],
    keep_backup: bool,
) -> Result<Option<PathBuf>, Error> {
    let path = base.join(rel);
    verify(base, rel, Some(old))?;
    let bak = if keep_backup {
        Some(backup(&path, old)?)
    } else {
        None
    };
    fs::remove_file(&path).map_err(|e| Error::io(&path, &e))?;
    sync_dir(path.parent());
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
}
