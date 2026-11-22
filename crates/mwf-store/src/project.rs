//! Project lookup and `init` (ADRs 0019, 0029, 0048), unlocked reads (ADR 0033), the write lock
//! (ADRs 0013, 0033).

use std::fs::{self, File, Metadata, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mwf_domain::{Slug, render_index};

use crate::config::{Config, DEFAULT_CONFIG_TOML};
use crate::error::{StoreError, io_at};
use crate::fsx::{
    Kind, create_unique, ensure_last_rule, exists_as, read_file, sync_dir, write_atomic,
};
use crate::guard::WriteGuard;

pub(crate) const MWF_DIR: &str = ".mwf";
pub(crate) const PAGES_DIR: &str = "pages";
pub(crate) const TRASH_DIR: &str = "trash";
pub(crate) const INDEX_FILE: &str = "index.md";
pub(crate) const LOG_FILE: &str = "log.md";
const CONFIG_FILE: &str = "config.toml";
const LOCK_FILE: &str = ".lock";

/// How long write commands wait for `.mwf/.lock` before `LOCK_TIMEOUT` (ADR 0033).
pub const LOCK_WAIT: Duration = Duration::from_secs(2);
const LOCK_POLL: Duration = Duration::from_millis(10);

/// `.mwf/.gitignore`, written in both modes: machine-local files never enter git (ADRs 0019,
/// 0048). Patterns are relative to `.mwf/`; `.*.tmp` covers interrupted atomic writes.
pub const MWF_GITIGNORE: &str = "\
# Machine-local mwf files; never commit them.
/.lock
/.state/
/trash/
.*.tmp
";

const GITATTRIBUTES_LINE: &str = ".mwf/log.md merge=union";
const GITIGNORE_LINE: &str = "/.mwf/";

/// Whether `.mwf/` is committed (ADR 0019).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitMode {
    /// Commit `.mwf/` and merge `log.md` with `merge=union` (the default).
    Track,
    /// `mwf init --local`: list `.mwf/` in the root `.gitignore`.
    Local,
}

/// A project: the directory that holds `.mwf/`, and the identity of that `.mwf/` directory
/// when the project was opened. Every operation checks that `.mwf` is still that directory and
/// not a symlink, so a `.mwf` swapped after [`Project::find`] or [`Project::lock`] fails with
/// `Changed` instead of sending reads or writes elsewhere (ADR 0048).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    root: PathBuf,
    mwf_id: DirId,
}

/// (device, inode) of a directory; mwf targets only Unix (ADR 0012).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DirId(u64, u64);

#[cfg(unix)]
fn dir_id(meta: &Metadata) -> DirId {
    use std::os::unix::fs::MetadataExt;
    DirId(meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn dir_id(_meta: &Metadata) -> DirId {
    DirId(0, 0)
}

impl Project {
    /// Finds the nearest of `cwd` and its ancestors that holds a `.mwf/` directory (ADR 0019).
    /// The returned root is canonical (symlinks resolved). A `.mwf` that is a regular file is
    /// passed over; one that is a symlink is `WrongFileType` (ADR 0048).
    pub fn find(cwd: &Path) -> Result<Project, StoreError> {
        let start = fs::canonicalize(cwd).map_err(io_at(cwd))?;
        for dir in start.ancestors() {
            let mwf = dir.join(MWF_DIR);
            match fs::symlink_metadata(&mwf) {
                Ok(meta) if meta.is_dir() => {
                    return Ok(Project {
                        root: dir.to_path_buf(),
                        mwf_id: dir_id(&meta),
                    });
                }
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(StoreError::WrongFileType {
                        path: mwf,
                        expected: "directory",
                    });
                }
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) => {}
                Err(e) => return Err(io_at(&mwf)(e)),
            }
        }
        Err(StoreError::NotInitialized { start })
    }

    /// Creates `.mwf/` in `root`, which must be a git repository root: it holds a `.git`
    /// directory, or a `.git` file starting with `gitdir:` (worktree or submodule). No `git`
    /// binary is needed.
    ///
    /// Inits of one root are serialized by an exclusive lock on the root directory itself
    /// (waiting up to [`LOCK_WAIT`]), and only the init that finds no `.mwf` under that lock
    /// writes anything, so racing inits in different modes leave one mode's Git rule.
    ///
    /// Builds the project in a staging directory `.mwf.<pid>.<n>.tmp`, which [`Project::find`]
    /// does not see: `.gitignore`, `config.toml` with the defaults, `index.md`
    /// with no pages, an empty `log.md` and `pages/`. Then it makes the Git rule the last rule of
    /// the root `.gitattributes` ([`GitMode::Track`], `.mwf/log.md merge=union`, ADR 0029) or
    /// `.gitignore` ([`GitMode::Local`], `/.mwf/`), and finally renames the staging directory to
    /// `.mwf`. So `find` sees either no project or a complete one with its Git rule in place.
    /// A failure before that rename leaves no `.mwf` behind, so `init` can be retried; if
    /// fsyncing the root fails after the rename, the error is returned but the project is
    /// already published, and a retry returns `AlreadyInitialized`. When `.mwf` already
    /// exists in any form, returns `AlreadyInitialized` and changes nothing (ADR 0048).
    pub fn init(root: &Path, mode: GitMode) -> Result<Project, StoreError> {
        let root = fs::canonicalize(root).map_err(io_at(root))?;
        if !is_git_root(&root)? {
            let git_root = root
                .ancestors()
                .skip(1)
                .find(|dir| is_git_root(dir).unwrap_or(false))
                .map(Path::to_path_buf);
            return Err(StoreError::NotGitRoot {
                path: root,
                git_root,
            });
        }
        // Serialize inits of this root by locking the root directory itself, which creates no
        // file in the repository; the lock ends when `root_lock` drops. Only the init that sees
        // no `.mwf` under the lock writes Git policy, so racing Track and Local inits cannot
        // both leave their rules behind.
        let root_lock = File::open(&root).map_err(io_at(&root))?;
        lock_within(&root_lock, &root, LOCK_WAIT)?;
        let mwf = root.join(MWF_DIR);
        match fs::symlink_metadata(&mwf) {
            Ok(_) => return Err(StoreError::AlreadyInitialized { path: mwf }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_at(&mwf)(e)),
        }
        let (staging, ()) = create_unique(&root, "mwf", |p| fs::create_dir(p))?;
        let result = stage(&staging)
            .and_then(|()| match mode {
                GitMode::Track => {
                    ensure_last_rule(&root.join(".gitattributes"), GITATTRIBUTES_LINE)
                }
                GitMode::Local => ensure_last_rule(&root.join(".gitignore"), GITIGNORE_LINE),
            })
            .and_then(|()| publish(&staging, &mwf, &root));
        if result.is_err() {
            // After a successful rename the staging path no longer exists and this does nothing.
            let _ = fs::remove_dir_all(&staging);
        }
        result?;
        let meta = fs::symlink_metadata(&mwf).map_err(io_at(&mwf))?;
        Ok(Project {
            root,
            mwf_id: dir_id(&meta),
        })
    }

    /// The directory that holds `.mwf/`.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<root>/.mwf`.
    pub fn mwf_dir(&self) -> PathBuf {
        self.root.join(MWF_DIR)
    }

    /// `.mwf/` after checking it is still the directory this project was opened with.
    pub(crate) fn checked_mwf(&self) -> Result<PathBuf, StoreError> {
        let mwf = self.mwf_dir();
        match fs::symlink_metadata(&mwf) {
            Ok(meta) if meta.is_dir() && dir_id(&meta) == self.mwf_id => Ok(mwf),
            Ok(_) => Err(StoreError::Changed { path: mwf }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Err(StoreError::Changed { path: mwf }),
            Err(e) => Err(io_at(&mwf)(e)),
        }
    }

    /// `.mwf/<name>`, checking `.mwf` first; the caller checks `<name>` itself.
    pub(crate) fn path(&self, name: &str) -> Result<PathBuf, StoreError> {
        Ok(self.checked_mwf()?.join(name))
    }

    /// `.mwf/pages/<slug>.md`, checking `.mwf` and that `pages` is not a symlink or file.
    pub(crate) fn page_path(&self, slug: &Slug) -> Result<PathBuf, StoreError> {
        let pages = self.path(PAGES_DIR)?;
        exists_as(&pages, Kind::Dir)?;
        Ok(pages.join(format!("{slug}.md")))
    }

    /// `.mwf/<name>/` when it exists as a real directory; `WrongFileType` for a symlink or file.
    pub(crate) fn store_dir(&self, name: &str) -> Result<Option<PathBuf>, StoreError> {
        let path = self.path(name)?;
        Ok(exists_as(&path, Kind::Dir)?.then_some(path))
    }

    /// Reads `config.toml`; a missing file means all defaults (ADR 0039).
    pub fn config(&self) -> Result<Config, StoreError> {
        let path = self.path(CONFIG_FILE)?;
        match read_file(&path)? {
            None => Ok(Config::default()),
            Some(bytes) => match String::from_utf8(bytes) {
                Ok(text) => Config::parse(&text, &path),
                Err(_) => Err(StoreError::Config {
                    path,
                    message: "not UTF-8".to_owned(),
                }),
            },
        }
    }

    /// The page file's bytes, or `None` when it does not exist. A page path that is a symlink
    /// or not a regular file is `WrongFileType`.
    pub fn read_page(&self, slug: &Slug) -> Result<Option<Vec<u8>>, StoreError> {
        if self.store_dir(PAGES_DIR)?.is_none() {
            return Ok(None);
        }
        read_file(&self.page_path(slug)?)
    }

    /// Every `pages/*.md` entry as (file name without `.md`, bytes), sorted by name. Names are
    /// not checked as slugs, so lint can report invalid ones; entries not ending in `.md`
    /// (including temp files) are skipped, and an `.md` entry that is a symlink, directory or
    /// special file is `WrongFileType`, as in [`Project::read_page`]. A missing `pages/` (git
    /// keeps no empty directories) means no pages. Takes no lock: atomic writes make every file
    /// read whole (ADR 0033).
    pub fn read_all_pages(&self) -> Result<Vec<(String, Vec<u8>)>, StoreError> {
        let Some(dir) = self.store_dir(PAGES_DIR)? else {
            return Ok(Vec::new());
        };
        let mut pages = Vec::new();
        for entry in fs::read_dir(&dir).map_err(io_at(&dir))? {
            let entry = entry.map_err(io_at(&dir))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".md") else {
                continue;
            };
            // A page deleted between listing and reading is simply not there.
            if let Some(bytes) = read_file(&entry.path())? {
                pages.push((stem.to_owned(), bytes));
            }
        }
        pages.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(pages)
    }

    /// `index.md`, or `None` when it does not exist.
    pub fn read_index(&self) -> Result<Option<Vec<u8>>, StoreError> {
        read_file(&self.path(INDEX_FILE)?)
    }

    /// The last `n` non-empty lines of `log.md`, oldest first; a missing file has none.
    pub fn read_log(&self, n: usize) -> Result<Vec<String>, StoreError> {
        let bytes = read_file(&self.path(LOG_FILE)?)?.unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let skip = lines.len().saturating_sub(n);
        Ok(lines[skip..].iter().map(|l| (*l).to_owned()).collect())
    }

    /// Takes the project write lock, an exclusive `File::lock` on `.mwf/.lock` (ADR 0013),
    /// waiting up to `timeout` ([`LOCK_WAIT`] for write commands) before `LockTimeout`. The
    /// lock is released when the guard drops or the process exits.
    pub fn lock(&self, timeout: Duration) -> Result<WriteGuard<'_>, StoreError> {
        let path = self.path(LOCK_FILE)?;
        exists_as(&path, Kind::File)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(io_at(&path))?;
        lock_within(&file, &path, timeout)?;
        // While waiting, `.mwf` or `.lock` may have been replaced; a lock on a file that is no
        // longer `.mwf/.lock` would exclude nobody.
        self.checked_mwf()?;
        let current = fs::symlink_metadata(&path).map_err(io_at(&path))?;
        let held = file.metadata().map_err(io_at(&path))?;
        if !current.is_file() || dir_id(&current) != dir_id(&held) {
            return Err(StoreError::Changed { path });
        }
        Ok(WriteGuard::new(self, file))
    }
}

/// Takes an exclusive `File::lock` on `file`, polling every [`LOCK_POLL`] for up to `timeout`.
fn lock_within(file: &File, path: &Path, timeout: Duration) -> Result<(), StoreError> {
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(TryLockError::WouldBlock) => {
                let waited = start.elapsed();
                if waited >= timeout {
                    return Err(StoreError::LockTimeout { waited: timeout });
                }
                std::thread::sleep(LOCK_POLL.min(timeout - waited));
            }
            Err(TryLockError::Error(e)) => return Err(io_at(path)(e)),
        }
    }
}

/// Fills a fresh staging directory with the files of a new `.mwf/`, all synced to disk.
fn stage(staging: &Path) -> Result<(), StoreError> {
    write_atomic(&staging.join(".gitignore"), MWF_GITIGNORE.as_bytes())?;
    write_atomic(&staging.join(CONFIG_FILE), DEFAULT_CONFIG_TOML.as_bytes())?;
    write_atomic(&staging.join(INDEX_FILE), render_index(&[]).as_bytes())?;
    write_atomic(&staging.join(LOG_FILE), b"")?;
    let pages = staging.join(PAGES_DIR);
    fs::create_dir(&pages).map_err(io_at(&pages))?;
    sync_dir(staging)
}

/// Renames the staging directory to `.mwf`. rename(2) never replaces a file, a symlink or a
/// non-empty directory, so a project published meanwhile by another `init` or written to by
/// another process stays as it is; only an empty `.mwf/` created in the same instant can be
/// replaced, and it holds nothing.
fn publish(staging: &Path, mwf: &Path, root: &Path) -> Result<(), StoreError> {
    if let Err(e) = fs::rename(staging, mwf) {
        if fs::symlink_metadata(mwf).is_ok() {
            return Err(StoreError::AlreadyInitialized {
                path: mwf.to_path_buf(),
            });
        }
        return Err(io_at(mwf)(e));
    }
    sync_dir(root)
}

/// Whether `dir/.git` is a directory, or a file starting with `gitdir:` (linked worktree,
/// submodule).
fn is_git_root(dir: &Path) -> Result<bool, StoreError> {
    let dot_git = dir.join(".git");
    let meta = match fs::metadata(&dot_git) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(io_at(&dot_git)(e)),
    };
    if meta.is_dir() {
        return Ok(true);
    }
    if !meta.is_file() {
        return Ok(false);
    }
    let text = fs::read(&dot_git).map_err(io_at(&dot_git))?;
    Ok(text.starts_with(b"gitdir:"))
}
