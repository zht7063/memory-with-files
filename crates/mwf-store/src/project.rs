//! Project lookup and `init` (ADRs 0019, 0029, 0048), unlocked reads (ADR 0033), the write lock
//! (ADRs 0013, 0033).

use std::fs::{self, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mwf_domain::{Slug, render_index};

use crate::config::{Config, DEFAULT_CONFIG_TOML};
use crate::error::{StoreError, io_at};
use crate::fsx::{ensure_line, read_optional, write_atomic};
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

/// A project: the directory that holds `.mwf/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    root: PathBuf,
}

impl Project {
    /// Finds the nearest of `cwd` and its ancestors that holds a `.mwf/` directory (ADR 0019).
    /// The returned root is canonical (symlinks resolved).
    pub fn find(cwd: &Path) -> Result<Project, StoreError> {
        let start = fs::canonicalize(cwd).map_err(io_at(cwd))?;
        start
            .ancestors()
            .find(|dir| dir.join(MWF_DIR).is_dir())
            .map(|root| Project {
                root: root.to_path_buf(),
            })
            .ok_or(StoreError::NotInitialized { start })
    }

    /// Creates `.mwf/` in `root`, which must be a git repository root: it holds a `.git`
    /// directory, or a `.git` file starting with `gitdir:` (worktree or submodule). No `git`
    /// binary is needed.
    ///
    /// Writes `.mwf/.gitignore`, `config.toml` with the defaults, `index.md` with no pages, an
    /// empty `log.md` and `pages/`; then in [`GitMode::Track`] adds `.mwf/log.md merge=union` to
    /// the root `.gitattributes` (ADR 0029), in [`GitMode::Local`] adds `/.mwf/` to the root
    /// `.gitignore`. A line already present is not added again. When `.mwf` already exists,
    /// returns `AlreadyInitialized` and changes nothing (ADR 0048).
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
        let project = Project { root };
        let mwf = project.mwf_dir();
        // create_dir, not create_dir_all: it fails when `.mwf` exists, even from a racing init.
        match fs::create_dir(&mwf) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                return Err(StoreError::AlreadyInitialized { path: mwf });
            }
            Err(e) => return Err(io_at(&mwf)(e)),
        }
        write_atomic(&mwf.join(".gitignore"), MWF_GITIGNORE.as_bytes())?;
        write_atomic(&mwf.join(CONFIG_FILE), DEFAULT_CONFIG_TOML.as_bytes())?;
        write_atomic(&mwf.join(INDEX_FILE), render_index(&[]).as_bytes())?;
        write_atomic(&mwf.join(LOG_FILE), b"")?;
        let pages = mwf.join(PAGES_DIR);
        fs::create_dir(&pages).map_err(io_at(&pages))?;
        match mode {
            GitMode::Track => ensure_line(
                &project.root.join(".gitattributes"),
                GITATTRIBUTES_LINE,
                &[GITATTRIBUTES_LINE, "/.mwf/log.md merge=union"],
            )?,
            GitMode::Local => ensure_line(
                &project.root.join(".gitignore"),
                GITIGNORE_LINE,
                &[GITIGNORE_LINE, ".mwf/", ".mwf", "/.mwf"],
            )?,
        }
        Ok(project)
    }

    /// The directory that holds `.mwf/`.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<root>/.mwf`.
    pub fn mwf_dir(&self) -> PathBuf {
        self.root.join(MWF_DIR)
    }

    pub(crate) fn path(&self, name: &str) -> PathBuf {
        self.mwf_dir().join(name)
    }

    pub(crate) fn page_path(&self, slug: &Slug) -> PathBuf {
        self.path(PAGES_DIR).join(format!("{slug}.md"))
    }

    /// Reads `config.toml`; a missing file means all defaults (ADR 0039).
    pub fn config(&self) -> Result<Config, StoreError> {
        let path = self.path(CONFIG_FILE);
        match read_optional(&path)? {
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

    /// The page file's bytes, or `None` when it does not exist.
    pub fn read_page(&self, slug: &Slug) -> Result<Option<Vec<u8>>, StoreError> {
        read_optional(&self.page_path(slug))
    }

    /// Every `pages/*.md` file as (file name without `.md`, bytes), sorted by name. Names are not
    /// checked as slugs, so lint can report invalid ones; other files, directories and temp
    /// files are skipped. A missing `pages/` (git keeps no empty directories) means no pages.
    /// Takes no lock: atomic writes make every file read whole (ADR 0033).
    pub fn read_all_pages(&self) -> Result<Vec<(String, Vec<u8>)>, StoreError> {
        let dir = self.path(PAGES_DIR);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_at(&dir)(e)),
        };
        let mut pages = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_at(&dir))?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".md") else {
                continue;
            };
            if !entry.file_type().map_err(io_at(&path))?.is_file() {
                continue;
            }
            // A page deleted between listing and reading is simply not there.
            if let Some(bytes) = read_optional(&path)? {
                pages.push((stem.to_owned(), bytes));
            }
        }
        pages.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(pages)
    }

    /// `index.md`, or `None` when it does not exist.
    pub fn read_index(&self) -> Result<Option<Vec<u8>>, StoreError> {
        read_optional(&self.path(INDEX_FILE))
    }

    /// The last `n` non-empty lines of `log.md`, oldest first; a missing file has none.
    pub fn read_log(&self, n: usize) -> Result<Vec<String>, StoreError> {
        let bytes = read_optional(&self.path(LOG_FILE))?.unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
        let skip = lines.len().saturating_sub(n);
        Ok(lines[skip..].iter().map(|l| (*l).to_owned()).collect())
    }

    /// Takes the project write lock, an exclusive `File::lock` on `.mwf/.lock` (ADR 0013),
    /// waiting up to `timeout` ([`LOCK_WAIT`] for write commands) before `LockTimeout`. The
    /// lock is released when the guard drops or the process exits.
    pub fn lock(&self, timeout: Duration) -> Result<WriteGuard<'_>, StoreError> {
        let path = self.path(LOCK_FILE);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(io_at(&path))?;
        let start = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(WriteGuard::new(self, file)),
                Err(TryLockError::WouldBlock) => {
                    let waited = start.elapsed();
                    if waited >= timeout {
                        return Err(StoreError::LockTimeout { waited: timeout });
                    }
                    std::thread::sleep(LOCK_POLL.min(timeout - waited));
                }
                Err(TryLockError::Error(e)) => return Err(io_at(&path)(e)),
            }
        }
    }
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
