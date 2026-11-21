use thiserror::Error;

/// Errors of the pure domain rules. `mwf-app` maps them to CLI error codes (docs/cli.md).
///
/// Messages never contain the rejected input (field name, line and expected form only), so a
/// credential pasted into the wrong place is not echoed back by the CLI or lint (ADR 0025).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DomainError {
    /// `INVALID_SLUG`.
    #[error("invalid slug: use one or more of a-z, 0-9 and -")]
    InvalidSlug,
    /// `INVALID_FIELD`: a frontmatter field is missing or has a bad value.
    #[error("invalid frontmatter field `{field}`: {reason}")]
    InvalidField { field: String, reason: String },
    /// `INVALID_FIELD`: the frontmatter block itself is malformed (ADR 0032 subset).
    #[error("invalid frontmatter at line {line}: {reason}")]
    Frontmatter { line: usize, reason: String },
    /// A timestamp that is not `YYYY-MM-DDTHH:MM:SSZ`.
    #[error("invalid timestamp: expected a real UTC time as YYYY-MM-DDTHH:MM:SSZ")]
    InvalidTimestamp,
    /// `Timestamp::from_unix_secs` past 9999-12-31T23:59:59Z.
    #[error("unix time {0} is after year 9999")]
    TimestampOutOfRange(u64),
    /// `PATCH_NO_MATCH`.
    #[error("old text not found in the page body")]
    PatchNoMatch,
    /// `PATCH_AMBIGUOUS`: `old` occurs at more than one position (overlaps count).
    #[error("old text matches {matches} places; include more context so it matches once")]
    PatchAmbiguous { matches: usize },
}

pub(crate) fn field(field: &str, reason: impl Into<String>) -> DomainError {
    DomainError::InvalidField {
        field: field.to_owned(),
        reason: reason.into(),
    }
}
