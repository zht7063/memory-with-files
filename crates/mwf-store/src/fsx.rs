//! File primitives: atomic replace (ADR 0013) and line-appending edits built on it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{StoreError, io_at};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Replaces `path` with `bytes` so that readers see either the old or the new file, never a
/// partial one: write a temp file in the same directory, fsync it, rename it over `path`, then
/// fsync the directory so the rename survives a crash. An existing file's permissions carry over.
///
/// Temp files are named `.<file name>.<pid>.<n>.tmp`, which `.mwf/.gitignore` ignores and page
/// listing skips. On failure the temp file is removed and `path` is unchanged.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let (dir, name) = match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => (dir, name),
        _ => {
            return Err(StoreError::Io {
                path: path.to_path_buf(),
                source: io::Error::new(io::ErrorKind::InvalidInput, "not a file path"),
            });
        }
    };
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".{}.{}.{n}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    let result = write_and_rename(&tmp, path, bytes);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    sync_dir(dir)
}

fn write_and_rename(tmp: &Path, path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
        .map_err(io_at(tmp))?;
    if let Ok(meta) = fs::metadata(path) {
        file.set_permissions(meta.permissions())
            .map_err(io_at(tmp))?;
    }
    file.write_all(bytes).map_err(io_at(tmp))?;
    file.sync_all().map_err(io_at(tmp))?;
    drop(file);
    fs::rename(tmp, path).map_err(io_at(path))
}

/// Flushes a directory's entries (creations, renames) to disk.
pub(crate) fn sync_dir(dir: &Path) -> Result<(), StoreError> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(io_at(dir))
}

/// Reads a file, treating a missing one as `None`.
pub(crate) fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_at(path)(e)),
    }
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

/// Appends `line` to the text file at `path` (created when missing) unless a line equal to one
/// of `present`, ignoring surrounding and repeated whitespace, is already there.
pub(crate) fn ensure_line(path: &Path, line: &str, present: &[&str]) -> Result<(), StoreError> {
    let text = read_optional(path)?.unwrap_or_default();
    let normalize = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let found = String::from_utf8_lossy(&text)
        .lines()
        .any(|l| present.contains(&normalize(l).as_str()));
    if found {
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

    #[test]
    fn with_line_adds_a_missing_newline_first() {
        assert_eq!(with_line(Vec::new(), "x"), b"x\n");
        assert_eq!(with_line(b"a\n".to_vec(), "x"), b"a\nx\n");
        assert_eq!(with_line(b"a".to_vec(), "x"), b"a\nx\n");
    }

    #[test]
    fn ensure_line_appends_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".gitignore");
        ensure_line(&path, "/.mwf/", &["/.mwf/", ".mwf"]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "/.mwf/\n");
        ensure_line(&path, "/.mwf/", &["/.mwf/", ".mwf"]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "/.mwf/\n");

        fs::write(&path, "target\n  .mwf  \nnode_modules").unwrap();
        ensure_line(&path, "/.mwf/", &["/.mwf/", ".mwf"]).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "target\n  .mwf  \nnode_modules"
        );

        fs::write(&path, "target\n# .mwf/\nnode_modules").unwrap();
        ensure_line(&path, "/.mwf/", &["/.mwf/", ".mwf"]).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "target\n# .mwf/\nnode_modules\n/.mwf/\n"
        );
    }
}
