//! Requests and responses of every operation. Responses derive `Serialize`; the CLI's `--json`
//! and snapshot tests use them as they are. No domain, store or search type appears here (ADR
//! 0015): types, statuses, timestamps and revs are plain strings.

use serde::Serialize;

/// Which pages `search` and `list` consider (ADRs 0039, 0046).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusFilter {
    #[default]
    Active,
    Archived,
    All,
}

/// `init` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InitOut {
    /// The directory that now holds `.mwf/`.
    pub root: String,
    /// `git` or `local`.
    pub mode: &'static str,
    /// What to do next, for people (from `mwf-assets`).
    pub next_steps: &'static str,
}

/// `show`: one page with its rev and links (ADRs 0023, 0040).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageView {
    pub slug: String,
    pub rev: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub status: String,
    pub created: String,
    pub updated: String,
    pub body: String,
    /// Distinct internal link targets, in order of first appearance.
    pub links_out: Vec<LinkRef>,
    /// Other pages that link here, by slug.
    pub links_in: Vec<LinkRef>,
}

/// The other end of a link. `title` and `summary` are absent when the page does not exist
/// (`exists: false`, a dangling link) or its file is not a valid page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkRef {
    pub slug: String,
    pub exists: bool,
    pub title: Option<String>,
    pub summary: Option<String>,
}

/// `search` request. `types` match any of them, `tags` must all be present; empty means no
/// filter. Unknown types are `INVALID_FIELD`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchIn {
    pub query: String,
    pub types: Vec<String>,
    pub tags: Vec<String>,
    pub status: StatusFilter,
    pub limit: usize,
}

/// Results returned when the caller does not ask for a number.
pub const DEFAULT_SEARCH_LIMIT: usize = 10;

impl Default for SearchIn {
    fn default() -> Self {
        SearchIn {
            query: String::new(),
            types: Vec::new(),
            tags: Vec::new(),
            status: StatusFilter::Active,
            limit: DEFAULT_SEARCH_LIMIT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub summary: String,
    pub status: String,
    pub score: f32,
    pub rev: String,
}

/// `list` request; filters as in [`SearchIn`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListIn {
    pub types: Vec<String>,
    pub tags: Vec<String>,
    pub status: StatusFilter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageSummary {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub status: String,
    pub updated: String,
    pub rev: String,
}

/// `new`: a page with status `active` and `created` = `updated` = now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NewIn {
    pub slug: String,
    pub page_type: String,
    pub title: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub body: String,
}

/// `write`: replaces the body when `rev` is the page's current rev.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WriteIn {
    pub slug: String,
    pub rev: String,
    pub body: String,
}

/// `patch`: replaces the one occurrence of `old` in the body with `new`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PatchIn {
    pub slug: String,
    pub old: String,
    pub new: String,
}

/// `set`: changes the given fields; at least one is required.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SetIn {
    pub slug: String,
    pub title: Option<String>,
    pub page_type: Option<String>,
    pub summary: Option<String>,
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
}

/// Result of every write except `delete` (ADR 0040).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WriteOut {
    pub slug: String,
    /// The page's rev after the write.
    pub rev: String,
    /// `false` when the request left the page as it was; then nothing was written or logged.
    pub changed: bool,
    pub warnings: Vec<Warning>,
    /// Up to 3 similar active pages this page does not link to yet (ADR 0040).
    pub related_unlinked: Vec<RelatedPage>,
    /// Other pages rewritten by the same command (`rename` relinks), by slug.
    pub also_updated: Vec<String>,
}

/// A non-fatal finding of a write, such as `dangling_link`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Warning {
    pub rule: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelatedPage {
    pub slug: String,
    pub title: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeleteOut {
    pub slug: String,
    /// Where the page went, relative to the project root (`.mwf/trash/<slug>.<ts>.md`).
    pub trashed: String,
    /// Pages whose links to it became plain text (`--unlink`), by slug.
    pub unlinked: Vec<String>,
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

/// `lint` result. `mwf lint` exits 1 when `errors > 0` (ADR 0035).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LintReport {
    pub issues: Vec<LintIssue>,
    pub errors: usize,
    pub warnings: usize,
}

/// One finding. `page` is the page file's name without `.md`, or `None` for project-wide rules
/// (`index_drift`, `invalid_config`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LintIssue {
    pub page: Option<String>,
    pub rule: &'static str,
    pub severity: Severity,
    pub message: String,
}

/// `[hooks]` of `.mwf/config.toml` (ADRs 0039, 0051), as [`crate::App::hooks_config`] reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct HooksConfig {
    /// Distinct prompt terms a page must match before `recall` returns it.
    pub recall_min_terms: usize,
    /// Most pages `recall` returns per prompt.
    pub recall_top_k: usize,
    /// Whether the Stop hook reminds the agent to save memories.
    pub stop_reminder: bool,
    /// Character budget of the SessionStart injection, for [`crate::App::session_context`].
    pub session_start_max_chars: usize,
}

/// What SessionStart injects (ADR 0051): `text` is at most the requested number of characters
/// (Unicode scalar values, newlines included) and empty for a project with nothing to show.
/// `truncated` is set when content was cut; `text` then ends with a hint naming the command
/// that shows the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionContext {
    pub text: String,
    pub truncated: bool,
}
