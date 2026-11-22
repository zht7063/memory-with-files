//! Writes, which need the project write lock (ADRs 0013, 0016).

use std::fs::{self, File};
use std::io;
use std::path::PathBuf;

use mwf_domain::{Slug, Timestamp};

use crate::error::{StoreError, io_at};
use crate::fsx::{read_optional, sync_dir, with_line, write_atomic};
use crate::project::{INDEX_FILE, LOG_FILE, PAGES_DIR, Project, TRASH_DIR};

/// Proof of holding `.mwf/.lock`; every write goes through it. Dropping it releases the lock.
#[derive(Debug)]
pub struct WriteGuard<'p> {
    project: &'p Project,
    _lock: File,
}

impl<'p> WriteGuard<'p> {
    pub(crate) fn new(project: &'p Project, lock: File) -> Self {
        WriteGuard {
            project,
            _lock: lock,
        }
    }

    /// The locked project, for reads inside the lock.
    pub fn project(&self) -> &'p Project {
        self.project
    }

    /// Creates or replaces `pages/<slug>.md` atomically; creates `pages/` when missing.
    pub fn write_page(&self, slug: &Slug, bytes: &[u8]) -> Result<(), StoreError> {
        let dir = self.project.path(PAGES_DIR);
        fs::create_dir_all(&dir).map_err(io_at(&dir))?;
        write_atomic(&self.project.page_path(slug), bytes)
    }

    /// Moves `pages/<slug>.md` to `trash/<slug>.<ts>.md` (ADR 0026) and returns the new path.
    /// When that name is taken (two deletes of one slug in the same second), appends `.1`,
    /// `.2`, … before `.md` instead of overwriting.
    pub fn move_to_trash(&self, slug: &Slug, ts: &Timestamp) -> Result<PathBuf, StoreError> {
        let from = self.existing_page(slug)?;
        let trash = self.project.path(TRASH_DIR);
        fs::create_dir_all(&trash).map_err(io_at(&trash))?;
        let mut to = trash.join(format!("{slug}.{ts}.md"));
        let mut n = 1;
        while fs::symlink_metadata(&to).is_ok() {
            to = trash.join(format!("{slug}.{ts}.{n}.md"));
            n += 1;
        }
        fs::rename(&from, &to).map_err(io_at(&from))?;
        sync_dir(&trash)?;
        sync_dir(&self.project.path(PAGES_DIR))?;
        Ok(to)
    }

    /// Renames `pages/<from>.md` to `pages/<to>.md` without changing its bytes; fails with
    /// `PageExists` rather than replace an existing `to`.
    pub fn rename_page(&self, from: &Slug, to: &Slug) -> Result<(), StoreError> {
        let from_path = self.existing_page(from)?;
        let to_path = self.project.page_path(to);
        if fs::symlink_metadata(&to_path).is_ok() {
            return Err(StoreError::PageExists { slug: to.clone() });
        }
        fs::rename(&from_path, &to_path).map_err(io_at(&from_path))?;
        sync_dir(&self.project.path(PAGES_DIR))
    }

    /// Replaces `index.md` atomically.
    pub fn write_index(&self, text: &str) -> Result<(), StoreError> {
        write_atomic(&self.project.path(INDEX_FILE), text.as_bytes())
    }

    /// Appends `line` (one rendered log line, without its newline; ADR 0029) to `log.md`. Like
    /// every mwf write it replaces the file atomically, so an unlocked reader never sees half a
    /// line; a missing final newline (as a union merge can leave) is added first, and a missing
    /// `log.md` is created.
    pub fn append_log(&self, line: &str) -> Result<(), StoreError> {
        let path = self.project.path(LOG_FILE);
        let text = read_optional(&path)?.unwrap_or_default();
        write_atomic(&path, &with_line(text, line))
    }

    fn existing_page(&self, slug: &Slug) -> Result<PathBuf, StoreError> {
        let path = self.project.page_path(slug);
        match fs::symlink_metadata(&path) {
            Ok(_) => Ok(path),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Err(StoreError::PageNotFound { slug: slug.clone() })
            }
            Err(e) => Err(io_at(&path)(e)),
        }
    }
}
