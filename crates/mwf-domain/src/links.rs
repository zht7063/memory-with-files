//! Internal Markdown links between pages (ADR 0038).
//!
//! A link is `[text](dest)` or `[text](dest "title")`, with `dest` optionally in `<…>`. It is
//! **internal** when `dest` has no scheme, the path before `#` ends in `.md`, and the path,
//! resolved from `.mwf/pages/`, is `.mwf/pages/<slug>.md` for a valid slug. Everything else is
//! external. Links inside fenced code blocks and inline code spans, images, and escaped
//! brackets are skipped. Indented code blocks are not recognised.

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

/// Byte ranges of `body` outside fenced code blocks.
fn prose_segments(body: &str) -> Vec<Range<usize>> {
    let mut segments = Vec::new();
    let mut start = 0;
    let mut pos = 0;
    // The fence character and length of the open code block.
    let mut fence: Option<(u8, usize)> = None;
    for line in body.split_inclusive('\n') {
        let line_start = pos;
        pos += line.len();
        let Some((ch, len, info)) = fence_line(line) else {
            continue;
        };
        match fence {
            None if !(ch == b'`' && info.contains('`')) => {
                segments.push(start..line_start);
                fence = Some((ch, len));
            }
            Some((open_ch, open_len))
                if ch == open_ch && len >= open_len && info.trim().is_empty() =>
            {
                fence = None;
                start = pos;
            }
            _ => {}
        }
    }
    if fence.is_none() {
        segments.push(start..body.len());
    }
    segments
}

/// For a line that is a code fence (up to 3 spaces, then 3 or more `` ` `` or `~`), its fence
/// character, fence length and the rest of the line.
fn fence_line(line: &str) -> Option<(u8, usize, &str)> {
    let indent = line.bytes().take_while(|&b| b == b' ').count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = *rest.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = rest.bytes().take_while(|&b| b == ch).count();
    (len >= 3).then(|| (ch, len, &rest[len..]))
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
        let to = i + 1 + body[i + 1..end].find([quote as char, '\n'])?;
        if b[to] != quote {
            return None;
        }
        i = to + 1;
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
    if has_scheme(path) || path.starts_with('/') {
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
}
