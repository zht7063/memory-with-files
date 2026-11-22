//! Writes, which need the project write lock (ADRs 0013, 0016).

use std::fs::{self, File};
use std::io;
use std::path::PathBuf;

use mwf_domain::{Slug, Timestamp};

use crate::error::{StoreError, io_at};
use crate::fsx::{Kind, exists_as, read_file, sync_dir, with_line, write_atomic, write_file};
use crate::project::{INDEX_FILE, LOG_FILE, PAGES_DIR, Project, TRASH_DIR, check_pinned};

/// Proof of holding `.mwf/.lock`; every write goes through it. Dropping it releases the lock.
///
/// Every write takes `&mut self`, so writes through one guard are serialized by the borrow
/// checker just as writes of different guards and processes are by the lock:
///
/// ```no_run
/// # fn main() -> Result<(), mwf_store::StoreError> {
/// let project = mwf_store::Project::find(std::path::Path::new("."))?;
/// let mut guard = project.lock(mwf_store::LOCK_WAIT)?;
/// guard.append_log("2026-11-20T10:00:00Z new a \"A\"")?;
/// # Ok(())
/// # }
/// ```
///
/// A shared reference cannot write:
///
/// ```compile_fail,E0596
/// fn append(guard: &mwf_store::WriteGuard<'_>) -> Result<(), mwf_store::StoreError> {
///     guard.append_log("line")
/// }
/// ```
#[derive(Debug)]
pub struct WriteGuard<'p> {
    project: &'p Project,
    lock: File,
    lock_path: PathBuf,
}

impl<'p> WriteGuard<'p> {
    pub(crate) fn new(project: &'p Project, lock: File, lock_path: PathBuf) -> Self {
        WriteGuard {
            project,
            lock,
            lock_path,
        }
    }

    /// Checks before each write that `.mwf/.lock` is still the file this guard locked. If it
    /// was deleted or replaced (say, by a workspace cleanup), another process can lock the new
    /// file, so this guard no longer excludes anyone and must stop writing.
    fn check_lock(&self) -> Result<(), StoreError> {
        check_pinned(&self.lock, &self.lock_path, false)
    }

    /// The locked project, for reads inside the lock.
    pub fn project(&self) -> &'p Project {
        self.project
    }

    /// Creates or replaces `pages/<slug>.md` atomically; creates `pages/` when missing.
    pub fn write_page(&mut self, slug: &Slug, bytes: &[u8]) -> Result<(), StoreError> {
        self.check_lock()?;
        self.ensure_dir(PAGES_DIR)?;
        write_file(&self.project.page_path(slug)?, bytes)
    }

    /// Moves `pages/<slug>.md` to `trash/<slug>.<ts>.md` (ADR 0026) and returns the new path.
    /// When that name is taken (two deletes of one slug in the same second), appends `.1`,
    /// `.2`, … before `.md` instead of overwriting.
    pub fn move_to_trash(&mut self, slug: &Slug, ts: &Timestamp) -> Result<PathBuf, StoreError> {
        self.check_lock()?;
        let from = self.existing_page(slug)?;
        let trash = self.ensure_dir(TRASH_DIR)?;
        let mut to = trash.join(format!("{slug}.{ts}.md"));
        let mut n = 1;
        while fs::symlink_metadata(&to).is_ok() {
            to = trash.join(format!("{slug}.{ts}.{n}.md"));
            n += 1;
        }
        fs::rename(&from, &to).map_err(io_at(&from))?;
        sync_dir(&trash)?;
        sync_dir(&self.project.path(PAGES_DIR)?)?;
        Ok(to)
    }

    /// Renames `pages/<from>.md` to `pages/<to>.md` without changing its bytes; fails with
    /// `PageExists` rather than replace an existing `to`.
    pub fn rename_page(&mut self, from: &Slug, to: &Slug) -> Result<(), StoreError> {
        self.check_lock()?;
        let from_path = self.existing_page(from)?;
        let to_path = self.project.page_path(to)?;
        if fs::symlink_metadata(&to_path).is_ok() {
            return Err(StoreError::PageExists { slug: to.clone() });
        }
        fs::rename(&from_path, &to_path).map_err(io_at(&from_path))?;
        sync_dir(&self.project.path(PAGES_DIR)?)
    }

    /// Replaces `index.md` atomically.
    pub fn write_index(&mut self, text: &str) -> Result<(), StoreError> {
        self.check_lock()?;
        write_file(&self.project.path(INDEX_FILE)?, text.as_bytes())
    }

    /// Appends `line` (one rendered log line, without its newline; ADR 0029) to `log.md`. Like
    /// every mwf write it replaces the file atomically, so an unlocked reader never sees half a
    /// line; a missing final newline (as a union merge can leave) is added first, and a missing
    /// `log.md` is created.
    pub fn append_log(&mut self, line: &str) -> Result<(), StoreError> {
        self.check_lock()?;
        let path = self.project.path(LOG_FILE)?;
        let text = read_file(&path)?.unwrap_or_default();
        write_atomic(&path, &with_line(text, line))
    }

    /// `pages/<slug>.md` when it is a regular file in a real `pages/` directory.
    fn existing_page(&self, slug: &Slug) -> Result<PathBuf, StoreError> {
        let path = self.project.page_path(slug)?;
        if self.project.store_dir(PAGES_DIR)?.is_some() && exists_as(&path, Kind::File)? {
            Ok(path)
        } else {
            Err(StoreError::PageNotFound { slug: slug.clone() })
        }
    }

    /// `.mwf/<name>/`, created and synced into `.mwf/` when missing.
    fn ensure_dir(&self, name: &str) -> Result<PathBuf, StoreError> {
        if let Some(path) = self.project.store_dir(name)? {
            return Ok(path);
        }
        let path = self.project.path(name)?;
        match fs::create_dir(&path) {
            Ok(()) => sync_dir(&self.project.checked_mwf()?)?,
            // Created by something else since the check; it must still be a real directory.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                exists_as(&path, Kind::Dir)?;
            }
            Err(e) => return Err(io_at(&path)(e)),
        }
        Ok(path)
    }
}
