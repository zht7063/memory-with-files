//! Secret scanning before writes and in lint (ADR 0025). The rules are those of 1.x
//! (`src/core/secrets.ts` on `main`): well-known credential formats plus `name = value`
//! assignments whose value looks random. Findings carry only the rule, line and a redacted
//! sample, never the matched text.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// A likely secret. `line` is 1-based; `redacted` is the first 4 characters and the length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretFinding {
    pub rule: &'static str,
    pub line: usize,
    pub redacted: String,
}

struct Rule {
    id: &'static str,
    re: Regex,
    accept: Option<fn(&str) -> bool>,
}

/// Rule id, pattern, and the optional check on capture group 1.
type RuleSource = (&'static str, &'static str, Option<fn(&str) -> bool>);

const RULE_SOURCES: [RuleSource; 19] = [
    (
        "private-key",
        r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----",
        None,
    ),
    (
        "aws-access-key-id",
        r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b",
        None,
    ),
    (
        "aws-secret-access-key",
        r#"(?i)aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40,})"#,
        // The regex crate has no lookahead: take the whole run and require exactly 40.
        Some(|v| v.len() == 40),
    ),
    ("github-token", r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b", None),
    (
        "github-fine-grained-token",
        r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b",
        None,
    ),
    ("gitlab-token", r"\bglpat-[A-Za-z0-9_-]{20,}\b", None),
    ("slack-token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b", None),
    (
        "slack-webhook",
        r"https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+",
        None,
    ),
    ("stripe-key", r"\b[sr]k_live_[A-Za-z0-9]{16,}\b", None),
    ("anthropic-key", r"\bsk-ant-[A-Za-z0-9_-]{20,}", None),
    (
        "openai-key",
        r"\bsk-(?:proj-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})",
        None,
    ),
    ("google-api-key", r"\bAIza[0-9A-Za-z_-]{35}\b", None),
    (
        "sendgrid-key",
        r"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b",
        None,
    ),
    ("npm-token", r"\bnpm_[A-Za-z0-9]{36}\b", None),
    ("huggingface-token", r"\bhf_[A-Za-z0-9]{34,}\b", None),
    (
        "jwt",
        r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        None,
    ),
    (
        "authorization-header",
        r#"(?i)authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{16,})"#,
        Some(looks_random),
    ),
    (
        "url-credentials",
        r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s:/@'"]+:([^\s:/@'"]{4,})@[^\s/'"]+"#,
        Some(|v| !is_placeholder(v) && !v.starts_with(['<', '{', '$', '*'])),
    ),
    (
        "secret-assignment",
        r#"(?i)\b[\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|private[_-]?key|access[_-]?key|credential)[\w.-]*["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=!@#$%^&*-]{16,})"#,
        Some(looks_random),
    ),
];

// Compiling a constant pattern cannot fail at run time except by a bug, which the
// `every_rule_compiles` test catches; library code may not panic (ADR 0043).
static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    RULE_SOURCES
        .iter()
        .filter_map(|&(id, src, accept)| Regex::new(src).ok().map(|re| Rule { id, re, accept }))
        .collect()
});

static PLACEHOLDER: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:x{4,}|\*{4,}|\.{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|%[A-Z_]+%|your[-_ ]?.*|example.*|changeme.*|change[-_]me.*|placeholder.*|redacted.*|dummy.*|sample.*|todo.*|none|null|secret|password|passwd|token|api[-_]?key)$",
    )
    .ok()
});

fn is_placeholder(v: &str) -> bool {
    PLACEHOLDER.as_ref().is_some_and(|re| re.is_match(v))
}

fn entropy(s: &str) -> f64 {
    let mut counts = std::collections::HashMap::<char, usize>::new();
    for c in s.chars() {
        *counts.entry(c).or_default() += 1;
    }
    let n = s.chars().count() as f64;
    counts
        .values()
        .map(|&k| {
            let p = k as f64 / n;
            -p * p.log2()
        })
        .sum()
}

fn looks_random(v: &str) -> bool {
    v.chars().count() >= 16
        && !is_placeholder(v)
        && v.chars().any(|c| c.is_ascii_alphabetic())
        && v.chars().any(|c| c.is_ascii_digit())
        && entropy(v) >= 3.3
}

/// Findings with the matched text, ordered by position.
fn scan(text: &str) -> Vec<(SecretFinding, &str)> {
    let mut found: Vec<(usize, SecretFinding, &str)> = Vec::new();
    for rule in RULES.iter() {
        for caps in rule.re.captures_iter(text) {
            let Some(m) = caps.get(0) else { continue };
            if let Some(accept) = rule.accept
                && !caps.get(1).is_some_and(|g| accept(g.as_str()))
            {
                continue;
            }
            let matched = m.as_str();
            let prefix: String = matched.chars().take(4).collect();
            found.push((
                m.start(),
                SecretFinding {
                    rule: rule.id,
                    line: text[..m.start()].matches('\n').count() + 1,
                    redacted: format!("{prefix}… ({} chars)", matched.chars().count()),
                },
                matched,
            ));
        }
    }
    found.sort_by_key(|(at, f, _)| (*at, f.rule));
    found.into_iter().map(|(_, f, m)| (f, m)).collect()
}

/// Every likely secret in `text` (lint of stored pages, ADR 0035).
pub fn scan_all(text: &str) -> Vec<SecretFinding> {
    scan(text).into_iter().map(|(f, _)| f).collect()
}

/// Likely secrets in `after` that were not already in `before` (same rule and same matched
/// text). Re-saving or trimming a page that already holds one stays possible (ADR 0025).
pub fn scan_added(before: &str, after: &str) -> Vec<SecretFinding> {
    let old: HashSet<(&str, &str)> = scan(before).into_iter().map(|(f, m)| (f.rule, m)).collect();
    scan(after)
        .into_iter()
        .filter(|(f, m)| !old.contains(&(f.rule, *m)))
        .map(|(f, _)| f)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Samples are assembled at run time so that the source holds no literal credential
    // (GitHub push protection scans file contents).
    fn j(parts: &[&str]) -> String {
        parts.concat()
    }

    const RAND36: &str = "Zq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAeYuI";

    fn rules(text: &str) -> Vec<&'static str> {
        scan_all(text).into_iter().map(|f| f.rule).collect()
    }

    #[test]
    fn every_rule_compiles() {
        assert_eq!(RULES.len(), RULE_SOURCES.len());
        assert!(PLACEHOLDER.is_some());
    }

    #[test]
    fn each_format_rule_matches_its_credential() {
        let cases: Vec<(&str, String)> = vec![
            ("private-key", j(&["-----BEGIN RSA ", "PRIVATE KEY-----"])),
            ("aws-access-key-id", j(&["AKIA", "Z7Q2M4N6P8R1T3V5"])),
            (
                "aws-secret-access-key",
                j(&[
                    "aws_secret_access_key = ",
                    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzq8xK2mN7p",
                ]),
            ),
            ("github-token", j(&["ghp", "_", RAND36])),
            (
                "github-fine-grained-token",
                j(&["github", "_pat_", "11ABCDEFG0123456789_abcdefghij"]),
            ),
            ("gitlab-token", j(&["glpat", "-", "Zq8xK2mN7pR4vT9wB3cD"])),
            ("slack-token", j(&["xoxb", "-", "1234567890-abcdefghij"])),
            (
                "slack-webhook",
                j(&[
                    "https://hooks.slack",
                    ".com/services/",
                    "T0ABCDEF/B0ABCDEF/",
                    "Zq8xK2mN7pR4",
                ]),
            ),
            ("stripe-key", j(&["sk_", "live_", "Zq8xK2mN7pR4vT9wB3cD"])),
            (
                "anthropic-key",
                j(&["sk-", "ant-", "api03-Zq8xK2mN7pR4vT9wB3cD"]),
            ),
            ("openai-key", j(&["sk-", "proj-", "Zq8xK2mN7pR4vT9wB3cD"])),
            (
                "google-api-key",
                j(&["AIza", "SyZq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAe"]),
            ),
            (
                "sendgrid-key",
                j(&[
                    "SG",
                    ".",
                    "Zq8xK2mN7pR4vT9wB3cD6f",
                    ".",
                    "Zq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAeYuIoPlMnBv",
                ]),
            ),
            ("npm-token", j(&["npm", "_", RAND36])),
            ("huggingface-token", j(&["hf", "_", RAND36])),
            (
                "jwt",
                j(&[
                    "eyJ",
                    "hbGciOiJIUzI1",
                    ".eyJ",
                    "zdWIiOiIxMjM0",
                    ".",
                    "SflKxwRJSMeKKF2QT4fw",
                ]),
            ),
            (
                "authorization-header",
                j(&["Authorization: Bearer ", "Zq8xK2mN7pR4vT9wB3cD"]),
            ),
            (
                "url-credentials",
                j(&["postgres://admin:", "Hunter2pass", "@db.internal:5432/app"]),
            ),
            (
                "secret-assignment",
                j(&["DB_PASSWORD=", "Zq8xK2mN7pR4vT9wB3cD"]),
            ),
        ];
        assert_eq!(cases.len(), RULE_SOURCES.len());
        for (rule, text) in cases {
            assert!(rules(&text).contains(&rule), "{rule}: {:?}", rules(&text));
        }
    }

    #[test]
    fn placeholders_and_low_entropy_values_are_ignored() {
        for text in [
            "api_key = your-api-key-goes-here",
            "token: xxxxxxxxxxxxxxxxxxxx",
            "password = <redacted-password>",
            "SECRET=${SECRET_FROM_VAULT_1234}",
            "api_key = aaaaaaaaaaaaaaaa1111",
            "api_key = abcdefghijklmnopqrst",
            "Authorization: Bearer <token-goes-here>",
            "postgres://admin:****@db/app",
            "postgres://admin:${PASS}@db/app",
            "postgres://admin:password@db/app",
            "see https://example.com/page and the token docs",
        ] {
            assert!(scan_all(text).is_empty(), "{text}: {:?}", scan_all(text));
        }
        // 41 characters after the key name is not an AWS secret (no lookahead in `regex`).
        let long = j(&["aws_secret_access_key: ", &"Ab1/".repeat(10), "Z"]);
        assert!(!rules(&long).contains(&"aws-secret-access-key"));
    }

    #[test]
    fn findings_are_redacted_ordered_and_have_line_numbers() {
        let key = j(&["npm", "_", RAND36]);
        let text = format!(
            "ok\nno\n\nfirst {key}\nthen {}\n",
            j(&["AKIA", "Z7Q2M4N6P8R1T3V5"])
        );
        let found = scan_all(&text);
        assert_eq!(
            found,
            [
                SecretFinding {
                    rule: "npm-token",
                    line: 4,
                    redacted: "npm_… (40 chars)".into()
                },
                SecretFinding {
                    rule: "aws-access-key-id",
                    line: 5,
                    redacted: "AKIA… (20 chars)".into()
                },
            ]
        );
        for f in &found {
            assert!(!f.redacted.contains(&key[4..]));
        }
    }

    #[test]
    fn scan_added_reports_only_new_secrets() {
        let a = j(&["ghp", "_", RAND36]);
        let b = j(&["npm", "_", RAND36]);
        let before = format!("old {a}\n");
        // Existing secret moved to another line: not new.
        assert!(scan_added(&before, &format!("intro\nstill {a}\n")).is_empty());
        // Removing it: nothing to report.
        assert!(scan_added(&before, "clean\n").is_empty());
        let added = scan_added(&before, &format!("old {a}\nnew {b}\n"));
        assert_eq!(added.len(), 1);
        assert_eq!((added[0].rule, added[0].line), ("npm-token", 2));
        // Same rule, different value: new.
        let other = j(&["ghp", "_", &RAND36.to_lowercase()]);
        assert_eq!(scan_added(&before, &other).len(), 1);
        assert_eq!(scan_added("", &a), scan_all(&a));
    }
}
