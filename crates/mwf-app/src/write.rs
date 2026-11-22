//! Write operations. Each one: take `.mwf/.lock` → read under the lock → validate → secret scan
//! of the added content → atomic page writes → rebuild `index.md` → append one `log.md` line →
//! `WriteOut` (ADRs 0016, 0023, 0025, 0027, 0029, 0040). Nothing is written when a check fails.

use mwf_domain::{
    Frontmatter, LogOp, Page, PageType, Rev, Slug, Status, Timestamp, apply_patch, render_log_line,
    render_page, rewrite_links, scan_added, scan_all, unlink,
};
use mwf_store::{LOCK_WAIT, Project, WriteGuard};
use serde_json::json;

use crate::corpus::{Corpus, links_to};
use crate::dto::{DeleteOut, NewIn, PatchIn, SetIn, WriteIn, WriteOut};
use crate::error::{AppError, ErrorCode};
use crate::redact;
use crate::{App, parse_stored};

/// Largest page body, and largest `patch` old / new text, in bytes of UTF-8 (100 KB = 102400
/// bytes; ADRs 0033, 0049).
pub const BODY_MAX_BYTES: usize = 100 * 1024;

fn check_size(field: &str, text: &str) -> Result<(), AppError> {
    if text.len() <= BODY_MAX_BYTES {
        return Ok(());
    }
    Err(AppError::new(
        ErrorCode::TooLarge,
        format!(
            "`{field}` is {} bytes; the limit is {BODY_MAX_BYTES} bytes (100 KB)",
            text.len()
        ),
    )
    .with(json!({ "field": field, "size": text.len(), "limit": BODY_MAX_BYTES })))
}

/// `SECRET_DETECTED` when `after` holds likely secrets that `before` does not (ADR 0025). The
/// error names rules, lines (of the page file) and redacted samples only.
fn check_secrets(slug: &Slug, before: &str, after: &str) -> Result<(), AppError> {
    let found = scan_added(before, after);
    if found.is_empty() {
        return Ok(());
    }
    let list: Vec<String> = found
        .iter()
        .map(|f| format!("{} at line {} ({})", f.rule, f.line, f.redacted))
        .collect();
    let findings: Vec<_> = found
        .iter()
        .map(|f| json!({ "rule": f.rule, "line": f.line, "redacted": f.redacted }))
        .collect();
    Err(AppError::new(
        ErrorCode::SecretDetected,
        format!(
            "refusing to write {}: the new content looks like a secret: {}; remove it and retry",
            redact::slug(slug.as_str()),
            list.join(", ")
        ),
    )
    .with(json!({ "slug": redact::slug(slug.as_str()), "findings": findings })))
}

/// `SECRET_DETECTED` for a slug that looks like a secret: it would become a file name and go
/// into `index.md` and `log.md` (ADRs 0025, 0049). The error carries only redacted samples.
fn check_slug(slug: &Slug) -> Result<(), AppError> {
    let found = scan_all(slug.as_str());
    if found.is_empty() {
        return Ok(());
    }
    let findings: Vec<_> = found
        .iter()
        .map(|f| json!({ "rule": f.rule, "redacted": f.redacted }))
        .collect();
    let rules: Vec<&str> = found.iter().map(|f| f.rule).collect();
    Err(AppError::new(
        ErrorCode::SecretDetected,
        format!(
            "the slug looks like a secret ({}); choose another slug",
            rules.join(", ")
        ),
    )
    .with(json!({ "field": "slug", "findings": findings })))
}

/// Reads everything a write may touch, under the lock and before the first change, so that a
/// symlink or wrong file type in `pages/`, `index.md` or `log.md` fails the command before it
/// has written anything (ADRs 0048, 0049). Returns the pages for the rest of the command.
fn preflight(project: &Project) -> Result<Corpus, AppError> {
    let corpus = Corpus::load(project)?;
    project.read_index()?;
    project.read_log(0)?;
    Ok(corpus)
}

fn dedup(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(tags.len());
    for tag in tags {
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    out
}

/// A rewritten page and its text before and after.
struct Rewrite {
    slug: Slug,
    after: String,
}

/// Rewrites the bodies of `pages` with `edit`, bumping `updated` and checking secrets.
fn rewrites(
    pages: &[&Page],
    corpus: &Corpus,
    ts: &Timestamp,
    edit: impl Fn(&str) -> String,
) -> Result<Vec<Rewrite>, AppError> {
    pages
        .iter()
        .map(|p| {
            let mut page = (*p).clone();
            page.body = edit(&p.body);
            page.fm.updated = ts.clone();
            check_size("body", &page.body).map_err(|e| AppError {
                message: format!(
                    "rewriting the links of {}: {}",
                    redact::slug(p.slug.as_str()),
                    e.message
                ),
                ..e
            })?;
            let after = render_page(&page);
            let before = corpus
                .entry(p.slug.as_str())
                .map(|e| String::from_utf8_lossy(&e.bytes).into_owned())
                .unwrap_or_default();
            check_secrets(&p.slug, &before, &after)?;
            Ok(Rewrite {
                slug: p.slug.clone(),
                after,
            })
        })
        .collect()
}

impl App {
    /// Creates a page: status `active`, `created` = `updated` = now.
    pub fn new_page(&self, i: NewIn) -> Result<WriteOut, AppError> {
        let slug = Slug::parse(&i.slug)?;
        check_slug(&slug)?;
        let page_type: PageType = i.page_type.parse()?;
        check_size("body", &i.body)?;
        let ts = self.now()?;
        let page = Page {
            slug: slug.clone(),
            fm: Frontmatter {
                title: i.title,
                page_type,
                summary: i.summary,
                tags: dedup(i.tags),
                status: Status::Active,
                created: ts.clone(),
                updated: ts.clone(),
            },
            body: i.body,
        };
        page.fm.check()?;
        let mut guard = self.project.lock(LOCK_WAIT)?;
        preflight(guard.project())?;
        if guard.project().read_page(&slug)?.is_some() {
            return Err(AppError::new(
                ErrorCode::AlreadyExists,
                format!("page {slug} already exists; use `mwf write` or `mwf patch` to change it"),
            )
            .with(json!({ "slug": slug.as_str() })));
        }
        let text = render_page(&page);
        check_secrets(&slug, "", &text)?;
        guard.write_page(&slug, text.as_bytes())?;
        self.finish(
            &mut guard,
            &ts,
            &LogOp::New,
            &page,
            text.as_bytes(),
            Vec::new(),
        )
    }

    /// Replaces the body when `rev` matches the page's current rev (ADR 0023).
    pub fn write(&self, i: WriteIn) -> Result<WriteOut, AppError> {
        check_size("body", &i.body)?;
        self.update(&i.slug, LogOp::Write, |page, bytes| {
            let current = Rev::of(bytes);
            if current.as_str() != i.rev {
                return Err(AppError::new(
                    ErrorCode::RevMismatch,
                    format!(
                        "page {} changed since you read it (rev is now {current}); run `mwf show {}` and retry",
                        redact::slug(page.slug.as_str()),
                        redact::slug(page.slug.as_str())
                    ),
                )
                .with(json!({
                    "slug": redact::slug(page.slug.as_str()),
                    "current_rev": current.as_str(),
                })));
            }
            let mut page = page.clone();
            page.body = i.body;
            Ok(page)
        })
    }

    /// Replaces the one occurrence of `old` in the body with `new` (ADR 0023).
    pub fn patch(&self, i: PatchIn) -> Result<WriteOut, AppError> {
        check_size("old", &i.old)?;
        check_size("new", &i.new)?;
        self.update(&i.slug, LogOp::Patch, |page, _| {
            let mut page = page.clone();
            page.body = apply_patch(&page.body, &i.old, &i.new)?;
            check_size("body", &page.body)?;
            Ok(page)
        })
    }

    /// Changes frontmatter fields; added tags go after the existing ones.
    pub fn set(&self, i: SetIn) -> Result<WriteOut, AppError> {
        if i.title.is_none()
            && i.page_type.is_none()
            && i.summary.is_none()
            && i.add_tags.is_empty()
            && i.remove_tags.is_empty()
        {
            return Err(AppError::field("set", "give at least one field to change"));
        }
        if i.add_tags.iter().any(|t| i.remove_tags.contains(t)) {
            return Err(AppError::field(
                "tags",
                "a tag cannot be both added and removed",
            ));
        }
        let page_type: Option<PageType> = i.page_type.as_deref().map(str::parse).transpose()?;
        self.update(&i.slug, LogOp::Set, |page, _| {
            let mut page = page.clone();
            let fm = &mut page.fm;
            if let Some(title) = i.title {
                fm.title = title;
            }
            if let Some(t) = page_type {
                fm.page_type = t;
            }
            if let Some(summary) = i.summary {
                fm.summary = summary;
            }
            fm.tags.retain(|t| !i.remove_tags.contains(t));
            let mut tags = std::mem::take(&mut fm.tags);
            tags.extend(i.add_tags);
            fm.tags = dedup(tags);
            Ok(page)
        })
    }

    /// Sets `status` to `archived` (`true`) or `active` (`false`).
    pub fn archive(&self, slug: &str, archived: bool) -> Result<WriteOut, AppError> {
        let (op, status) = if archived {
            (LogOp::Archive, Status::Archived)
        } else {
            (LogOp::Unarchive, Status::Active)
        };
        self.update(slug, op, |page, _| {
            let mut page = page.clone();
            page.fm.status = status;
            Ok(page)
        })
    }

    /// Renames a page and rewrites every internal link to it, in other pages and its own body
    /// (ADR 0038). Rewritten pages get a new `updated`; one `rename` line is logged.
    pub fn rename(&self, from: &str, to: &str) -> Result<WriteOut, AppError> {
        let from = Slug::parse(from)?;
        let to = Slug::parse(to)?;
        check_slug(&to)?;
        if from == to {
            return Err(AppError::field(
                "to",
                "the new slug is the same as the old one",
            ));
        }
        let mut guard = self.project.lock(LOCK_WAIT)?;
        let project = guard.project();
        let corpus = preflight(project)?;
        let bytes = project
            .read_page(&from)?
            .ok_or_else(|| AppError::not_found(&from))?;
        let page = parse_stored(&from, &bytes)?;
        if project.read_page(&to)?.is_some() {
            return Err(AppError::new(
                ErrorCode::AlreadyExists,
                format!("page {to} already exists"),
            )
            .with(json!({ "slug": to.as_str() })));
        }
        let ts = self.now()?;
        let referrers = corpus.backlinks(&from);
        let relinks = rewrites(&referrers, &corpus, &ts, |body| {
            rewrite_links(body, &from, &to)
        })?;
        let mut moved = page.clone();
        moved.slug = to.clone();
        let own = if links_to(&page, &from) {
            moved.body = rewrite_links(&page.body, &from, &to);
            moved.fm.updated = ts.clone();
            check_size("body", &moved.body)?;
            let text = render_page(&moved);
            check_secrets(&to, &String::from_utf8_lossy(&bytes), &text)?;
            Some(text)
        } else {
            None
        };
        let warnings = corpus.skipped_invalid(&from);

        guard.rename_page(&from, &to)?;
        if let Some(text) = &own {
            guard.write_page(&to, text.as_bytes())?;
        }
        for r in &relinks {
            guard.write_page(&r.slug, r.after.as_bytes())?;
        }
        let moved_bytes = own.map_or(bytes, String::into_bytes);
        let also: Vec<String> = relinks.iter().map(|r| r.slug.to_string()).collect();
        let mut out = self.finish(
            &mut guard,
            &ts,
            &LogOp::Rename { from },
            &moved,
            &moved_bytes,
            also,
        )?;
        out.warnings.extend(warnings);
        Ok(out)
    }

    /// Moves a page to `.mwf/trash/` (ADR 0026). Refused with `HAS_BACKLINKS` while other pages
    /// link to it, unless `unlink`, which first turns those links into plain text.
    pub fn delete(&self, slug: &str, unlink_refs: bool) -> Result<DeleteOut, AppError> {
        let slug = Slug::parse(slug)?;
        let mut guard = self.project.lock(LOCK_WAIT)?;
        let project = guard.project();
        let corpus = preflight(project)?;
        let bytes = project
            .read_page(&slug)?
            .ok_or_else(|| AppError::not_found(&slug))?;
        // A page that does not parse can still be deleted; its log line has no title.
        let title = parse_stored(&slug, &bytes).map_or_else(|_| String::new(), |p| p.fm.title);
        let referrers = corpus.backlinks(&slug);
        if !referrers.is_empty() && !unlink_refs {
            let names: Vec<&str> = referrers
                .iter()
                .map(|p| redact::slug(p.slug.as_str()))
                .collect();
            let shown = redact::slug(slug.as_str());
            return Err(AppError::new(
                ErrorCode::HasBacklinks,
                format!(
                    "{} page(s) link to {shown}: {}; archive it instead, or delete with --unlink",
                    names.len(),
                    names.join(", ")
                ),
            )
            .with(json!({ "slug": shown, "backlinks": names })));
        }
        let ts = self.now()?;
        let unlinks = rewrites(&referrers, &corpus, &ts, |body| unlink(body, &slug))?;
        let warnings = corpus.skipped_invalid(&slug);
        // Trash first: `trash/` is the one path the preflight cannot check, so a bad `trash/`
        // fails before any referrer is rewritten.
        let trashed = guard.move_to_trash(&slug, &ts)?;
        for r in &unlinks {
            guard.write_page(&r.slug, r.after.as_bytes())?;
        }
        self.rebuild_and_log(&mut guard, &ts, &LogOp::Delete, &slug, &title)?;
        let trashed = trashed
            .strip_prefix(project.root())
            .unwrap_or(&trashed)
            .display()
            .to_string();
        Ok(DeleteOut {
            slug: slug.to_string(),
            trashed,
            unlinked: unlinks.iter().map(|r| r.slug.to_string()).collect(),
            warnings,
        })
    }

    /// The shared path of `write`, `patch`, `set`, `archive` and `unarchive`: `edit` gets the
    /// current page and file bytes under the lock and returns the new page; `updated` is set
    /// here. When the result equals the current page, nothing is written or logged.
    fn update(
        &self,
        slug: &str,
        op: LogOp,
        edit: impl FnOnce(&Page, &[u8]) -> Result<Page, AppError>,
    ) -> Result<WriteOut, AppError> {
        let slug = Slug::parse(slug)?;
        let mut guard = self.project.lock(LOCK_WAIT)?;
        let project = guard.project();
        let corpus = preflight(project)?;
        let bytes = project
            .read_page(&slug)?
            .ok_or_else(|| AppError::not_found(&slug))?;
        let old = parse_stored(&slug, &bytes)?;
        let mut page = edit(&old, &bytes)?;
        page.fm.check()?;
        if page == old {
            return Ok(outcome(&corpus, &page, &bytes, false, Vec::new()));
        }
        let ts = self.now()?;
        page.fm.updated = ts.clone();
        let text = render_page(&page);
        // `parse_stored` succeeded, so `bytes` is UTF-8.
        check_secrets(&slug, &String::from_utf8_lossy(&bytes), &text)?;
        guard.write_page(&slug, text.as_bytes())?;
        self.finish(&mut guard, &ts, &op, &page, text.as_bytes(), Vec::new())
    }

    /// After the page files are written: rebuild `index.md`, log, and report on `page`.
    fn finish(
        &self,
        guard: &mut WriteGuard<'_>,
        ts: &Timestamp,
        op: &LogOp,
        page: &Page,
        bytes: &[u8],
        also_updated: Vec<String>,
    ) -> Result<WriteOut, AppError> {
        let corpus = self.rebuild_and_log(guard, ts, op, &page.slug, &page.fm.title)?;
        Ok(outcome(&corpus, page, bytes, true, also_updated))
    }

    /// Rewrites `index.md` when it differs from the pages, appends the log line, and returns
    /// the pages as they are now.
    fn rebuild_and_log(
        &self,
        guard: &mut WriteGuard<'_>,
        ts: &Timestamp,
        op: &LogOp,
        slug: &Slug,
        title: &str,
    ) -> Result<Corpus, AppError> {
        let project = guard.project();
        let corpus = Corpus::load(project)?;
        let index = corpus.index_text();
        if project.read_index()?.as_deref() != Some(index.as_bytes()) {
            guard.write_index(&index)?;
        }
        let op = match op {
            LogOp::Rename { from } => LogOp::Rename {
                from: redact::log_slug(from),
            },
            op => op.clone(),
        };
        guard.append_log(&render_log_line(
            ts,
            &op,
            &redact::log_slug(slug),
            redact::title(title),
        ))?;
        Ok(corpus)
    }
}

fn outcome(
    corpus: &Corpus,
    page: &Page,
    bytes: &[u8],
    changed: bool,
    also_updated: Vec<String>,
) -> WriteOut {
    WriteOut {
        slug: page.slug.to_string(),
        rev: Rev::of(bytes).to_string(),
        changed,
        warnings: corpus.dangling(page),
        related_unlinked: corpus.related_unlinked(page),
        also_updated,
    }
}
