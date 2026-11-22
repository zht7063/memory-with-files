//! Plain-text output for agents: no colors, no tables (ADR 0028). The formats are pinned by
//! the snapshot tests in `crates/mwf/tests` and described in ADR 0050.

use std::fmt::Write;

use mwf_app::{
    DeleteOut, LinkRef, LintReport, PageSummary, PageView, SearchHit, Severity, Warning, WriteOut,
    looks_secret, shown_slug, shown_summary, shown_title,
};

/// `show`: `key: value` lines, a blank line, the body, then the links.
pub(crate) fn page(p: &PageView) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "slug: {}", p.slug);
    let _ = writeln!(out, "rev: {}", p.rev);
    let _ = writeln!(out, "title: {}", p.title);
    let _ = writeln!(out, "type: {}", p.page_type);
    let _ = writeln!(out, "summary: {}", p.summary);
    if p.tags.is_empty() {
        out.push_str("tags:\n");
    } else {
        let _ = writeln!(out, "tags: {}", p.tags.join(", "));
    }
    let _ = writeln!(out, "status: {}", p.status);
    let _ = writeln!(out, "created: {}", p.created);
    let _ = writeln!(out, "updated: {}", p.updated);
    out.push('\n');
    out.push_str(&p.body);
    if !p.body.is_empty() && !p.body.ends_with('\n') {
        out.push('\n');
    }
    links(&mut out, "links out", &p.links_out);
    links(&mut out, "links in", &p.links_in);
    out
}

fn links(out: &mut String, heading: &str, refs: &[LinkRef]) {
    let _ = writeln!(
        out,
        "\n{heading}:{}",
        if refs.is_empty() { " none" } else { "" }
    );
    for r in refs {
        match (&r.title, &r.summary, r.exists) {
            (Some(title), Some(summary), _) => {
                let _ = writeln!(out, "  {}: {title} — {summary}", r.slug);
            }
            (_, _, true) => {
                let _ = writeln!(out, "  {}: (invalid page, run `mwf lint`)", r.slug);
            }
            (_, _, false) => {
                let _ = writeln!(out, "  {}: (missing)", r.slug);
            }
        }
    }
}

/// `search`: two lines per hit, best first.
pub(crate) fn hits(hits: &[SearchHit]) -> String {
    if hits.is_empty() {
        return "no results\n".to_owned();
    }
    let mut out = String::new();
    for h in hits {
        let _ = writeln!(
            out,
            "{}  {}  {}  score {:.3}  rev {}\n  {} — {}",
            h.slug, h.page_type, h.status, h.score, h.rev, h.title, h.summary
        );
    }
    out
}

/// `list`: two lines per page, a third for tags.
pub(crate) fn summaries(pages: &[PageSummary]) -> String {
    if pages.is_empty() {
        return "no pages\n".to_owned();
    }
    let mut out = String::new();
    for p in pages {
        let _ = writeln!(
            out,
            "{}  {}  {}  rev {}\n  {} — {}",
            p.slug, p.page_type, p.status, p.rev, p.title, p.summary
        );
        if !p.tags.is_empty() {
            let _ = writeln!(out, "  tags: {}", p.tags.join(", "));
        }
    }
    out
}

/// `log`: the lines as they are in `log.md`.
pub(crate) fn lines(lines: &[String]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// `lint`: one line per issue, then the counts.
pub(crate) fn lint(r: &LintReport) -> String {
    let mut out = String::new();
    for i in &r.issues {
        let severity = match i.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        match &i.page {
            Some(page) => {
                let _ = writeln!(out, "{severity}[{}] {page}: {}", i.rule, i.message);
            }
            None => {
                let _ = writeln!(out, "{severity}[{}]: {}", i.rule, i.message);
            }
        }
    }
    let _ = writeln!(out, "errors: {}, warnings: {}", r.errors, r.warnings);
    out
}

/// Slugs, as writes report them: a stored page's slug can look like a secret, and a write
/// does not copy it to the output (ADRs 0049, 0050).
fn slugs(list: &[String]) -> String {
    list.iter()
        .map(|s| shown_slug(s))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Every write except `delete`: what happened and the new rev, then warnings, other rewritten
/// pages and related pages not linked yet (ADR 0040).
pub(crate) fn write(verb: &str, w: &WriteOut) -> String {
    let mut out = String::new();
    let slug = shown_slug(&w.slug);
    if w.changed {
        let _ = writeln!(out, "{verb} {slug}");
    } else {
        let _ = writeln!(out, "unchanged {slug}");
    }
    let _ = writeln!(out, "rev: {}", w.rev);
    warnings(&mut out, &w.warnings);
    if !w.also_updated.is_empty() {
        let _ = writeln!(out, "also updated: {}", slugs(&w.also_updated));
    }
    if !w.related_unlinked.is_empty() {
        out.push_str("related pages not linked yet:\n");
        for r in &w.related_unlinked {
            let _ = writeln!(
                out,
                "  {}: {} — {}",
                shown_slug(&r.slug),
                shown_title(&r.title),
                shown_summary(&r.summary)
            );
        }
    }
    out
}

pub(crate) fn delete(d: &DeleteOut) -> String {
    let trashed = if looks_secret(&d.trashed) {
        "[path withheld: looks like a secret]"
    } else {
        &d.trashed
    };
    let mut out = format!("deleted {}\ntrashed: {trashed}\n", shown_slug(&d.slug));
    if !d.unlinked.is_empty() {
        let _ = writeln!(out, "unlinked: {}", slugs(&d.unlinked));
    }
    warnings(&mut out, &d.warnings);
    out
}

fn warnings(out: &mut String, warnings: &[Warning]) {
    for w in warnings {
        let _ = writeln!(out, "warning[{}]: {}", w.rule, w.message);
    }
}
