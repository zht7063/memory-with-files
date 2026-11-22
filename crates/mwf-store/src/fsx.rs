//! File primitives: file-type checks, atomic replace (ADR 0013), and edits built on it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{StoreError, io_at};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
/// Temp names tried before giving up when they are taken, such as by stale files of a dead
/// process with the same pid.
const TEMP_ATTEMPTS: u32 = 100;

#[derive(Debug, Clone, Copy)]
pub(crate) enum Kind {
    File,
    Dir,
}

/// Whether `path` exists, without following symlinks. Any other kind of entry (a symlink, a
/// special file, a directory where a file belongs or the reverse) is `WrongFileType`: mwf only
/// reads and writes real files and directories, so a symlink committed to a repository cannot
/// point store IO outside the project (ADR 0048).
pub(crate) fn exists_as(path: &Path, kind: Kind) -> Result<bool, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            let ft = meta.file_type();
            let (ok, expected) = match kind {
                Kind::File => (ft.is_file(), "regular file"),
                Kind::Dir => (ft.is_dir(), "directory"),
            };
            if ok {
                Ok(true)
            } else {
                Err(StoreError::WrongFileType {
                    path: path.to_path_buf(),
                    expected,
                })
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io_at(path)(e)),
    }
}

/// Reads a regular file; a missing one is `None`, any other kind is `WrongFileType`.
pub(crate) fn read_file(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    if !exists_as(path, Kind::File)? {
        return Ok(None);
    }
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_at(path)(e)),
    }
}

/// [`write_atomic`] to a path that is missing or a regular file; refuses to replace anything else.
pub(crate) fn write_file(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    exists_as(path, Kind::File)?;
    write_atomic(path, bytes)
}

/// Replaces `path` with `bytes` so that readers see either the old or the new file, never a
/// partial one: write a temp file in the same directory, fsync it, rename it over `path`, then
/// fsync the directory so the rename survives a crash. An existing file's permissions carry over.
///
/// Temp files are named `.<file name>.<pid>.<n>.tmp`, which `.mwf/.gitignore` ignores and page
/// listing skips. A failure before the rename removes the temp file this call created and leaves
/// `path` unchanged. A failure of the final directory fsync is returned too, but the new content
/// is then already visible; only its durability across a crash is uncertain.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let (dir, name) = match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => (dir, name.to_string_lossy()),
        _ => {
            return Err(StoreError::Io {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::InvalidInput, "not a file path"),
            });
        }
    };
    let (tmp, file) = create_unique(dir, &name, |p| {
        OpenOptions::new().write(true).create_new(true).open(p)
    })?;
    if let Err(e) = fill_and_rename(file, &tmp, path, bytes) {
        // The rename has not happened, so `tmp` is still the file this call created.
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(dir)
}

fn fill_and_rename(
    mut file: File,
    tmp: &Path,
    path: &Path,
    bytes: &[u8],
) -> Result<(), StoreError> {
    if let Ok(meta) = fs::metadata(path) {
        file.set_permissions(meta.permissions())
            .map_err(io_at(tmp))?;
    }
    file.write_all(bytes).map_err(io_at(tmp))?;
    file.sync_all().map_err(io_at(tmp))?;
    drop(file);
    fs::rename(tmp, path).map_err(io_at(path))
}

/// Creates a new entry `<dir>/.<name>.<pid>.<n>.tmp` with `create`, which must fail with
/// `AlreadyExists` when the name is taken; taken names are skipped, never removed.
pub(crate) fn create_unique<T>(
    dir: &Path,
    name: &str,
    create: impl Fn(&Path) -> io::Result<T>,
) -> Result<(PathBuf, T), StoreError> {
    for _ in 0..TEMP_ATTEMPTS {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".{name}.{}.{n}.tmp", std::process::id()));
        match create(&tmp) {
            Ok(created) => return Ok((tmp, created)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io_at(&tmp)(e)),
        }
    }
    Err(StoreError::Io {
        path: dir.to_path_buf(),
        source: io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{TEMP_ATTEMPTS} temp file names for {name} are all taken"),
        ),
    })
}

/// Flushes a directory's entries (creations, renames) to disk.
pub(crate) fn sync_dir(dir: &Path) -> Result<(), StoreError> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(io_at(dir))
}

/// `text` followed by `line` and a newline; adds the newline `text` is missing first.
pub(crate) fn with_line(mut text: Vec<u8>, line: &str) -> Vec<u8> {
    if !text.is_empty() && !text.ends_with(b"\n") {
        text.push(b'\n');
    }
    text.extend_from_slice(line.as_bytes());
    text.push(b'\n');
    text
}

/// Appends the rule `line` to a `.gitignore` or `.gitattributes` file (created when missing)
/// unless its last rule, the last line that is neither blank nor a `#` comment, is exactly
/// `line`. A later rule in these files overrides an earlier one (a `!` negation, `-merge`), so
/// an equal rule anywhere else is not proof that it is in effect (ADR 0048).
pub(crate) fn ensure_last_rule(path: &Path, line: &str) -> Result<(), StoreError> {
    let text = read_file(path)?.unwrap_or_default();
    let last_rule = String::from_utf8_lossy(&text)
        .lines()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .last()
        .map(str::to_owned);
    if last_rule.as_deref() == Some(line) {
        return Ok(());
    }
    write_atomic(path, &with_line(text, line))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creates_and_replaces_without_leaving_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        write_atomic(&path, b"one").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one");
        write_atomic(&path, b"two, longer").unwrap();
        write_atomic(&path, b"3").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"3");
        assert_eq!(entries(dir.path()), ["a.md"]);
    }

    #[test]
    fn replaces_by_rename_not_in_place() {
        // A reader holding the old file keeps reading the old content: the path now points at a
        // new inode, which is what makes concurrent unlocked reads see whole files (ADR 0033).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        write_atomic(&path, b"old content").unwrap();
        let mut held = File::open(&path).unwrap();
        write_atomic(&path, b"new").unwrap();
        let mut seen = String::new();
        io::Read::read_to_string(&mut held, &mut seen).unwrap();
        assert_eq!(seen, "old content");
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn failed_rename_keeps_target_and_removes_temp() {
        let dir = tempfile::tempdir().unwrap();
        // A non-empty directory at the target makes the rename fail after the temp file exists.
        let target = dir.path().join("a.md");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), b"x").unwrap();
        let err = write_atomic(&target, b"data").unwrap_err();
        assert!(matches!(err, StoreError::Io { .. }), "{err}");
        assert_eq!(entries(dir.path()), ["a.md"]);
        assert_eq!(entries(&target), ["keep"]);
    }

    #[test]
    fn taken_temp_names_are_skipped_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        // Occupy the next temp names, as stale files of a dead process with this pid would.
        let next = TEMP_COUNTER.load(Ordering::Relaxed);
        let pid = std::process::id();
        let decoys: Vec<PathBuf> = (next..next + 50)
            .map(|n| dir.path().join(format!(".a.md.{pid}.{n}.tmp")))
            .collect();
        for decoy in &decoys {
            fs::write(decoy, b"not mine").unwrap();
        }
        write_atomic(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        for decoy in &decoys {
            assert_eq!(fs::read(decoy).unwrap(), b"not mine", "{}", decoy.display());
        }
        assert_eq!(entries(dir.path()).len(), decoys.len() + 1);
    }

    #[test]
    fn missing_directory_is_an_io_error_naming_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("no/such/a.md");
        let err = write_atomic(&path, b"x").unwrap_err();
        assert!(err.to_string().contains("no/such"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions_of_the_replaced_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hook.sh");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o751)).unwrap();
        write_atomic(&path, b"new").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o751);
    }

    #[test]
    fn concurrent_writers_never_produce_a_mixed_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.md");
        let a = vec![b'a'; 64 * 1024];
        let b = vec![b'b'; 96 * 1024];
        std::thread::scope(|s| {
            for bytes in [&a, &b] {
                let path = &path;
                s.spawn(move || {
                    for _ in 0..20 {
                        write_atomic(path, bytes).unwrap();
                    }
                });
            }
            s.spawn(|| {
                for _ in 0..200 {
                    if let Ok(seen) = fs::read(&path) {
                        assert!(seen == a || seen == b, "torn read of {} bytes", seen.len());
                    }
                }
            });
        });
        assert_eq!(entries(dir.path()), ["a.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_wrong_file_types_and_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.md");
        fs::write(&outside, b"outside").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let is_wrong =
            |r: Result<(), StoreError>| matches!(r, Err(StoreError::WrongFileType { .. }));
        assert!(is_wrong(exists_as(&link, Kind::File).map(drop)));
        assert!(is_wrong(read_file(&link).map(drop)));
        assert!(is_wrong(write_file(&link, b"new")));
        assert!(is_wrong(ensure_last_rule(&link, "x")));
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(is_wrong(exists_as(dir.path(), Kind::File).map(drop)));
        assert!(is_wrong(exists_as(&outside, Kind::Dir).map(drop)));
        assert!(!exists_as(&dir.path().join("none"), Kind::Dir).unwrap());
    }

    #[test]
    fn with_line_adds_a_missing_newline_first() {
        assert_eq!(with_line(Vec::new(), "x"), b"x\n");
        assert_eq!(with_line(b"a\n".to_vec(), "x"), b"a\nx\n");
        assert_eq!(with_line(b"a".to_vec(), "x"), b"a\nx\n");
    }

    #[test]
    fn ensure_last_rule_skips_only_when_the_last_rule_is_the_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".gitignore");
        let after = |before: &str| {
            fs::write(&path, before).unwrap();
            ensure_last_rule(&path, "/.mwf/").unwrap();
            fs::read_to_string(&path).unwrap()
        };
        // Already the last rule, ignoring trailing blank lines, comments and CRLF.
        for kept in [
            "/.mwf/\n",
            "a\n/.mwf/",
            "/.mwf/\n\n# end\n  \n",
            "a\r\n/.mwf/\r\n",
        ] {
            assert_eq!(after(kept), kept);
        }
        // An equal rule followed by another rule, or a near miss, is not trusted.
        assert_eq!(after("/.mwf/\n!/.mwf/\n"), "/.mwf/\n!/.mwf/\n/.mwf/\n");
        assert_eq!(after("  .mwf  \n"), "  .mwf  \n/.mwf/\n");
        assert_eq!(after(".mwf"), ".mwf\n/.mwf/\n");
        assert_eq!(after("# /.mwf/"), "# /.mwf/\n/.mwf/\n");
        assert_eq!(after(""), "/.mwf/\n");

        fs::remove_file(&path).unwrap();
        ensure_last_rule(&path, "/.mwf/").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "/.mwf/\n");
    }
}
