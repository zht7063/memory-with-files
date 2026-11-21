//! Internal Markdown links between pages (ADR 0038).
//!
//! A link is `[text](dest)` or `[text](dest "title")`, with `dest` optionally in `<…>`. It is
//! **internal** when `dest` has no scheme, the path before `#` ends in `.md`, and the path,
//! resolved from `.mwf/pages/`, is `.mwf/pages/<slug>.md` for a valid slug. Everything else is
//! external. Links inside fenced code blocks (also in blockquotes and list items), indented
//! code blocks, inline code spans, images, and escaped brackets are skipped. Code spans and
//! links do not cross a paragraph.

use std::ops::Range;

use crate::model::Slug;

/// An internal link in a page body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub target: Slug,
    /// Text after `#`, if the destination has one.
    pub anchor: Option<String>,
    /// Byte range of the whole `[text](dest)` in the body.
    pub span: Range<usize>,
}

struct RawLink {
    link: Link,
    text: Range<usize>,
    /// Byte range of the path (before `#`) in the body.
    path: Range<usize>,
}

/// Internal links in `body`, in order of appearance.
pub fn internal_links(body: &str) -> Vec<Link> {
    scan(body).into_iter().map(|r| r.link).collect()
}

/// Points every internal link to `from` at `to`, keeping the link text, anchor, title and path
/// prefix (`./`, `../pages/`).
pub fn rewrite_links(body: &str, from: &Slug, to: &Slug) -> String {
    let old_name = format!("{from}.md");
    let new_name = format!("{to}.md");
    replace(body, from, |_, raw| {
        let mut out = body[raw.link.span.start..raw.path.end - old_name.len()].to_owned();
        out.push_str(&new_name);
        out.push_str(&body[raw.path.end..raw.link.span.end]);
        out
    })
}

/// Replaces every internal link to `target` with its link text (`delete --unlink`, ADR 0026).
pub fn unlink(body: &str, target: &Slug) -> String {
    replace(body, target, |body, raw| body[raw.text.clone()].to_owned())
}

fn replace(body: &str, target: &Slug, with: impl Fn(&str, &RawLink) -> String) -> String {
    let mut out = String::with_capacity(body.len());
    let mut copied = 0;
    for raw in scan(body) {
        if raw.link.target == *target {
            out.push_str(&body[copied..raw.link.span.start]);
            out.push_str(&with(body, &raw));
            copied = raw.link.span.end;
        }
    }
    out.push_str(&body[copied..]);
    out
}

fn scan(body: &str) -> Vec<RawLink> {
    let mut links = Vec::new();
    for segment in prose_segments(body) {
        scan_prose(body, segment, &mut links);
    }
    links
}

/// A block container a line can be inside (CommonMark).
enum Container {
    /// A blockquote: each line continues it with a `>` marker.
    Quote,
    /// A list item: each non-blank line continues it when indented `content` columns past
    /// where its parent container's content starts (not an absolute column, since a parent
    /// blockquote's marker may sit at a different column on each line).
    Item { content: usize },
}

/// An open fenced code block. It belongs to the whole container stack open at its start and
/// closes at a matching fence line or when one of those containers ends.
struct Fence {
    ch: u8,
    len: usize,
}

/// A position in a line, with its column (tabs stop every 4 columns).
#[derive(Clone, Copy)]
struct Cursor<'a> {
    line: &'a str,
    pos: usize,
    col: usize,
}

impl<'a> Cursor<'a> {
    fn rest(&self) -> &'a str {
        &self.line[self.pos..]
    }

    fn is_blank(&self) -> bool {
        self.rest().trim().is_empty()
    }

    /// Columns of whitespace at the cursor.
    fn indent(&self) -> usize {
        let mut col = self.col;
        for b in self.rest().bytes() {
            match b {
                b' ' => col += 1,
                b'\t' => col += 4 - col % 4,
                _ => break,
            }
        }
        col - self.col
    }

    /// Skips whitespace up to column `target`.
    fn skip_to(&mut self, target: usize) {
        while self.col < target {
            match self.rest().as_bytes().first() {
                Some(b' ') => self.col += 1,
                Some(b'\t') => self.col += 4 - self.col % 4,
                _ => return,
            }
            self.pos += 1;
        }
    }

    fn advance(&mut self, bytes: usize) {
        self.pos += bytes;
        self.col += bytes;
    }

    /// Skips the indentation (less than 4 columns) and returns the text after it, if any.
    fn after_indent(&self) -> Option<Cursor<'a>> {
        let indent = self.indent();
        (indent < 4).then(|| {
            let mut c = *self;
            c.skip_to(c.col + indent);
            c
        })
    }

    /// Consumes a blockquote marker `>` and one following space.
    fn quote_marker(&mut self) -> bool {
        match self.after_indent() {
            Some(mut c) if c.rest().starts_with('>') => {
                c.advance(1);
                if c.rest().starts_with(' ') {
                    c.advance(1);
                }
                *self = c;
                true
            }
            _ => false,
        }
    }
}

/// Byte ranges of `body` that hold inline content: one range per paragraph or ATX heading,
/// outside fenced and indented code blocks. Code spans and links never cross a range.
///
/// A line-based subset of CommonMark blocks. Each line first continues the open blockquotes
/// (`>`) and list items (indentation to the item's content column; blank lines continue
/// items), then may open new ones; fences and indented code are judged relative to the
/// innermost container. A fence ends at a matching fence line, when any container it is in
/// ends, or at the end of the body.
fn prose_segments(body: &str) -> Vec<Range<usize>> {
    let mut segments = Vec::new();
    let mut para: Option<Range<usize>> = None;
    let mut fence: Option<Fence> = None;
    let mut stack: Vec<Container> = Vec::new();
    let mut pos = 0;
    for line in body.split_inclusive('\n') {
        let line_start = pos;
        pos += line.len();
        let mut cur = Cursor {
            line,
            pos: 0,
            col: 0,
        };
        let mut matched = 0;
        for container in &stack {
            let continues = match container {
                Container::Quote => cur.quote_marker(),
                Container::Item { .. } if cur.is_blank() => true,
                Container::Item { content } if cur.indent() >= *content => {
                    cur.skip_to(cur.col + *content);
                    true
                }
                Container::Item { .. } => false,
            };
            if !continues {
                break;
            }
            matched += 1;
        }

        if let Some(open) = &fence {
            if matched == stack.len() {
                if let Some(c) = cur.after_indent()
                    && let Some((ch, len, info)) = fence_line(c.rest())
                    && ch == open.ch
                    && len >= open.len
                    && info.trim().is_empty()
                {
                    fence = None;
                }
                continue;
            }
            fence = None;
            stack.truncate(matched);
        }

        if matched < stack.len() {
            // A paragraph line may continue lazily without its container markers.
            let lazy = para.is_some() && !cur.is_blank() && !starts_block(&cur);
            if lazy {
                if let Some(p) = &mut para {
                    p.end = pos;
                }
                continue;
            }
            segments.extend(para.take());
            stack.truncate(matched);
        }

        // New containers.
        loop {
            if cur.quote_marker() {
                segments.extend(para.take());
                stack.push(Container::Quote);
                continue;
            }
            if let Some(mut c) = cur.after_indent()
                && let Some(marker) = list_marker(c.rest())
            {
                segments.extend(para.take());
                c.advance(marker);
                // Content starts after 1 to 4 columns of padding; with none (an empty item)
                // or more (indented code in the item) it is one column after the marker.
                // Only padding that exists in the line is consumed.
                let padding = c.indent();
                let content = if c.is_blank() {
                    c.col + 1
                } else {
                    c.skip_to(c.col + if padding > 4 { 1 } else { padding });
                    c.col
                };
                stack.push(Container::Item {
                    content: content - cur.col,
                });
                cur = c;
                continue;
            }
            break;
        }

        // The leaf block.
        if cur.is_blank() {
            segments.extend(para.take());
            continue;
        }
        let Some(leaf) = cur.after_indent() else {
            // Indented code, unless it continues a paragraph.
            if let Some(p) = &mut para {
                p.end = pos;
            }
            continue;
        };
        if let Some((ch, len, info)) = fence_line(leaf.rest())
            && !(ch == b'`' && info.contains('`'))
        {
            segments.extend(para.take());
            fence = Some(Fence { ch, len });
        } else if is_atx_heading(leaf.rest()) {
            segments.extend(para.take());
            segments.push(line_start..pos);
        } else if let Some(p) = &mut para {
            p.end = pos;
        } else {
            para = Some(line_start..pos);
        }
    }
    segments.extend(para);
    segments
}

/// Whether the text at `cur` starts a block that cannot continue a paragraph lazily.
fn starts_block(cur: &Cursor<'_>) -> bool {
    cur.after_indent().is_some_and(|c| {
        let t = c.rest();
        t.starts_with('>')
            || list_marker(t).is_some()
            || fence_line(t).is_some()
            || is_atx_heading(t)
    })
}

/// For a list item line (without indentation), the byte length of its marker (`-`, `*`, `+`,
/// or 1 to 9 digits and `.` or `)`), which must be followed by whitespace or the line end.
fn list_marker(line: &str) -> Option<usize> {
    let b = line.as_bytes();
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    let marker = match b.first()? {
        b'-' | b'*' | b'+' => 1,
        _ if (1..=9).contains(&digits) && matches!(b.get(digits), Some(b'.' | b')')) => digits + 1,
        _ => return None,
    };
    matches!(b.get(marker), None | Some(b' ' | b'\t' | b'\n' | b'\r')).then_some(marker)
}

fn is_atx_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|&c| c == b'#').count();
    (1..=6).contains(&hashes)
        && matches!(
            line.as_bytes().get(hashes),
            None | Some(b' ' | b'\t' | b'\n' | b'\r')
        )
}

/// For a line without indentation that is a code fence (3 or more `` ` `` or `~`), its fence
/// character, fence length and the rest of the line.
fn fence_line(line: &str) -> Option<(u8, usize, &str)> {
    let ch = *line.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = line.bytes().take_while(|&b| b == ch).count();
    (len >= 3).then(|| (ch, len, &line[len..]))
}

fn scan_prose(body: &str, segment: Range<usize>, links: &mut Vec<RawLink>) {
    let b = body.as_bytes();
    let end = segment.end;
    let mut i = segment.start;
    while i < end {
        match b[i] {
            b'\\' => i += 2,
            b'`' => i = skip_code_span(b, i, end),
            b'[' => {
                let image =
                    i > segment.start && b[i - 1] == b'!' && !escaped(b, i - 1, segment.start);
                match parse_link(body, i, end) {
                    Some((raw, next)) => {
                        if !image {
                            links.extend(raw);
                        }
                        i = next;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }
}

/// Whether the byte at `i` is preceded by an odd number of backslashes.
fn escaped(b: &[u8], i: usize, start: usize) -> bool {
    b[start..i]
        .iter()
        .rev()
        .take_while(|&&c| c == b'\\')
        .count()
        % 2
        == 1
}

/// Given a backtick run at `i`, the index after the code span it opens, or after the run if it
/// has no closing run of the same length.
fn skip_code_span(b: &[u8], i: usize, end: usize) -> usize {
    let run = |at: usize| b[at..end].iter().take_while(|&&c| c == b'`').count();
    let len = run(i);
    let mut j = i + len;
    while j < end {
        if b[j] == b'`' {
            let close = run(j);
            if close == len {
                return j + close;
            }
            j += close;
        } else {
            j += 1;
        }
    }
    i + len
}

/// Parses `[text](dest "title")` starting at the `[` at `start`. Returns the link if it is
/// internal, and the index after it. Text and destination stay on one line.
fn parse_link(body: &str, start: usize, end: usize) -> Option<(Option<RawLink>, usize)> {
    let b = body.as_bytes();
    // Link text: up to the matching `]`, skipping escapes and code spans.
    let mut depth = 0;
    let mut i = start + 1;
    let close = loop {
        match *b.get(i).filter(|_| i < end)? {
            b'\n' => return None,
            b'\\' => i += 2,
            b'`' => i = skip_code_span(b, i, end),
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' if depth == 0 => break i,
            b']' => {
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
    };
    if b.get(close + 1) != Some(&b'(') {
        return None;
    }
    let mut i = close + 2;
    while b.get(i) == Some(&b' ') {
        i += 1;
    }
    // Destination.
    let dest = if b.get(i) == Some(&b'<') {
        let from = i + 1;
        let to = from + body[from..end].find(['>', '\n'])?;
        if b[to] != b'>' {
            return None;
        }
        i = to + 1;
        from..to
    } else {
        let from = i;
        let mut parens = 0;
        while i < end {
            match b[i] {
                b'\\' => i += 1,
                b'(' => parens += 1,
                b')' if parens == 0 => break,
                b')' => parens -= 1,
                c if c.is_ascii_whitespace() => break,
                _ => {}
            }
            i += 1;
        }
        from..i.min(end)
    };
    // Optional title, then `)`.
    while b.get(i) == Some(&b' ') {
        i += 1;
    }
    if let Some(&quote @ (b'"' | b'\'')) = b.get(i) {
        i += 1;
        loop {
            match *b.get(i).filter(|_| i < end)? {
                b'\n' => return None,
                b'\\' => i += 2,
                c if c == quote => break,
                _ => i += 1,
            }
        }
        i += 1;
        while b.get(i) == Some(&b' ') {
            i += 1;
        }
    }
    if i >= end || b[i] != b')' {
        return None;
    }
    let span = start..i + 1;
    let raw = classify(&body[dest.clone()]).map(|(target, anchor, path_len)| RawLink {
        link: Link {
            target,
            anchor,
            span: span.clone(),
        },
        text: start + 1..close,
        path: dest.start..dest.start + path_len,
    });
    Some((raw, span.end))
}

/// For an internal destination, its target, anchor and the byte length of its path.
fn classify(dest: &str) -> Option<(Slug, Option<String>, usize)> {
    let (path, anchor) = match dest.split_once('#') {
        Some((path, anchor)) => (path, Some(anchor.to_owned())),
        None => (dest, None),
    };
    // A query means the destination is not a page file; reject it before normalising the path.
    if has_scheme(path) || path.starts_with('/') || path.contains('?') {
        return None;
    }
    let stem = path.strip_suffix(".md")?;
    // Resolve against `.mwf/pages/`, relative to the project root.
    let mut dir: Vec<&str> = vec![".mwf", "pages"];
    let mut above_root = false;
    let segments: Vec<&str> = stem.split('/').collect();
    let (name, dirs) = segments.split_last()?;
    for &seg in dirs {
        match seg {
            "" | "." => {}
            ".." => above_root |= dir.pop().is_none(),
            // Once above the project root, the path can never come back to `.mwf/pages`.
            _ if above_root => return None,
            _ => dir.push(seg),
        }
    }
    if above_root || dir != [".mwf", "pages"] {
        return None;
    }
    let target = Slug::parse(name).ok()?;
    Some((target, anchor, path.len()))
}

fn has_scheme(path: &str) -> bool {
    match path.split_once(':') {
        Some((scheme, _)) => {
            let mut chars = scheme.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slug(s: &str) -> Slug {
        Slug::parse(s).unwrap()
    }

    fn targets(body: &str) -> Vec<String> {
        internal_links(body)
            .into_iter()
            .map(|l| match l.anchor {
                Some(a) => format!("{}#{a}", l.target),
                None => l.target.to_string(),
            })
            .collect()
    }

    #[test]
    fn recognises_internal_link_forms() {
        let body = "[a](one.md) [b](./two.md#sec) [c](../pages/three.md) [d](<four.md> \"t\") \
                    [e](five.md 'title') [f](.//six.md) [g](../../.mwf/pages/seven.md)";
        assert_eq!(
            targets(body),
            ["one", "two#sec", "three", "four", "five", "six", "seven"]
        );
    }

    #[test]
    fn external_links_are_not_internal() {
        let body = "[a](https://x.com/a.md) [b](mailto:a.md) [c](../../src/db.rs) \
                    [d](../../docs/a.md) [e](/abs/a.md) [f](sub/a.md) [g](Bad_Slug.md) \
                    [h](a.md?x=1) [i](a.markdown) [j](../a.md) [k](../../../x/.mwf/pages/a.md) \
                    [l](.md) [m](#local)";
        assert_eq!(targets(body), Vec::<String>::new());
    }

    #[test]
    fn span_covers_whole_link_and_anchor_is_kept() {
        let body = "see [the doc](a.md#x-y) now";
        let links = internal_links(body);
        assert_eq!(links.len(), 1);
        assert_eq!(&body[links[0].span.clone()], "[the doc](a.md#x-y)");
        assert_eq!(links[0].anchor.as_deref(), Some("x-y"));
        assert_eq!(internal_links("[x](a.md#)")[0].anchor.as_deref(), Some(""));
    }

    #[test]
    fn skips_code_images_and_escapes() {
        let body = "\
`[a](inline.md)` ``[b](`x`.md)`` [real](r1.md)
```md
[c](fenced.md)
```
~~~~
[d](tilde.md)
~~~
still code [e](still.md)
~~~~
![img](image.md) \\[f](escaped.md) \\\\[g](r2.md)
   ```
[h](indented-fence.md)
   ```
[`code` text](r3.md) `unclosed [i](r4.md)
";
        assert_eq!(targets(body), ["r1", "r2", "r3", "r4"]);
    }

    #[test]
    fn unclosed_fence_hides_the_rest() {
        assert_eq!(targets("[a](a.md)\n```\n[b](b.md)\n"), ["a"]);
        // A backtick fence whose info string has a backtick is not a fence.
        assert_eq!(targets("``` a`b\n[a](a.md)\n"), ["a"]);
    }

    #[test]
    fn brackets_and_parens() {
        assert_eq!(targets("[a [nested] b](a.md)"), ["a"]);
        assert_eq!(targets("[outer [inner](b.md)]"), ["b"]);
        assert_eq!(targets("[no](a.md"), Vec::<String>::new());
        assert_eq!(targets("[no]\n(a.md)"), Vec::<String>::new());
        assert_eq!(targets("[a](a.md \"open)"), Vec::<String>::new());
        assert_eq!(targets("[text] (a.md)"), Vec::<String>::new());
    }

    #[test]
    fn rewrite_keeps_text_anchor_title_and_prefix() {
        let body = "[A](old.md) [B](./old.md#s \"t\") [C](../pages/old.md) [D](older.md) \
                    `[E](old.md)` [F](https://x/old.md) [G](<old.md>)";
        assert_eq!(
            rewrite_links(body, &slug("old"), &slug("new-name")),
            "[A](new-name.md) [B](./new-name.md#s \"t\") [C](../pages/new-name.md) [D](older.md) \
             `[E](old.md)` [F](https://x/old.md) [G](<new-name.md>)"
        );
        assert_eq!(rewrite_links(body, &slug("none"), &slug("x")), body);
    }

    #[test]
    fn unlink_turns_links_into_text() {
        let body = "See [the **old** page](old.md#a) and [other](b.md), [again](./old.md).\n```\n[x](old.md)\n```\n";
        assert_eq!(
            unlink(body, &slug("old")),
            "See the **old** page and [other](b.md), again.\n```\n[x](old.md)\n```\n"
        );
    }

    #[test]
    fn handles_non_ascii_text() {
        let body = "中文 [链接 文字](目录.md) [页面](ye-mian.md)：结束";
        assert_eq!(targets(body), ["ye-mian"]);
        assert_eq!(
            rewrite_links(body, &slug("ye-mian"), &slug("page")),
            "中文 [链接 文字](目录.md) [页面](page.md)：结束"
        );
    }

    #[test]
    fn indented_code_blocks_are_skipped() {
        assert_eq!(targets("    [a](a.md)\n"), Vec::<String>::new());
        assert_eq!(targets("\t[a](a.md)\n"), Vec::<String>::new());
        assert_eq!(targets("p\n\n    [a](code.md)\n\nreal [b](b.md)\n"), ["b"]);
        assert_eq!(targets("# H\n    [a](code.md)\n"), Vec::<String>::new());
        // An indented line right after a paragraph line continues the paragraph.
        assert_eq!(targets("p\n    [c](cont.md)\n"), ["cont"]);
        // Inside a list item, code needs 4 columns past the item's content.
        assert_eq!(targets("- item\n\n    [l](list.md)\n"), ["list"]);
        assert_eq!(
            targets("- item\n\n      [c](code.md)\n"),
            Vec::<String>::new()
        );
        assert_eq!(
            targets("1. item\n\n   [l](list.md)\n\nafter\n\n    [c](code.md)\n"),
            ["list"]
        );
        let body = "    [a](old.md)\n\n[b](old.md)\n";
        assert_eq!(
            rewrite_links(body, &slug("old"), &slug("new")),
            "    [a](old.md)\n\n[b](new.md)\n"
        );
        assert_eq!(unlink(body, &slug("old")), "    [a](old.md)\n\nb\n");
    }

    #[test]
    fn fences_in_blockquotes_and_list_items_are_skipped() {
        assert_eq!(
            targets("> ~~~\n> [q](quoted.md)\n> ~~~\n[r](r.md)\n"),
            ["r"]
        );
        assert_eq!(
            targets("> > ```\n> > [q](q.md)\n> > ```\n> [r](r.md)\n"),
            ["r"]
        );
        // Leaving the blockquote closes its fence.
        assert_eq!(targets("> ```\n> [q](q.md)\n\nafter [r](r.md)\n"), ["r"]);
        assert_eq!(
            targets("- x\n  ```\n  [f](f.md)\n  ```\n- [g](g.md)\n"),
            ["g"]
        );
        assert_eq!(targets("> quoted [a](a.md)\n"), ["a"]);
    }

    #[test]
    fn code_spans_do_not_cross_paragraphs() {
        assert_eq!(targets("a `tick\n\n[p](p.md) and `x`\n"), ["p"]);
        assert_eq!(targets("# Title `x\n[p](p.md) `\n"), ["p"]);
        // Within one paragraph a span may cross a line break.
        assert_eq!(targets("a `x\n[p](p.md)` [q](q.md)\n"), ["q"]);
    }

    #[test]
    fn titles_with_escaped_quotes_and_queries() {
        assert_eq!(
            targets(r#"[a](a.md "say \"hi\"") [b](b.md 'it\'s')"#),
            ["a", "b"]
        );
        assert_eq!(
            rewrite_links(r#"[a](a.md "\"t\"")"#, &slug("a"), &slug("c")),
            r#"[a](c.md "\"t\"")"#
        );
        for body in [
            "[x](?/../a.md)",
            "[x](q?x/../a.md)",
            "[x](a.md?v=1#s)",
            "[x](?a.md)",
        ] {
            assert_eq!(targets(body), Vec::<String>::new(), "{body}");
        }
    }

    /// The last link in `body` is the prose link `[p](a.md)`; every other `a.md` is code.
    fn assert_only_prose_link(body: &str) {
        assert_eq!(targets(body), ["a"], "{body:?}");
        let at = body.rfind("[p](a.md)").unwrap();
        let (code, prose) = body.split_at(at);
        let rewritten = format!("{code}{}", prose.replacen("(a.md)", "(b.md)", 1));
        assert_eq!(
            rewrite_links(body, &slug("a"), &slug("b")),
            rewritten,
            "{body:?}"
        );
        let unlinked = format!("{code}{}", prose.replacen("[p](a.md)", "p", 1));
        assert_eq!(unlink(body, &slug("a")), unlinked, "{body:?}");
    }

    #[test]
    fn fences_are_judged_relative_to_their_containers() {
        for body in [
            // Fence opened on the list item's first line, closing fence indented in the item.
            "- ~~~\n  [c](a.md)\n  ~~~\n[p](a.md)\n",
            "- ~~~\n  [c](a.md)\n     ~~~\n[p](a.md)\n",
            // Ordered item with content at column 5: fence lines at column 5 are not code.
            "1.   ~~~\n     [c](a.md)\n     ~~~\n\n[p](a.md)\n",
            "10.  ```\n     [c](a.md)\n     ```\n     [p](a.md)\n",
            // An unclosed fence ends with its list item.
            "- ~~~\n  [c](a.md)\n\n  [c](a.md)\n[p](a.md)\n",
            "- ```\n  [c](a.md)\n- [p](a.md)\n",
            // An extra `>` inside a quoted fence is code, not a deeper quote.
            "> ~~~\n> > [c](a.md)\n> ~~~\n[p](a.md)\n",
            "> ```\n> > [c](a.md)\n> > ```\n> [c](a.md)\n> ```\n[p](a.md)\n",
            // Fence in a quote in a list item.
            "- > ~~~\n  > [c](a.md)\n  > ~~~\n  > [p](a.md)\n",
        ] {
            assert_only_prose_link(body);
        }
    }

    #[test]
    fn lazy_continuation_keeps_paragraph_in_container() {
        assert_eq!(targets("> quoted\nlazy [p](p.md)\n"), ["p"]);
        assert_eq!(targets("- item\nlazy `x\n- [p](p.md)`\n"), ["p"]);
    }

    #[test]
    fn empty_list_item_at_end_without_newline() {
        for body in [
            "-",
            "[p](a.md)\n-",
            "[p](a.md)\n\n1.",
            "> [p](a.md)\n> -",
            "- [p](a.md)\n  *",
        ] {
            let n = usize::from(body.contains("[p]"));
            assert_eq!(internal_links(body).len(), n, "{body:?}");
            assert_eq!(
                rewrite_links(body, &slug("a"), &slug("b")),
                body.replacen("a.md", "b.md", 1)
            );
            assert_eq!(unlink(body, &slug("a")), body.replacen("[p](a.md)", "p", 1));
        }
        assert_only_prose_link("- ~~~\n  [c](a.md)\n-\n[p](a.md)\n");
    }

    #[test]
    fn list_content_is_relative_to_its_parent_quote() {
        for body in [
            "   > - ~~~\n>   [c](a.md)\n>   ~~~\n\n[p](a.md)\n",
            "> - ~~~\n   >   [c](a.md)\n >   ~~~\n\n[p](a.md)\n",
            ">  1. ```\n>     [c](a.md)\n>     ```\n>     [p](a.md)\n",
        ] {
            assert_only_prose_link(body);
        }
    }
}
