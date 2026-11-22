//! What mwf writes into generated files (`index.md`, `log.md`) and diagnostics (errors, warnings,
//! lint) when stored or supplied text looks like a secret (ADRs 0025, 0049). Pages themselves are
//! never rewritten: a secret already in a page stays there for the user to remove, and the page
//! can still be renamed or deleted, but mwf does not copy it anywhere else.

use mwf_domain::{Slug, scan_all};

pub(crate) const WITHHELD_SLUG: &str = "[slug withheld: looks like a secret]";
pub(crate) const WITHHELD_TITLE: &str = "[title withheld: looks like a secret]";
pub(crate) const WITHHELD_SUMMARY: &str = "[summary withheld: looks like a secret]";
/// The slug written into a `log.md` line in place of a secret-looking one; `log.md` lines need a
/// valid slug.
pub(crate) const LOG_SLUG: &str = "slug-withheld";

/// Whether `text` matches a secret rule (ADR 0025). Adapters use it to keep echoed input, such
/// as argument values and file names, out of their own diagnostics.
pub fn looks_secret(text: &str) -> bool {
    !scan_all(text).is_empty()
}

/// `slug` for a diagnostic or other output, or `[slug withheld: looks like a secret]`.
pub fn slug(s: &str) -> &str {
    if looks_secret(s) { WITHHELD_SLUG } else { s }
}

pub(crate) fn title(s: &str) -> &str {
    if looks_secret(s) { WITHHELD_TITLE } else { s }
}

pub(crate) fn summary(s: &str) -> &str {
    if looks_secret(s) { WITHHELD_SUMMARY } else { s }
}

/// The slug of a `log.md` line.
pub(crate) fn log_slug(s: &Slug) -> Slug {
    if looks_secret(s.as_str()) {
        Slug::parse(LOG_SLUG).unwrap_or_else(|_| s.clone())
    } else {
        s.clone()
    }
}
