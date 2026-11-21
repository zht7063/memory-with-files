//! Frontmatter parse and render: a hand-written YAML subset (ADR 0032).
//!
//! A page is a `---` line, one `key: value` line per field, a closing `---` line, then the body.
//! Values are plain or double-quoted strings (`\"` and `\\` are the only escapes); `tags` is an
//! inline list `[a, "b, c"]`. Multi-line strings, nested maps, anchors and comments are rejected.

use crate::error::{DomainError, field};
use crate::model::{Frontmatter, Page, PageType, Slug, Status, Timestamp};

const FENCE: &str = "---";

#[derive(Default)]
struct RawFields<'a> {
    title: Option<(usize, &'a str)>,
    page_type: Option<(usize, &'a str)>,
    summary: Option<(usize, &'a str)>,
    tags: Option<(usize, &'a str)>,
    status: Option<(usize, &'a str)>,
    created: Option<(usize, &'a str)>,
    updated: Option<(usize, &'a str)>,
}

/// Parses a page file. `tags` may be omitted (empty) and `status` defaults to `active`; every
/// other field is required, unknown and duplicate fields are errors, and the result passes
/// [`Frontmatter::check`]. The body is everything after the closing `---` line, unchanged.
pub fn parse_page(slug: Slug, text: &str) -> Result<Page, DomainError> {
    let (fm, body_start) = parse_frontmatter(text)?;
    Ok(Page {
        slug,
        fm,
        body: text[body_start..].to_owned(),
    })
}

/// The frontmatter of a page file and the byte offset where its body starts.
pub(crate) fn parse_frontmatter(text: &str) -> Result<(Frontmatter, usize), DomainError> {
    let bad = |line: usize, reason: &str| DomainError::Frontmatter {
        line,
        reason: reason.to_owned(),
    };
    let mut lines = text.split_inclusive('\n');
    let first = lines.next().unwrap_or("");
    if strip_eol(first).trim_end() != FENCE {
        return Err(bad(1, "the page must start with a `---` line"));
    }
    let mut body_start = first.len();
    let mut line_no = 1;
    let mut closed = false;
    let mut raw = RawFields::default();
    for line in lines {
        line_no += 1;
        body_start += line.len();
        let line = strip_eol(line);
        if line.trim_end() == FENCE {
            closed = true;
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let (key, rest) = line
            .split_once(':')
            .ok_or_else(|| bad(line_no, "expected `key: value`"))?;
        if !(rest.is_empty() || rest.starts_with(' ')) {
            return Err(bad(line_no, "expected a space after `:`"));
        }
        let slot = match key {
            "title" => &mut raw.title,
            "type" => &mut raw.page_type,
            "summary" => &mut raw.summary,
            "tags" => &mut raw.tags,
            "status" => &mut raw.status,
            "created" => &mut raw.created,
            "updated" => &mut raw.updated,
            _ => return Err(bad(line_no, &format!("unknown field `{key}`"))),
        };
        if slot.is_some() {
            return Err(bad(line_no, &format!("duplicate field `{key}`")));
        }
        *slot = Some((line_no, rest.trim()));
    }
    if !closed {
        return Err(bad(line_no, "missing the closing `---` line"));
    }

    let scalar = |name: &str, slot: Option<(usize, &str)>| -> Result<String, DomainError> {
        let (line, value) = slot.ok_or_else(|| field(name, "missing"))?;
        parse_scalar(value).map_err(|reason| bad(line, reason))
    };
    let timestamp = |name: &str, slot| -> Result<Timestamp, DomainError> {
        Timestamp::parse(&scalar(name, slot)?).map_err(|e| field(name, e.to_string()))
    };
    let fm = Frontmatter {
        title: scalar("title", raw.title)?,
        page_type: scalar("type", raw.page_type)?.parse::<PageType>()?,
        summary: scalar("summary", raw.summary)?,
        tags: match raw.tags {
            None => Vec::new(),
            Some((line, value)) => parse_list(value).map_err(|reason| bad(line, reason))?,
        },
        status: match raw.status {
            None => Status::Active,
            slot => scalar("status", slot)?.parse::<Status>()?,
        },
        created: timestamp("created", raw.created)?,
        updated: timestamp("updated", raw.updated)?,
    };
    fm.check()?;
    Ok((fm, body_start))
}

/// Renders a page with the fixed field order `title`, `type`, `summary`, `tags`, `status`,
/// `created`, `updated`. Expects frontmatter that passes [`Frontmatter::check`]; then
/// `parse_page(render_page(p)) == p`.
pub fn render_page(page: &Page) -> String {
    let fm = &page.fm;
    let tags: Vec<String> = fm.tags.iter().map(|t| render_scalar(t, true)).collect();
    format!(
        "---\ntitle: {}\ntype: {}\nsummary: {}\ntags: [{}]\nstatus: {}\ncreated: {}\nupdated: {}\n---\n{}",
        render_scalar(&fm.title, false),
        fm.page_type.as_str(),
        render_scalar(&fm.summary, false),
        tags.join(", "),
        fm.status.as_str(),
        fm.created,
        fm.updated,
        page.body
    )
}

fn strip_eol(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn parse_scalar(value: &str) -> Result<String, &'static str> {
    if let Some(rest) = value.strip_prefix('"') {
        let (s, after) = parse_quoted(rest)?;
        return if after.trim().is_empty() {
            Ok(s)
        } else {
            Err("unexpected text after the closing quote")
        };
    }
    if value.starts_with('[') {
        return Err("a list is allowed only in `tags`");
    }
    check_plain(value)?;
    Ok(value.to_owned())
}

/// Rejects plain values that YAML would read as something other than this exact string.
fn check_plain(value: &str) -> Result<(), &'static str> {
    let unsupported = value.starts_with([
        '\'', '{', '}', ']', '&', '*', '!', '|', '>', '%', '@', '`', '#',
    ]) || value.contains(" #")
        || value.contains(": ")
        || value.ends_with(':');
    if unsupported {
        Err("unsupported YAML syntax; wrap the value in double quotes")
    } else {
        Ok(())
    }
}

/// Parses the rest of a double-quoted string after its opening quote; returns the string and
/// the text after the closing quote.
fn parse_quoted(s: &str) -> Result<(String, &str), &'static str> {
    let mut out = String::new();
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' => return Ok((out, &s[i + 1..])),
            '\\' => match chars.next() {
                Some((_, e @ ('"' | '\\'))) => out.push(e),
                _ => return Err("only the escapes \\\" and \\\\ are supported"),
            },
            c => out.push(c),
        }
    }
    Err("missing the closing quote")
}

fn parse_list(value: &str) -> Result<Vec<String>, &'static str> {
    let end_of_list = |after: &str, items| {
        if after.trim().is_empty() {
            Ok(items)
        } else {
            Err("unexpected text after `]`")
        }
    };
    let mut rest = value
        .strip_prefix('[')
        .ok_or("expected an inline list like [a, b]")?
        .trim_start();
    let mut items = Vec::new();
    if let Some(after) = rest.strip_prefix(']') {
        return end_of_list(after, items);
    }
    loop {
        if let Some(quoted) = rest.strip_prefix('"') {
            let (item, after) = parse_quoted(quoted)?;
            items.push(item);
            rest = after.trim_start();
        } else {
            let end = rest.find([',', ']']).ok_or("missing `]`")?;
            let item = rest[..end].trim();
            if item.is_empty() || item.contains(['[', '{', '}']) {
                return Err("empty or unsupported list item; wrap it in double quotes");
            }
            check_plain(item)?;
            items.push(item.to_owned());
            rest = &rest[end..];
        }
        if let Some(after) = rest.strip_prefix(',') {
            rest = after.trim_start();
        } else if let Some(after) = rest.strip_prefix(']') {
            return end_of_list(after, items);
        } else {
            return Err("expected `,` or `]` after a list item");
        }
    }
}

fn render_scalar(s: &str, in_list: bool) -> String {
    if needs_quotes(s, in_list) {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_owned()
    }
}

/// Plain is used only when YAML reads it back as the same string; this is stricter than
/// [`check_plain`], so everything rendered plain parses.
fn needs_quotes(s: &str, in_list: bool) -> bool {
    const RESERVED: [&str; 10] = [
        "true", "false", "yes", "no", "on", "off", "y", "n", "null", "~",
    ];
    s.is_empty()
        || s.trim() != s
        || s.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%',
            '@', '`',
        ])
        || s.contains(": ")
        || s.contains(" #")
        || s.ends_with(':')
        || RESERVED.iter().any(|r| s.eq_ignore_ascii_case(r))
        || s.parse::<f64>().is_ok()
        || (in_list && s.contains([',', '[', ']', '{', '}']))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANONICAL: &str = "---\ntitle: Use BM25 for search\ntype: decision\nsummary: In-memory BM25 over bigrams\ntags: [search, perf]\nstatus: active\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-21T08:30:00Z\n---\n# Body\n\ntext\n";

    fn slug() -> Slug {
        Slug::parse("use-bm25").unwrap()
    }

    fn page(title: &str, summary: &str, tags: &[&str]) -> Page {
        Page {
            slug: slug(),
            fm: Frontmatter {
                title: title.into(),
                page_type: PageType::Knowledge,
                summary: summary.into(),
                tags: tags.iter().map(|t| (*t).to_owned()).collect(),
                status: Status::Archived,
                created: Timestamp::parse("2026-11-20T10:00:00Z").unwrap(),
                updated: Timestamp::parse("2026-11-21T10:00:00Z").unwrap(),
            },
            body: "body\n".into(),
        }
    }

    fn line_error(text: &str) -> usize {
        match parse_page(slug(), text) {
            Err(DomainError::Frontmatter { line, .. }) => line,
            other => panic!("expected a Frontmatter error, got {other:?}"),
        }
    }

    fn field_error(text: &str) -> String {
        match parse_page(slug(), text) {
            Err(DomainError::InvalidField { field, .. }) => field,
            other => panic!("expected an InvalidField error, got {other:?}"),
        }
    }

    #[test]
    fn parses_and_renders_canonical_page_identically() {
        let p = parse_page(slug(), CANONICAL).unwrap();
        assert_eq!(p.fm.title, "Use BM25 for search");
        assert_eq!(p.fm.page_type, PageType::Decision);
        assert_eq!(p.fm.tags, ["search", "perf"]);
        assert_eq!(p.fm.status, Status::Active);
        assert_eq!(p.fm.updated.as_str(), "2026-11-21T08:30:00Z");
        assert_eq!(p.body, "# Body\n\ntext\n");
        assert_eq!(render_page(&p), CANONICAL);
    }

    #[test]
    fn render_uses_fixed_field_order_regardless_of_input_order() {
        let shuffled = "---\nupdated: 2026-11-21T08:30:00Z\nstatus: active\ntags: [search, perf]\ncreated: 2026-11-20T10:00:00Z\nsummary: In-memory BM25 over bigrams\ntype: decision\ntitle: Use BM25 for search\n---\n# Body\n\ntext\n";
        assert_eq!(
            render_page(&parse_page(slug(), shuffled).unwrap()),
            CANONICAL
        );
    }

    #[test]
    fn round_trips_values_that_need_quotes() {
        let titles = [
            "a: b",
            "ends with colon:",
            "C# #tips",
            "x #comment-like",
            "\"quoted\" start",
            "back\\slash",
            "- dash start",
            "[bracket",
            "'single",
            "true",
            "No",
            "~",
            "42",
            "1e3",
            "#hash",
            "中文标题：说明",
        ];
        let tags = [
            "a,b", "x]y", "[z", "{w}", "-x", "true", "7", "q\"t", "plain",
        ];
        for title in titles {
            let p = page(title, title, &tags);
            let text = render_page(&p);
            assert_eq!(parse_page(slug(), &text).unwrap(), p, "{text}");
        }
    }

    #[test]
    fn renders_plain_when_safe_and_quotes_otherwise() {
        let text = render_page(&page("Plain title: no", "a \"b\"", &["x, y", "ok"]));
        assert!(text.contains("\ntitle: \"Plain title: no\"\n"), "{text}");
        assert!(text.contains("\nsummary: a \"b\"\n"), "{text}");
        assert!(text.contains("\ntags: [\"x, y\", ok]\n"), "{text}");
        assert!(render_page(&page("t", "s", &[])).contains("\ntags: []\n"));
    }

    #[test]
    fn optional_fields_default() {
        let text = "---\ntitle: t\ntype: task\nsummary: s\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-20T10:00:00Z\n---\n";
        let p = parse_page(slug(), text).unwrap();
        assert!(p.fm.tags.is_empty());
        assert_eq!(p.fm.status, Status::Active);
        assert_eq!(p.body, "");
    }

    #[test]
    fn accepts_crlf_and_quoted_values_and_keeps_body_bytes() {
        let text = "---\r\ntitle: \"a \\\"b\\\" \\\\ c\"\r\ntype: incident\r\nsummary: s\r\ntags: [ \"x, y\" ,z ]\r\nstatus: archived\r\ncreated: 2026-11-20T10:00:00Z\r\nupdated: \"2026-11-20T10:00:00Z\"\r\n---\r\nline\r\n";
        let p = parse_page(slug(), text).unwrap();
        assert_eq!(p.fm.title, "a \"b\" \\ c");
        assert_eq!(p.fm.tags, ["x, y", "z"]);
        assert_eq!(p.fm.status, Status::Archived);
        assert_eq!(p.body, "line\r\n");
    }

    #[test]
    fn rejects_malformed_blocks_with_line_numbers() {
        let fields = "title: t\ntype: task\nsummary: s\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-20T10:00:00Z\n";
        assert_eq!(line_error("no frontmatter\n"), 1);
        assert_eq!(line_error(""), 1);
        assert_eq!(line_error(&format!("---\n{fields}")), 6);
        assert_eq!(line_error(&format!("---\n{fields}owner: me\n---\n")), 7);
        assert_eq!(line_error(&format!("---\n{fields}title: again\n---\n")), 7);
        assert_eq!(line_error(&format!("---\n{fields}just text\n---\n")), 7);
        assert_eq!(line_error(&format!("---\n{fields}tags:[a]\n---\n")), 7);
        assert_eq!(line_error(&format!("---\n {fields}---\n")), 2);
        for bad_value in [
            "title: a: b",
            "title: x #c",
            "title: 'single'",
            "title: \"open",
            "title: \"bad \\n escape\"",
            "title: \"a\" b",
            "title: [a]",
            "title: |",
            "title: &anchor",
        ] {
            let text = format!("---\n{bad_value}\ntype: task\n---\n");
            assert_eq!(line_error(&text), 2, "{bad_value}");
        }
        for bad_tags in [
            "tags: a, b",
            "tags: [a",
            "tags: [a,]",
            "tags: [a] x",
            "tags: [a b, {c}]",
            "tags: [\"a\" b]",
            "tags:",
        ] {
            let text = format!("---\n{bad_tags}\n{fields}---\n");
            assert_eq!(line_error(&text), 2, "{bad_tags}");
        }
    }

    #[test]
    fn rejects_missing_and_invalid_fields() {
        let base = "title: t\ntype: task\nsummary: s\ncreated: 2026-11-20T10:00:00Z\nupdated: 2026-11-20T10:00:00Z\n";
        for (name, line) in [
            ("title", "title: t\n"),
            ("type", "type: task\n"),
            ("summary", "summary: s\n"),
            ("created", "created: 2026-11-20T10:00:00Z\n"),
            ("updated", "updated: 2026-11-20T10:00:00Z\n"),
        ] {
            let text = format!("---\n{}---\n", base.replace(line, ""));
            assert_eq!(field_error(&text), name);
        }
        let swap = |from: &str, to: &str| format!("---\n{}---\n", base.replace(from, to));
        assert_eq!(field_error(&swap("type: task", "type: note")), "type");
        assert_eq!(field_error(&swap("type: task", "type: Task")), "type");
        assert_eq!(
            field_error(&swap("summary: s\n", "summary: s\nstatus: gone\n")),
            "status"
        );
        assert_eq!(
            field_error(&swap(
                "created: 2026-11-20T10:00:00Z",
                "created: 2026-11-20"
            )),
            "created"
        );
        assert_eq!(field_error(&swap("title: t", "title:")), "title");
        assert_eq!(
            field_error(&swap(
                "summary: s",
                &format!("summary: {}", "x".repeat(121))
            )),
            "summary"
        );
    }
}
