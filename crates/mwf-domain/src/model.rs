use std::fmt;
use std::str::FromStr;

use sha2::{Digest, Sha256};

use crate::error::{DomainError, field};

/// Page identifier: file name without `.md` and link target. Non-empty, only `[a-z0-9-]` (ADR 0017).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Slug(String);

impl Slug {
    pub fn parse(s: &str) -> Result<Slug, DomainError> {
        let valid = !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if valid {
            Ok(Slug(s.to_owned()))
        } else {
            Err(DomainError::InvalidSlug)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Slug {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Page type. Declaration order is the `index.md` group order (ADR 0027).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PageType {
    Preference,
    Decision,
    Knowledge,
    Incident,
    Task,
}

impl PageType {
    /// All types in `index.md` group order.
    pub const ALL: [PageType; 5] = [
        PageType::Preference,
        PageType::Decision,
        PageType::Knowledge,
        PageType::Incident,
        PageType::Task,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PageType::Preference => "preference",
            PageType::Decision => "decision",
            PageType::Knowledge => "knowledge",
            PageType::Incident => "incident",
            PageType::Task => "task",
        }
    }
}

impl FromStr for PageType {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        PageType::ALL
            .into_iter()
            .find(|t| t.as_str() == s)
            .ok_or_else(|| {
                field(
                    "type",
                    "must be one of preference, decision, knowledge, incident, task",
                )
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
    Active,
    Archived,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Archived => "archived",
        }
    }
}

impl FromStr for Status {
    type Err = DomainError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "active" => Ok(Status::Active),
            "archived" => Ok(Status::Archived),
            _ => Err(field("status", "must be one of active, archived")),
        }
    }
}

/// RFC3339 UTC timestamp with second precision, `YYYY-MM-DDTHH:MM:SSZ`, supplied by the caller
/// (ADR 0043). The fixed format makes the derived `Ord` chronological.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(String);

const SECS_PER_DAY: i64 = 86_400;
/// Unix time of 9999-12-31T23:59:59Z, the last instant with a four-digit year.
const MAX_UNIX_SECS: u64 = 253_402_300_799;

impl Timestamp {
    /// Accepts exactly `YYYY-MM-DDTHH:MM:SSZ` with a real calendar date.
    pub fn parse(s: &str) -> Result<Timestamp, DomainError> {
        let bad = || DomainError::InvalidTimestamp;
        let b = s.as_bytes();
        let shape = b.len() == 20
            && b.iter().enumerate().all(|(i, &c)| match i {
                4 | 7 => c == b'-',
                10 => c == b'T',
                13 | 16 => c == b':',
                19 => c == b'Z',
                _ => c.is_ascii_digit(),
            });
        if !shape {
            return Err(bad());
        }
        let num = |from, to| digits(b, from, to);
        let (year, month, day) = (num(0, 4), num(5, 7), num(8, 10));
        let (hour, minute, second) = (num(11, 13), num(14, 16), num(17, 19));
        let valid = (1..=12).contains(&month)
            && (1..=days_in_month(year, month)).contains(&day)
            && hour < 24
            && minute < 60
            && second < 60;
        if valid {
            Ok(Timestamp(s.to_owned()))
        } else {
            Err(bad())
        }
    }

    /// Converts Unix seconds to RFC3339 UTC without a time library (ADR 0046).
    pub fn from_unix_secs(secs: u64) -> Result<Timestamp, DomainError> {
        if secs > MAX_UNIX_SECS {
            return Err(DomainError::TimestampOutOfRange(secs));
        }
        // Lossless: checked against MAX_UNIX_SECS above.
        let secs = secs as i64;
        let (year, month, day) = civil_from_days(secs.div_euclid(SECS_PER_DAY));
        let rem = secs.rem_euclid(SECS_PER_DAY);
        Ok(Timestamp(format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Seconds since the Unix epoch; negative before 1970.
    pub(crate) fn unix_secs(&self) -> i64 {
        let num = |from, to| digits(self.0.as_bytes(), from, to);
        days_from_civil(num(0, 4), num(5, 7), num(8, 10)) * SECS_PER_DAY
            + num(11, 13) * 3600
            + num(14, 16) * 60
            + num(17, 19)
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// The decimal number in `b[from..to]`, which the caller has checked is ASCII digits.
fn digits(b: &[u8], from: usize, to: usize) -> i64 {
    b[from..to]
        .iter()
        .fold(0, |n, &c| n * 10 + i64::from(c - b'0'))
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// Howard Hinnant's `days_from_civil` / `civil_from_days` (proleptic Gregorian calendar).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Maximum `summary` length in characters (ADR 0027).
pub const SUMMARY_MAX_CHARS: usize = 120;

/// Page frontmatter (ADRs 0017, 0027, 0032). Construct freely, then [`Frontmatter::check`]
/// before writing; [`crate::parse_page`] only returns frontmatter that passes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frontmatter {
    pub title: String,
    pub page_type: PageType,
    pub summary: String,
    pub tags: Vec<String>,
    pub status: Status,
    pub created: Timestamp,
    pub updated: Timestamp,
}

impl Frontmatter {
    /// Field rules: `title` and `summary` are non-empty single lines without surrounding
    /// whitespace or control characters, `summary` has at most 120 characters, and every tag
    /// follows the same text rule. Enum and timestamp fields are valid by construction.
    pub fn check(&self) -> Result<(), DomainError> {
        check_text("title", &self.title)?;
        check_text("summary", &self.summary)?;
        let chars = self.summary.chars().count();
        if chars > SUMMARY_MAX_CHARS {
            return Err(field(
                "summary",
                format!("{chars} characters; the limit is {SUMMARY_MAX_CHARS}"),
            ));
        }
        for tag in &self.tags {
            check_text("tags", tag)?;
        }
        Ok(())
    }
}

fn check_text(name: &str, value: &str) -> Result<(), DomainError> {
    if value.is_empty() {
        return Err(field(name, "must not be empty"));
    }
    if value.chars().any(char::is_control) {
        return Err(field(name, "must be one line without control characters"));
    }
    if value.trim() != value {
        return Err(field(name, "must not start or end with whitespace"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub slug: Slug,
    pub fm: Frontmatter,
    pub body: String,
}

/// Write-conflict token: the first 12 hex characters of the SHA-256 of the file content (ADR 0023).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Rev(String);

impl Rev {
    pub fn of(content: &[u8]) -> Rev {
        let digest = Sha256::digest(content);
        let hex: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
        Rev(hex)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Rev {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_accepts_only_lowercase_digits_and_hyphen() {
        for ok in ["a", "use-bm25", "0032", "-", "a--b"] {
            assert_eq!(Slug::parse(ok).unwrap().as_str(), ok);
        }
        for bad in ["", "Use", "a_b", "a b", "a.md", "über", "a/b"] {
            assert_eq!(Slug::parse(bad), Err(DomainError::InvalidSlug));
        }
    }

    #[test]
    fn page_type_order_is_index_group_order() {
        let mut types = vec![
            PageType::Task,
            PageType::Incident,
            PageType::Knowledge,
            PageType::Decision,
            PageType::Preference,
        ];
        types.sort();
        assert_eq!(types, PageType::ALL);
        for t in PageType::ALL {
            assert_eq!(t.as_str().parse::<PageType>().unwrap(), t);
        }
        assert!("Decision".parse::<PageType>().is_err());
        assert!("archived".parse::<Status>().is_ok());
        assert!("deleted".parse::<Status>().is_err());
    }

    #[test]
    fn from_unix_secs_matches_known_instants() {
        let cases = [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (1_709_251_199, "2024-02-29T23:59:59Z"),
            (1_795_168_800, "2026-11-20T10:00:00Z"),
            (4_107_542_400, "2100-03-01T00:00:00Z"),
            (MAX_UNIX_SECS, "9999-12-31T23:59:59Z"),
        ];
        for (secs, text) in cases {
            let ts = Timestamp::from_unix_secs(secs).unwrap();
            assert_eq!(ts.as_str(), text);
            assert_eq!(Timestamp::parse(text).unwrap(), ts);
            assert_eq!(ts.unix_secs(), secs as i64);
        }
        assert_eq!(
            Timestamp::from_unix_secs(MAX_UNIX_SECS + 1),
            Err(DomainError::TimestampOutOfRange(MAX_UNIX_SECS + 1))
        );
    }

    #[test]
    fn from_unix_secs_round_trips_every_day_boundary() {
        // Every day from 1970 to 2401 (two 400-year cycles' worth of leap rules).
        let mut prev: Option<Timestamp> = None;
        for day in 0..157_000u64 {
            let ts = Timestamp::from_unix_secs(day * 86_400 + 86_399).unwrap();
            assert_eq!(Timestamp::parse(ts.as_str()).unwrap(), ts);
            assert_eq!(ts.unix_secs(), (day * 86_400 + 86_399) as i64);
            if let Some(p) = prev {
                assert!(p < ts);
            }
            prev = Some(ts);
        }
    }

    #[test]
    fn timestamp_parse_rejects_bad_shapes_and_dates() {
        for bad in [
            "",
            "2026-11-20",
            "2026-11-20T10:00:00",
            "2026-11-20T10:00:00+00:00",
            "2026-11-20t10:00:00Z",
            "2026-11-20T10:00:00.5Z",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2023-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-11-20T24:00:00Z",
            "2026-11-20T10:60:00Z",
            "2026-11-20T10:00:60Z",
            "２026-11-20T10:00:00Z",
        ] {
            assert!(Timestamp::parse(bad).is_err(), "{bad:?}");
        }
        assert!(Timestamp::parse("2000-02-29T00:00:00Z").is_ok());
    }

    #[test]
    fn rev_is_first_12_hex_of_sha256() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        assert_eq!(Rev::of(b"abc").as_str(), "ba7816bf8f01");
        // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        assert_eq!(Rev::of(b"").as_str(), "e3b0c44298fc");
    }

    fn fm() -> Frontmatter {
        Frontmatter {
            title: "Use BM25".into(),
            page_type: PageType::Decision,
            summary: "s".into(),
            tags: vec![],
            status: Status::Active,
            created: Timestamp::parse("2026-11-20T10:00:00Z").unwrap(),
            updated: Timestamp::parse("2026-11-20T10:00:00Z").unwrap(),
        }
    }

    #[test]
    fn frontmatter_check_rules() {
        assert_eq!(fm().check(), Ok(()));
        let field_of = |f: Frontmatter| match f.check() {
            Err(DomainError::InvalidField { field, .. }) => field,
            other => panic!("expected InvalidField, got {other:?}"),
        };
        assert_eq!(
            field_of(Frontmatter {
                title: String::new(),
                ..fm()
            }),
            "title"
        );
        assert_eq!(
            field_of(Frontmatter {
                title: "a\nb".into(),
                ..fm()
            }),
            "title"
        );
        assert_eq!(
            field_of(Frontmatter {
                title: " a".into(),
                ..fm()
            }),
            "title"
        );
        assert_eq!(
            field_of(Frontmatter {
                summary: String::new(),
                ..fm()
            }),
            "summary"
        );
        assert_eq!(
            field_of(Frontmatter {
                summary: "a\tb".into(),
                ..fm()
            }),
            "summary"
        );
        assert_eq!(
            field_of(Frontmatter {
                tags: vec![String::new()],
                ..fm()
            }),
            "tags"
        );
        // The limit counts characters, not bytes.
        let at_limit = "é".repeat(SUMMARY_MAX_CHARS);
        assert_eq!(
            Frontmatter {
                summary: at_limit.clone(),
                ..fm()
            }
            .check(),
            Ok(())
        );
        let over = format!("{at_limit}a");
        assert_eq!(
            field_of(Frontmatter {
                summary: over,
                ..fm()
            }),
            "summary"
        );
    }
}
