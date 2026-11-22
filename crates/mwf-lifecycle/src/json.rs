//! A JSON tree that keeps what `serde_json::Value` loses: the order of object keys and the
//! spelling of strings and numbers (ADR 0052). A host's `settings.json` / `hooks.json` is the
//! user's file; mwf changes its own hook entries and writes everything else back as it was.
//!
//! `serde_json`'s `preserve_order` feature would keep key order too, but Cargo unifies features
//! across the workspace, so it would also change the key order of the JSON `mwf-hooks` prints.

use std::fmt::Write as _;

/// A string as written in the file (`raw`, with its quotes and escapes) and its value.
#[derive(Clone, Debug)]
pub(crate) struct Str {
    raw: String,
    pub(crate) value: String,
}

impl Str {
    pub(crate) fn new(value: &str) -> Str {
        Str {
            raw: serde_json::Value::from(value).to_string(),
            value: value.to_owned(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Json {
    Null,
    Bool(bool),
    /// The number as written.
    Number(String),
    String(Str),
    Array(Vec<Json>, Span),
    Object(Vec<(Str, Json)>, Span),
}

/// A container's text in the file it was parsed from, line endings and all, so that an untouched part of
/// the user's file is written back with its own layout. It is used only while the container
/// still parses from it to the same value, so an edit can never be hidden by a stale span.
#[derive(Clone, Debug, Default)]
pub(crate) struct Span(Option<String>);

/// Containers nested deeper than this are refused rather than risking the stack.
const MAX_DEPTH: usize = 128;

impl Json {
    pub(crate) fn str(value: &str) -> Json {
        Json::String(Str::new(value))
    }

    pub(crate) fn object(entries: Vec<(&str, Json)>) -> Json {
        Json::Object(
            entries.into_iter().map(|(k, v)| (Str::new(k), v)).collect(),
            Span::default(),
        )
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(&s.value),
            _ => None,
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries, _) => entries.iter().find(|(k, _)| k.value == key).map(|e| &e.1),
            _ => None,
        }
    }

    /// Equal values: strings by value, numbers as written, objects regardless of key order.
    pub(crate) fn same(&self, other: &Json) -> bool {
        match (self, other) {
            (Json::Null, Json::Null) => true,
            (Json::Bool(a), Json::Bool(b)) => a == b,
            (Json::Number(a), Json::Number(b)) => a == b,
            (Json::String(a), Json::String(b)) => a.value == b.value,
            (Json::Array(a, _), Json::Array(b, _)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same(y))
            }
            (Json::Object(a, _), Json::Object(b, _)) => {
                a.len() == b.len()
                    && a.iter().all(|(k, v)| {
                        b.iter()
                            .find(|(bk, _)| bk.value == k.value)
                            .is_some_and(|(_, bv)| v.same(bv))
                    })
            }
            _ => false,
        }
    }

    /// Equal values and object keys in the same order.
    fn identical(&self, other: &Json) -> bool {
        match (self, other) {
            (Json::Array(a, _), Json::Array(b, _)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.identical(y))
            }
            (Json::Object(a, _), Json::Object(b, _)) => {
                a.len() == b.len()
                    && a.iter()
                        .zip(b)
                        .all(|((ka, va), (kb, vb))| ka.value == kb.value && va.identical(vb))
            }
            _ => self.same(other),
        }
    }

    /// One line, no spaces: for `--json` output.
    pub(crate) fn compact(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, None, 0);
        out
    }

    /// Pretty-printed in the file's `style`, ending as the file did.
    pub(crate) fn pretty(&self, style: &Style) -> String {
        let eol = if style.crlf { "\r\n" } else { "\n" };
        let mut out = String::new();
        self.write(&mut out, Some((&style.indent, eol)), 0);
        if style.final_newline {
            out.push_str(eol);
        }
        out
    }

    /// `layout` is the indent unit and line ending, `None` for one line. An untouched
    /// container is copied from the file as it was, its line endings included.
    fn write(&self, out: &mut String, layout: Option<(&str, &str)>, depth: usize) {
        let indent = layout;
        let newline = |out: &mut String, depth: usize| {
            if let Some((unit, eol)) = layout {
                out.push_str(eol);
                for _ in 0..depth {
                    out.push_str(unit);
                }
            }
        };
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => {
                let _ = write!(out, "{b}");
            }
            Json::Number(n) => out.push_str(n),
            Json::String(s) => out.push_str(&s.raw),
            Json::Array(_, Span(Some(raw))) | Json::Object(_, Span(Some(raw)))
                if indent.is_some() && parse(raw).is_ok_and(|v| v.identical(self)) =>
            {
                out.push_str(raw);
            }
            Json::Array(items, _) if items.is_empty() => out.push_str("[]"),
            Json::Object(entries, _) if entries.is_empty() => out.push_str("{}"),
            Json::Array(items, _) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, depth + 1);
                    item.write(out, indent, depth + 1);
                }
                newline(out, depth);
                out.push(']');
            }
            Json::Object(entries, _) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, depth + 1);
                    out.push_str(&key.raw);
                    out.push_str(if indent.is_some() { ": " } else { ":" });
                    value.write(out, indent, depth + 1);
                }
                newline(out, depth);
                out.push('}');
            }
        }
    }
}

/// How a file was laid out: indent unit, line ending, final newline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Style {
    indent: String,
    crlf: bool,
    final_newline: bool,
}

impl Default for Style {
    /// Two spaces and a final newline, as Claude Code and Codex write their files.
    fn default() -> Style {
        Style {
            indent: "  ".to_owned(),
            crlf: false,
            final_newline: true,
        }
    }
}

impl Style {
    pub(crate) fn of(text: &str) -> Style {
        let indent = text
            .split('\n')
            .skip(1)
            .find_map(|line| {
                let ws = &line[..line.len() - line.trim_start_matches([' ', '\t']).len()];
                let rest = &line[ws.len()..];
                (!ws.is_empty() && !rest.trim().is_empty()).then_some(ws)
            })
            .map_or_else(
                || "  ".to_owned(),
                |ws| {
                    if ws.starts_with('\t') {
                        "\t".to_owned()
                    } else {
                        " ".repeat(ws.len().min(8))
                    }
                },
            );
        Style {
            indent,
            crlf: text.contains("\r\n"),
            final_newline: text.trim_end_matches([' ', '\t']).ends_with('\n')
                || text.trim().is_empty(),
        }
    }
}

/// Parses strict JSON (RFC 8259): no comments, trailing commas, byte order mark or duplicate
/// keys. The error says what is wrong and where (`line L, column C`).
pub(crate) fn parse(text: &str) -> Result<Json, String> {
    let mut p = Parser { text, pos: 0 };
    p.ws();
    let value = p.value(0)?;
    p.ws();
    if p.pos < text.len() {
        return Err(p.error("unexpected text after the JSON value"));
    }
    Ok(value)
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn error(&self, what: &str) -> String {
        let before = &self.text[..self.pos];
        let line = before.matches('\n').count() + 1;
        let column = before.rsplit('\n').next().unwrap_or("").chars().count() + 1;
        format!("{what} (line {line}, column {column})")
    }

    fn span(&self, start: usize) -> Span {
        Span(Some(self.text[start..self.pos].to_owned()))
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8, what: &str) -> Result<(), String> {
        self.ws();
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.error(what))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        self.ws();
        match self.peek() {
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => self.string().map(Json::String),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(b'/') => Err(self.error("comments are not allowed")),
            _ => {
                for (word, value) in [
                    ("true", Json::Bool(true)),
                    ("false", Json::Bool(false)),
                    ("null", Json::Null),
                ] {
                    if self.text[self.pos..].starts_with(word) {
                        self.pos += word.len();
                        return Ok(value);
                    }
                }
                Err(
                    self.error(if self.text.starts_with('\u{feff}') && self.pos == 0 {
                        "a byte order mark is not allowed"
                    } else {
                        "expected a JSON value"
                    }),
                )
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err(self.error("nested too deeply"));
        }
        let start = self.pos;
        self.pos += 1;
        let mut entries: Vec<(Str, Json)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Object(entries, self.span(start)));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(self.error("expected a string key"));
            }
            let at = self.pos;
            let key = self.string()?;
            if entries.iter().any(|(k, _)| k.value == key.value) {
                self.pos = at;
                return Err(self.error(&format!("duplicate key {}", key.raw)));
            }
            self.expect(b':', "expected ':'")?;
            let value = self.value(depth)?;
            entries.push((key, value));
            self.ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Object(entries, self.span(start)));
                }
                _ => return Err(self.error("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err(self.error("nested too deeply"));
        }
        let start = self.pos;
        self.pos += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Array(items, self.span(start)));
        }
        loop {
            items.push(self.value(depth)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Array(items, self.span(start)));
                }
                _ => return Err(self.error("expected ',' or ']'")),
            }
        }
    }

    fn string(&mut self) -> Result<Str, String> {
        let start = self.pos;
        let bytes = self.text.as_bytes();
        let mut i = start + 1;
        loop {
            match bytes.get(i) {
                None => return Err(self.error("unterminated string")),
                Some(b'"') => break,
                Some(b'\\') => i += 2,
                Some(_) => i += 1,
            }
        }
        let raw = &self.text[start..=i];
        let value =
            serde_json::from_str::<String>(raw).map_err(|_| self.error("invalid string"))?;
        self.pos = i + 1;
        Ok(Str {
            raw: raw.to_owned(),
            value,
        })
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        let digits = |p: &mut Parser| {
            let from = p.pos;
            while matches!(p.peek(), Some(b'0'..=b'9')) {
                p.pos += 1;
            }
            p.pos > from
        };
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        if self.peek() == Some(b'0') {
            self.pos += 1;
        } else if !digits(self) {
            return Err(self.error("invalid number"));
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !digits(self) {
                return Err(self.error("invalid number"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !digits(self) {
                return Err(self.error("invalid number"));
            }
        }
        if matches!(self.peek(), Some(b'0'..=b'9')) {
            return Err(self.error("invalid number"));
        }
        Ok(Json::Number(self.text[start..self.pos].to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_order_escapes_and_numbers() {
        let text = "{\n  \"z\": 1.50,\n  \"a\": \"\\u00e9\\/\",\n  \"m\": [true, null, -0, 2E+3],\n  \"e\": {}\n}\n";
        let v = parse(text).unwrap();
        assert_eq!(
            v.pretty(&Style::of(text)),
            "{\n  \"z\": 1.50,\n  \"a\": \"\\u00e9\\/\",\n  \"m\": [true, null, -0, 2E+3],\n  \"e\": {}\n}\n"
        );
        assert_eq!(v.get("a").unwrap().as_str(), Some("é/"));
        assert_eq!(
            v.compact(),
            r#"{"z":1.50,"a":"\u00e9\/","m":[true,null,-0,2E+3],"e":{}}"#
        );
    }

    #[test]
    fn style_follows_the_file() {
        let tabs = "{\r\n\t\"a\": [\r\n\t\t1\r\n\t]\r\n}";
        let v = parse(tabs).unwrap();
        assert_eq!(v.pretty(&Style::of(tabs)), tabs);
        let four = "{\n    \"a\": 1\n}\n";
        assert_eq!(parse(four).unwrap().pretty(&Style::of(four)), four);
        assert_eq!(
            Style::of("{}"),
            Style {
                final_newline: false,
                ..Style::default()
            }
        );
        assert_eq!(Style::of(""), Style::default());
    }

    #[test]
    fn refuses_what_is_not_strict_json() {
        for (text, why) in [
            ("{\"a\": 1,}", "expected a string key (line 1, column 9)"),
            (
                "{\"a\": 1, \"a\": 2}",
                "duplicate key \"a\" (line 1, column 10)",
            ),
            ("{\"a\": 1, \"\\u0061\": 2}", "duplicate key \"\\u0061\""),
            ("// hi\n{}", "comments are not allowed (line 1, column 1)"),
            (
                "{\n  \"a\": 1 // x\n}",
                "expected ',' or '}' (line 2, column 10)",
            ),
            ("\u{feff}{}", "a byte order mark is not allowed"),
            ("{} {}", "unexpected text after the JSON value"),
            ("[01]", "invalid number"),
            ("[1.]", "invalid number"),
            ("[\"a\tb\"]", "invalid string"),
            ("[\"\\x\"]", "invalid string"),
            ("\"abc", "unterminated string"),
            ("", "expected a JSON value"),
            ("[tru]", "expected a JSON value"),
        ] {
            let err = parse(text).unwrap_err();
            assert!(err.contains(why), "{text:?}: {err}");
        }
        let deep = "[".repeat(MAX_DEPTH + 1);
        assert!(parse(&deep).unwrap_err().contains("nested too deeply"));
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(&ok).is_ok());
    }

    #[test]
    fn same_ignores_key_order_and_escapes() {
        let a = parse(r#"{"x": "\u0041", "y": [1, {"p": null, "q": true}]}"#).unwrap();
        let b = parse(r#"{"y": [1, {"q": true, "p": null}], "x": "A"}"#).unwrap();
        assert!(a.same(&b));
        let c = parse(r#"{"y": [1, {"q": true}], "x": "A"}"#).unwrap();
        assert!(!a.same(&c));
        assert!(!parse("1").unwrap().same(&parse("1.0").unwrap()));
    }

    #[test]
    fn untouched_containers_keep_mixed_line_endings() {
        // Written mostly with CRLF, one array with LF: an edit elsewhere leaves both alone.
        let text = "{\r\n  \"a\": [\n    1\n  ],\r\n  \"b\": {\r\n    \"c\": 2\r\n  },\r\n  \"d\": 3\r\n}\r\n";
        let mut v = parse(text).unwrap();
        assert_eq!(v.pretty(&Style::of(text)), text);
        let Json::Object(entries, _) = &mut v else {
            panic!()
        };
        entries[2].1 = Json::Number("4".to_owned());
        assert_eq!(
            v.pretty(&Style::of(text)),
            "{\r\n  \"a\": [\n    1\n  ],\r\n  \"b\": {\r\n    \"c\": 2\r\n  },\r\n  \"d\": 4\r\n}\r\n"
        );
    }
}
