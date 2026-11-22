//! All file IO under `.mwf/`: layout, project lookup, atomic writes, write lock, config, log, trash, session state.
//!
//! See [docs/crates/mwf-store.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/mwf-store.md).

mod config;
mod error;
mod fsx;
mod guard;
mod project;

pub use config::{Config, DEFAULT_CONFIG_TOML, HooksConfig};
pub use error::StoreError;
pub use guard::WriteGuard;
pub use project::{GitMode, LOCK_WAIT, MWF_GITIGNORE, Project};
