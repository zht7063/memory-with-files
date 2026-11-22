use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mwf_domain::Slug;
use thiserror::Error;

/// Errors of `.mwf/` file IO. `mwf-app` maps them to CLI error codes (docs/cli.md).
#[derive(Debug, Error)]
pub enum StoreError {
    /// `NOT_INITIALIZED`: no `.mwf/` directory in `start` or any parent.
    #[error("no .mwf/ directory in {} or any parent directory", start.display())]
    NotInitialized { start: PathBuf },
    /// `NOT_GIT_ROOT`: `path` has no `.git` directory or `.git` file. `git_root` is the
    /// enclosing repository root, when `path` is inside one.
    #[error("{} is not the root of a git repository{}", path.display(), git_root_hint(git_root.as_deref()))]
    NotGitRoot {
        path: PathBuf,
        git_root: Option<PathBuf>,
    },
    /// `ALREADY_INITIALIZED`: `init` found an existing `.mwf` and changed nothing (ADR 0048).
    #[error("{} already exists; init changes nothing in an existing project", path.display())]
    AlreadyInitialized { path: PathBuf },
    /// `LOCK_TIMEOUT`: another mwf process held the lock on `path` for the whole wait (ADR
    /// 0033): `.mwf/.lock` for writes, the repository root for `init`.
    #[error("another mwf process kept {} locked for {} ms; retry", path.display(), waited.as_millis())]
    LockTimeout { path: PathBuf, waited: Duration },
    /// `config.toml` is not valid TOML or has an unknown key or a bad value (ADR 0039).
    #[error("invalid {}: {message}", path.display())]
    Config { path: PathBuf, message: String },
    /// `NOT_FOUND`: the page file does not exist.
    #[error("page {slug} does not exist")]
    PageNotFound { slug: Slug },
    /// `ALREADY_EXISTS`: the target page file of a rename exists.
    #[error("page {slug} already exists")]
    PageExists { slug: Slug },
    /// A path mwf reads or writes is a symlink, a special file, or a file where a directory
    /// belongs (or the reverse). mwf never follows symlinks there (ADR 0048).
    #[error("{} is not a {expected}; mwf does not follow symlinks or use special files here", path.display())]
    WrongFileType {
        path: PathBuf,
        expected: &'static str,
    },
    /// `.mwf`, or the `.mwf/.lock` a guard holds, was removed or replaced after the project
    /// was opened or the lock taken; mwf stops rather than follow the new entry (ADR 0048).
    #[error("{} changed since mwf opened the project; run the command again", path.display())]
    Changed { path: PathBuf },
    /// Any other file system failure, with the path it happened on.
    #[error("{}: {source}", path.display())]
    Io { path: PathBuf, source: io::Error },
}

fn git_root_hint(git_root: Option<&Path>) -> String {
    match git_root {
        Some(root) => format!("; the repository root is {}", root.display()),
        None => String::new(),
    }
}

/// `map_err` adapter that attaches the path an IO error happened on.
pub(crate) fn io_at(path: &Path) -> impl FnOnce(io::Error) -> StoreError + '_ {
    move |source| StoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}
