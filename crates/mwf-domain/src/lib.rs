//! Page model and all pure-computation rules. No IO, clock or environment access.
//!
//! See [docs/crates/mwf-domain.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/mwf-domain.md).

mod error;
mod frontmatter;
mod links;
mod model;
mod patch;
mod render;
mod secrets;
mod validate;

pub use error::DomainError;
pub use frontmatter::{parse_page, render_page};
pub use links::{Link, internal_links, rewrite_links, unlink};
pub use model::{Frontmatter, Page, PageType, Rev, SUMMARY_MAX_CHARS, Slug, Status, Timestamp};
pub use patch::apply_patch;
pub use render::{LogOp, render_index, render_log_line};
pub use secrets::{SecretFinding, scan_added, scan_all};
pub use validate::{Issue, STALE_TASK_DAYS, Severity, validate};
