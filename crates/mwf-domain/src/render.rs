//! Generated files: `index.md` (ADRs 0027, 0038) and `log.md` lines (ADR 0029).

use crate::model::{Page, PageType, Slug, Status, Timestamp};

/// A write operation as recorded in `log.md`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogOp {
    New,
    Write,
    Patch,
    Set,
    Archive,
    Unarchive,
    /// The line's slug is the new one; `from` is the old one.
    Rename {
        from: Slug,
    },
    Delete,
}

/// Renders `index.md`: active pages grouped by type in [`PageType::ALL`] order, sorted by slug
/// within a group. Archived pages and empty groups are left out. The output depends only on
/// the set of pages, not their order.
pub fn render_index(pages: &[&Page]) -> String {
    let mut out = String::from("<!-- 由 mwf 生成，勿手改 -->\n# 目录\n");
    for page_type in PageType::ALL {
        let mut group: Vec<&Page> = pages
            .iter()
            .copied()
            .filter(|p| p.fm.page_type == page_type && p.fm.status == Status::Active)
            .collect();
        if group.is_empty() {
            continue;
        }
        group.sort_by(|a, b| a.slug.cmp(&b.slug));
        out.push_str(&format!("\n## {}\n", page_type.as_str()));
        for p in group {
            out.push_str(&format!(
                "- [{}](pages/{}.md) — {}\n",
                escape_link_text(&p.fm.title),
                p.slug,
                p.fm.summary
            ));
        }
    }
    out
}

/// Renders one `log.md` line without the trailing newline, such as
/// `2026-11-20T10:00:00Z new use-bm25 "Use BM25 for search"`. The result is always one
/// physical line: in the title, `"` and `\` are escaped with `\`, CR and LF become `\r` and
/// `\n`, and other control characters and Unicode line separators become `\u{…}`.
pub fn render_log_line(ts: &Timestamp, op: &LogOp, slug: &Slug, title: &str) -> String {
    let op = match op {
        LogOp::New => "new".to_owned(),
        LogOp::Write => "write".to_owned(),
        LogOp::Patch => "patch".to_owned(),
        LogOp::Set => "set".to_owned(),
        LogOp::Archive => "archive".to_owned(),
        LogOp::Unarchive => "unarchive".to_owned(),
        LogOp::Delete => "delete".to_owned(),
        LogOp::Rename { from } => format!("rename {from}->"),
    };
    let sep = if op.ends_with("->") { "" } else { " " };
    let mut quoted = String::with_capacity(title.len());
    for c in title.chars() {
        match c {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') => {
                quoted.push_str(&format!("\\u{{{:x}}}", u32::from(c)));
            }
            c => quoted.push(c),
        }
    }
    format!("{ts} {op}{sep}{slug} \"{quoted}\"")
}

fn escape_link_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '[' | ']') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Frontmatter;

    fn ts() -> Timestamp {
        Timestamp::parse("2026-11-20T10:00:00Z").unwrap()
    }

    fn page(slug: &str, page_type: PageType, status: Status, title: &str) -> Page {
        Page {
            slug: Slug::parse(slug).unwrap(),
            fm: Frontmatter {
                title: title.into(),
                page_type,
                summary: format!("about {slug}"),
                tags: vec![],
                status,
                created: ts(),
                updated: ts(),
            },
            body: String::new(),
        }
    }

    #[test]
    fn index_groups_in_type_order_sorts_by_slug_and_skips_archived() {
        let pages = [
            page("zeta", PageType::Task, Status::Active, "Zeta"),
            page("beta", PageType::Decision, Status::Active, "Beta [draft]"),
            page("alpha", PageType::Decision, Status::Active, "Alpha"),
            page("old", PageType::Decision, Status::Archived, "Old"),
            page("style", PageType::Preference, Status::Active, "Style"),
            page("gone", PageType::Incident, Status::Archived, "Gone"),
        ];
        let refs: Vec<&Page> = pages.iter().collect();
        let expected = "\
<!-- 由 mwf 生成，勿手改 -->
# 目录

## preference
- [Style](pages/style.md) — about style

## decision
- [Alpha](pages/alpha.md) — about alpha
- [Beta \\[draft\\]](pages/beta.md) — about beta

## task
- [Zeta](pages/zeta.md) — about zeta
";
        assert_eq!(render_index(&refs), expected);
        let reversed: Vec<&Page> = pages.iter().rev().collect();
        assert_eq!(render_index(&reversed), expected);
        assert_eq!(render_index(&[]), "<!-- 由 mwf 生成，勿手改 -->\n# 目录\n");
    }

    #[test]
    fn log_lines() {
        let slug = Slug::parse("use-bm25").unwrap();
        assert_eq!(
            render_log_line(&ts(), &LogOp::New, &slug, "Use BM25 for search"),
            "2026-11-20T10:00:00Z new use-bm25 \"Use BM25 for search\""
        );
        let from = Slug::parse("bm25").unwrap();
        assert_eq!(
            render_log_line(&ts(), &LogOp::Rename { from }, &slug, "T"),
            "2026-11-20T10:00:00Z rename bm25->use-bm25 \"T\""
        );
        assert_eq!(
            render_log_line(&ts(), &LogOp::Delete, &slug, "say \"hi\" \\ bye"),
            "2026-11-20T10:00:00Z delete use-bm25 \"say \\\"hi\\\" \\\\ bye\""
        );
        let line = render_log_line(&ts(), &LogOp::Set, &slug, "a\nb\r\nc\td\u{2028}e");
        assert_eq!(
            line,
            "2026-11-20T10:00:00Z set use-bm25 \"a\\nb\\r\\nc\\u{9}d\\u{2028}e\""
        );
        assert_eq!(line.lines().count(), 1);
        for (op, word) in [
            (LogOp::Write, "write"),
            (LogOp::Patch, "patch"),
            (LogOp::Set, "set"),
            (LogOp::Archive, "archive"),
            (LogOp::Unarchive, "unarchive"),
        ] {
            assert_eq!(
                render_log_line(&ts(), &op, &slug, "t"),
                format!("2026-11-20T10:00:00Z {word} use-bm25 \"t\"")
            );
        }
    }
}
