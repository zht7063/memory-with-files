//! Use-case layer: every operation, the DTOs adapters see, and error codes.
//!
//! See [docs/crates/mwf-app.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/mwf-app.md).

mod clock;
mod corpus;
mod dto;
mod error;
mod lint;
mod read;
mod redact;
mod write;

use std::path::Path;

use mwf_domain::{Page, Slug, Timestamp, parse_page};
use mwf_store::{GitMode, Project};

pub use clock::{Clock, FixedClock, SystemClock};
pub use corpus::{RELATED_LIMIT, RELATED_MIN_TERMS};
pub use dto::*;
pub use error::{AppError, ErrorCode};
pub use lint::DUPLICATE_SIMILARITY;
pub use write::BODY_MAX_BYTES;

/// An open project and the clock its writes and lint use.
pub struct App {
    project: Project,
    clock: Box<dyn Clock>,
}

impl App {
    /// Finds the project from `cwd` upward (ADR 0019), with the system clock.
    pub fn open(cwd: &Path) -> Result<App, AppError> {
        App::open_with_clock(cwd, Box::new(SystemClock))
    }

    /// Like [`App::open`] with a given clock (ADR 0043).
    pub fn open_with_clock(cwd: &Path, clock: Box<dyn Clock>) -> Result<App, AppError> {
        Ok(App {
            project: Project::find(cwd)?,
            clock,
        })
    }

    /// Creates `.mwf/` in `cwd`, which must be a git repository root (ADR 0048).
    pub fn init(cwd: &Path, local: bool) -> Result<InitOut, AppError> {
        let mode = if local {
            GitMode::Local
        } else {
            GitMode::Track
        };
        let project = Project::init(cwd, mode)?;
        Ok(InitOut {
            root: project.root().display().to_string(),
            mode: if local { "local" } else { "git" },
            next_steps: if local {
                mwf_assets::INIT_NEXT_STEPS_LOCAL
            } else {
                mwf_assets::INIT_NEXT_STEPS_GIT
            },
        })
    }

    /// The directory that holds `.mwf/`.
    pub fn root(&self) -> &Path {
        self.project.root()
    }

    fn now(&self) -> Result<Timestamp, AppError> {
        Ok(Timestamp::from_unix_secs(self.clock.now_unix_secs())?)
    }
}

/// Parses a stored page file; failures are `INVALID_PAGE`, never `INVALID_FIELD`.
fn parse_stored(slug: &Slug, bytes: &[u8]) -> Result<Page, AppError> {
    let text = std::str::from_utf8(bytes).map_err(|_| AppError::invalid_page(slug, "not UTF-8"))?;
    parse_page(slug.clone(), text).map_err(|e| AppError::invalid_page(slug, &e.to_string()))
}
