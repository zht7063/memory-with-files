//! Session state: `.mwf/.state/<session_id>.json`, one file per host session (ADRs 0034, 0051).
//!
//! Hooks of different sessions never share a file, so no lock is taken; each file is replaced
//! atomically like every other mwf file. The state only avoids repeating an injection, so a
//! missing, unreadable or unknown-version file reads as an empty state instead of failing.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{StoreError, io_at};
use crate::fsx::{Kind, exists_as, read_file, write_file};
use crate::project::Project;

const STATE_DIR: &str = ".state";
/// `version` of the state files this build writes; any other version reads as empty.
const STATE_VERSION: u32 = 1;
/// Longest session id kept, in bytes (all kept characters are ASCII).
pub const SESSION_ID_MAX: usize = 128;
/// State files whose modification time is at least this old are removed (ADR 0034).
pub const SESSION_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// What one session has already been shown.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionState {
    /// Slugs UserPromptSubmit already injected in this session, oldest first.
    pub recalled: Vec<String>,
    /// The host turn (Claude `prompt_id`, Codex `turn_id`) the Stop reminder was last given for.
    pub reminded_turn: Option<String>,
}

/// The file format: `{"version":1,"recalled":[…],"reminded_turn":…}`. Unknown keys are ignored.
#[derive(Serialize, Deserialize)]
struct StateFile {
    version: u32,
    #[serde(default)]
    recalled: Vec<String>,
    #[serde(default)]
    reminded_turn: Option<String>,
}

/// The state file of one session. Obtained from [`Project::session`].
#[derive(Debug, Clone)]
pub struct SessionStore<'p> {
    project: &'p Project,
    id: String,
}

/// The file-name-safe form of a host session id: only ASCII letters, digits, `-` and `_` are
/// kept, at most [`SESSION_ID_MAX`] of them; `None` when nothing is left. Host ids are UUIDs,
/// which this leaves unchanged; the filter only stops a crafted id (`../x`, `/etc/passwd`)
/// from naming a path outside `.state/` (ADR 0034).
pub fn session_file_id(id: &str) -> Option<String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(SESSION_ID_MAX)
        .collect();
    (!safe.is_empty()).then_some(safe)
}

impl Project {
    /// The state of session `id`, or `None` when the id has no safe characters (missing or
    /// empty in the host's input): such a hook runs without per-session memory.
    pub fn session(&self, id: &str) -> Option<SessionStore<'_>> {
        Some(SessionStore {
            project: self,
            id: session_file_id(id)?,
        })
    }

    /// Removes the regular files in `.mwf/.state/` (state files and temp files left by an
    /// interrupted write) last modified at least [`SESSION_MAX_AGE`] before `now`, and returns
    /// how many it removed. Symlinks and directories there are left alone; a missing `.state/`
    /// has nothing to remove. A modification time after `now` is never old.
    pub fn prune_sessions(&self, now: SystemTime) -> Result<usize, StoreError> {
        let Some(dir) = self.store_dir(STATE_DIR)? else {
            return Ok(0);
        };
        let mut removed = 0;
        for entry in fs::read_dir(&dir).map_err(io_at(&dir))? {
            let entry = entry.map_err(io_at(&dir))?;
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_at(&path)(e)),
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().map_err(io_at(&path))?;
            let old = now
                .duration_since(modified)
                .is_ok_and(|age| age >= SESSION_MAX_AGE);
            if old {
                match fs::remove_file(&path) {
                    Ok(()) => removed += 1,
                    // Removed by a concurrent hook.
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(io_at(&path)(e)),
                }
            }
        }
        Ok(removed)
    }
}

impl SessionStore<'_> {
    /// The sanitized id, which names the file `<id>.json`.
    pub fn id(&self) -> &str {
        &self.id
    }

    fn file_name(&self) -> String {
        format!("{}.json", self.id)
    }

    /// The session's state. A missing file, invalid JSON or another `version` is an empty
    /// state. `.state/` or the file being a symlink or the wrong kind is `WrongFileType`, as
    /// everywhere under `.mwf/` (ADR 0048).
    pub fn load(&self) -> Result<SessionState, StoreError> {
        let Some(dir) = self.project.store_dir(STATE_DIR)? else {
            return Ok(SessionState::default());
        };
        let Some(bytes) = read_file(&dir.join(self.file_name()))? else {
            return Ok(SessionState::default());
        };
        Ok(match serde_json::from_slice::<StateFile>(&bytes) {
            Ok(file) if file.version == STATE_VERSION => SessionState {
                recalled: file.recalled,
                reminded_turn: file.reminded_turn,
            },
            _ => SessionState::default(),
        })
    }

    /// Replaces the session's file atomically, creating `.state/` when missing. Takes no lock:
    /// only hooks of this session write this file (ADR 0034).
    pub fn save(&self, state: &SessionState) -> Result<(), StoreError> {
        let dir = self.project.ensure_dir(STATE_DIR)?;
        let path = dir.join(self.file_name());
        let file = StateFile {
            version: STATE_VERSION,
            recalled: state.recalled.clone(),
            reminded_turn: state.reminded_turn.clone(),
        };
        let mut bytes = serde_json::to_vec(&file).map_err(|e| StoreError::Io {
            path: path.clone(),
            source: io::Error::new(io::ErrorKind::InvalidData, e),
        })?;
        bytes.push(b'\n');
        write_file(&path, &bytes)
    }

    /// Deletes the session's file; a missing one is fine.
    pub fn remove(&self) -> Result<(), StoreError> {
        let Some(dir) = self.project.store_dir(STATE_DIR)? else {
            return Ok(());
        };
        let path: PathBuf = dir.join(self.file_name());
        if !exists_as(&path, Kind::File)? {
            return Ok(());
        }
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_at(&path)(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_ids_keep_only_safe_characters() {
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(session_file_id(uuid).as_deref(), Some(uuid));
        assert_eq!(session_file_id("a_B-9").as_deref(), Some("a_B-9"));
        assert_eq!(
            session_file_id("../../etc/passwd").as_deref(),
            Some("etcpasswd")
        );
        assert_eq!(session_file_id("/abs/x.json").as_deref(), Some("absxjson"));
        assert_eq!(session_file_id("é\0会话").as_deref(), None);
        assert_eq!(session_file_id("").as_deref(), None);
        assert_eq!(session_file_id("..").as_deref(), None);
        let long = "a".repeat(SESSION_ID_MAX + 50);
        assert_eq!(session_file_id(&long).unwrap().len(), SESSION_ID_MAX);
    }
}
