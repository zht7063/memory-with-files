//! `ErrorCode` and `AppError`: the only error type adapters see (ADR 0043, docs/cli.md).

use std::fmt;
use std::path::Path;

use mwf_domain::{DomainError, Slug};
use mwf_store::StoreError;
use serde::Serialize;
use serde_json::{Value, json};

/// Machine-readable error code, serialized as in docs/cli.md (`NOT_FOUND`, …). Every code
/// exits 1; `USAGE` (exit 2) belongs to the CLI's argument parser, not to `mwf-app`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotInitialized,
    NotGitRoot,
    AlreadyInitialized,
    NotFound,
    AlreadyExists,
    InvalidSlug,
    InvalidField,
    /// A stored page file does not parse (ADR 0049); `mwf lint` says why.
    InvalidPage,
    /// `.mwf/config.toml` is invalid (ADR 0049).
    InvalidConfig,
    RevMismatch,
    PatchNoMatch,
    PatchAmbiguous,
    SecretDetected,
    HasBacklinks,
    /// A body, or a `patch` old / new text, over [`crate::BODY_MAX_BYTES`] (ADRs 0033, 0049).
    TooLarge,
    LockTimeout,
    /// `.mwf` or `.mwf/.lock` was replaced while mwf used it (ADR 0048).
    Changed,
    /// A path under `.mwf/` is a symlink or the wrong kind of file (ADR 0048).
    WrongFileType,
    Io,
}

impl ErrorCode {
    pub const ALL: [ErrorCode; 19] = [
        ErrorCode::NotInitialized,
        ErrorCode::NotGitRoot,
        ErrorCode::AlreadyInitialized,
        ErrorCode::NotFound,
        ErrorCode::AlreadyExists,
        ErrorCode::InvalidSlug,
        ErrorCode::InvalidField,
        ErrorCode::InvalidPage,
        ErrorCode::InvalidConfig,
        ErrorCode::RevMismatch,
        ErrorCode::PatchNoMatch,
        ErrorCode::PatchAmbiguous,
        ErrorCode::SecretDetected,
        ErrorCode::HasBacklinks,
        ErrorCode::TooLarge,
        ErrorCode::LockTimeout,
        ErrorCode::Changed,
        ErrorCode::WrongFileType,
        ErrorCode::Io,
    ];

    /// The code as written in docs/cli.md and `--json` output.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotInitialized => "NOT_INITIALIZED",
            ErrorCode::NotGitRoot => "NOT_GIT_ROOT",
            ErrorCode::AlreadyInitialized => "ALREADY_INITIALIZED",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::AlreadyExists => "ALREADY_EXISTS",
            ErrorCode::InvalidSlug => "INVALID_SLUG",
            ErrorCode::InvalidField => "INVALID_FIELD",
            ErrorCode::InvalidPage => "INVALID_PAGE",
            ErrorCode::InvalidConfig => "INVALID_CONFIG",
            ErrorCode::RevMismatch => "REV_MISMATCH",
            ErrorCode::PatchNoMatch => "PATCH_NO_MATCH",
            ErrorCode::PatchAmbiguous => "PATCH_AMBIGUOUS",
            ErrorCode::SecretDetected => "SECRET_DETECTED",
            ErrorCode::HasBacklinks => "HAS_BACKLINKS",
            ErrorCode::TooLarge => "TOO_LARGE",
            ErrorCode::LockTimeout => "LOCK_TIMEOUT",
            ErrorCode::Changed => "CHANGED",
            ErrorCode::WrongFileType => "WRONG_FILE_TYPE",
            ErrorCode::Io => "IO",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An operation's failure: a code, a message for people, and structured details for `--json`
/// (`null` when there are none). Messages never contain rejected input or secret text (ADR 0025).
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

impl AppError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> AppError {
        AppError {
            code,
            message: message.into(),
            details: Value::Null,
        }
    }

    pub(crate) fn with(mut self, details: Value) -> AppError {
        self.details = details;
        self
    }

    pub(crate) fn not_found(slug: &Slug) -> AppError {
        let shown = crate::redact::slug(slug.as_str());
        AppError::new(ErrorCode::NotFound, format!("page {shown} does not exist"))
            .with(json!({ "slug": shown }))
    }

    pub(crate) fn invalid_page(slug: &Slug, reason: &str) -> AppError {
        AppError::new(
            ErrorCode::InvalidPage,
            format!(
                "pages/{}.md is not a valid page: {reason}; run `mwf lint`",
                crate::redact::slug(slug.as_str())
            ),
        )
        .with(json!({ "slug": crate::redact::slug(slug.as_str()) }))
    }

    pub(crate) fn field(field: &str, reason: &str) -> AppError {
        AppError::new(
            ErrorCode::InvalidField,
            format!("invalid field `{field}`: {reason}"),
        )
        .with(json!({ "field": field }))
    }
}

fn path(p: &Path) -> String {
    p.display().to_string()
}

impl From<StoreError> for AppError {
    fn from(e: StoreError) -> AppError {
        // The TOML parser's reason can quote the rejected value, which may be a pasted
        // credential, so config errors get a fixed message (ADRs 0025, 0049).
        let message = match &e {
            StoreError::Config { path: p, .. } => format!(
                "{} is not a valid mwf config (TOML syntax, an unknown key, or a value of the wrong type); compare it with the defaults that `mwf init` writes",
                path(p)
            ),
            _ => e.to_string(),
        };
        let (code, details) = match &e {
            StoreError::NotInitialized { start } => {
                (ErrorCode::NotInitialized, json!({ "start": path(start) }))
            }
            StoreError::NotGitRoot { path: p, git_root } => (
                ErrorCode::NotGitRoot,
                json!({ "path": path(p), "git_root": git_root.as_deref().map(path) }),
            ),
            StoreError::AlreadyInitialized { path: p } => {
                (ErrorCode::AlreadyInitialized, json!({ "path": path(p) }))
            }
            StoreError::LockTimeout { path: p, waited } => (
                ErrorCode::LockTimeout,
                json!({
                    "path": path(p),
                    "waited_ms": u64::try_from(waited.as_millis()).unwrap_or(u64::MAX),
                }),
            ),
            StoreError::Config { path: p, .. } => {
                (ErrorCode::InvalidConfig, json!({ "path": path(p) }))
            }
            StoreError::PageNotFound { slug } => {
                (ErrorCode::NotFound, json!({ "slug": slug.as_str() }))
            }
            StoreError::PageExists { slug } => {
                (ErrorCode::AlreadyExists, json!({ "slug": slug.as_str() }))
            }
            StoreError::WrongFileType { path: p, expected } => (
                ErrorCode::WrongFileType,
                json!({ "path": path(p), "expected": expected }),
            ),
            StoreError::Changed { path: p } => (ErrorCode::Changed, json!({ "path": path(p) })),
            StoreError::Io { path: p, .. } => (ErrorCode::Io, json!({ "path": path(p) })),
        };
        // Store messages and details carry paths, which can hold a secret-looking slug.
        if crate::redact::looks_secret(&message) {
            return AppError::new(
                code,
                format!("{code}: details withheld because a path looks like a secret"),
            );
        }
        AppError {
            code,
            message,
            details,
        }
    }
}

/// Domain errors from user input (slugs, fields, patches). Errors from a page already on disk
/// go through [`AppError::invalid_page`] instead.
impl From<DomainError> for AppError {
    fn from(e: DomainError) -> AppError {
        let message = e.to_string();
        let (code, details) = match &e {
            DomainError::InvalidSlug => (ErrorCode::InvalidSlug, Value::Null),
            DomainError::InvalidField { field, .. } => {
                (ErrorCode::InvalidField, json!({ "field": field }))
            }
            DomainError::Frontmatter { line, .. } => {
                (ErrorCode::InvalidField, json!({ "line": line }))
            }
            DomainError::PatchNoMatch => (ErrorCode::PatchNoMatch, Value::Null),
            DomainError::PatchAmbiguous { matches } => {
                (ErrorCode::PatchAmbiguous, json!({ "matches": matches }))
            }
            // Only the clock produces timestamps outside user input.
            DomainError::InvalidTimestamp | DomainError::TimestampOutOfRange(_) => {
                (ErrorCode::Io, Value::Null)
            }
        };
        AppError {
            code,
            message,
            details,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;

    fn p() -> PathBuf {
        PathBuf::from("/r/.mwf")
    }

    #[test]
    fn store_errors_map_to_codes() {
        let slug = Slug::parse("a").unwrap();
        let cases = [
            (
                StoreError::NotInitialized { start: p() },
                ErrorCode::NotInitialized,
            ),
            (
                StoreError::NotGitRoot {
                    path: p(),
                    git_root: Some(PathBuf::from("/r")),
                },
                ErrorCode::NotGitRoot,
            ),
            (
                StoreError::AlreadyInitialized { path: p() },
                ErrorCode::AlreadyInitialized,
            ),
            (
                StoreError::LockTimeout {
                    path: p(),
                    waited: Duration::from_secs(2),
                },
                ErrorCode::LockTimeout,
            ),
            (
                StoreError::Config {
                    path: p(),
                    message: "unknown field".into(),
                },
                ErrorCode::InvalidConfig,
            ),
            (
                StoreError::PageNotFound { slug: slug.clone() },
                ErrorCode::NotFound,
            ),
            (StoreError::PageExists { slug }, ErrorCode::AlreadyExists),
            (
                StoreError::WrongFileType {
                    path: p(),
                    expected: "directory",
                },
                ErrorCode::WrongFileType,
            ),
            (StoreError::Changed { path: p() }, ErrorCode::Changed),
            (
                StoreError::Io {
                    path: p(),
                    source: io::Error::other("disk"),
                },
                ErrorCode::Io,
            ),
        ];
        for (e, code) in cases {
            let is_config = matches!(e, StoreError::Config { .. });
            let message = e.to_string();
            let app = AppError::from(e);
            assert_eq!(app.code, code);
            if is_config {
                assert!(!app.message.contains("unknown field"), "{}", app.message);
            } else {
                assert_eq!(app.message, message);
            }
        }
        let e = AppError::from(StoreError::NotGitRoot {
            path: p(),
            git_root: Some(PathBuf::from("/r")),
        });
        assert_eq!(e.details["git_root"], "/r");
        let e = AppError::from(StoreError::LockTimeout {
            path: p(),
            waited: Duration::from_secs(2),
        });
        assert_eq!(e.details["waited_ms"], 2000);
    }

    #[test]
    fn domain_errors_map_to_codes() {
        let cases = [
            (DomainError::InvalidSlug, ErrorCode::InvalidSlug),
            (
                DomainError::InvalidField {
                    field: "type".into(),
                    reason: "r".into(),
                },
                ErrorCode::InvalidField,
            ),
            (
                DomainError::Frontmatter {
                    line: 3,
                    reason: "r".into(),
                },
                ErrorCode::InvalidField,
            ),
            (DomainError::PatchNoMatch, ErrorCode::PatchNoMatch),
            (
                DomainError::PatchAmbiguous { matches: 2 },
                ErrorCode::PatchAmbiguous,
            ),
            (DomainError::InvalidTimestamp, ErrorCode::Io),
            (DomainError::TimestampOutOfRange(u64::MAX), ErrorCode::Io),
        ];
        for (e, code) in cases {
            assert_eq!(AppError::from(e).code, code);
        }
    }

    #[test]
    fn codes_are_unique_screaming_snake_case() {
        let mut seen = std::collections::HashSet::new();
        for c in ErrorCode::ALL {
            let s = c.as_str();
            assert!(seen.insert(s), "{s}");
            assert!(
                s.bytes().all(|b| b.is_ascii_uppercase() || b == b'_'),
                "{s}"
            );
            assert_eq!(c.to_string(), s);
        }
    }
}
