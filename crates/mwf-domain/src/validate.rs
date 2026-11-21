//! The lint rules that need only one page file (ADR 0035). Rules that need the whole corpus
//! (dangling links, orphans, `index.md` drift, `possible_duplicate`) are composed in `mwf-app`
//! from [`crate::internal_links`], [`crate::render_index`] and `mwf-search`.

use crate::frontmatter::parse_frontmatter;
use crate::model::{PageType, Slug, Status, Timestamp};
use crate::secrets::scan_all;

/// An `active` `task` page not updated for this many days gets `stale_task`.
pub const STALE_TASK_DAYS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Warning,
    Error,
}

/// A lint finding for one page. `rule` is one of `invalid_slug`, `invalid_frontmatter`,
/// `secret`, `stale_task`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub rule: &'static str,
    pub severity: Severity,
    pub message: String,
}

/// Checks the page file `<file_stem>.md` with content `text`. `now` is supplied by the caller
/// (ADR 0043). Secret messages carry only the rule, line and redacted sample (ADR 0025).
pub fn validate(file_stem: &str, text: &str, now: &Timestamp) -> Vec<Issue> {
    let mut issues = Vec::new();
    let mut push = |rule, severity, message: String| {
        issues.push(Issue {
            rule,
            severity,
            message,
        })
    };
    if let Err(e) = Slug::parse(file_stem) {
        push("invalid_slug", Severity::Error, e.to_string());
    }
    match parse_frontmatter(text) {
        Err(e) => push("invalid_frontmatter", Severity::Error, e.to_string()),
        Ok((fm, _)) => {
            let days = (now.unix_secs() - fm.updated.unix_secs()) / 86_400;
            if fm.page_type == PageType::Task
                && fm.status == Status::Active
                && days >= STALE_TASK_DAYS
            {
                push(
                    "stale_task",
                    Severity::Warning,
                    format!(
                        "active task not updated for {days} days (since {})",
                        fm.updated
                    ),
                );
            }
        }
    }
    for f in scan_all(text) {
        push(
            "secret",
            Severity::Error,
            format!(
                "likely secret ({}) at line {}: {}",
                f.rule, f.line, f.redacted
            ),
        );
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(page_type: &str, status: &str, updated: &str, body: &str) -> String {
        format!(
            "---\ntitle: t\ntype: {page_type}\nsummary: s\nstatus: {status}\ncreated: 2026-01-01T00:00:00Z\nupdated: {updated}\n---\n{body}"
        )
    }

    fn now() -> Timestamp {
        Timestamp::parse("2026-11-21T00:00:00Z").unwrap()
    }

    fn rules(stem: &str, text: &str) -> Vec<(&'static str, Severity)> {
        validate(stem, text, &now())
            .into_iter()
            .map(|i| (i.rule, i.severity))
            .collect()
    }

    #[test]
    fn valid_page_has_no_issues() {
        assert_eq!(
            rules(
                "ok",
                &page("decision", "active", "2020-01-01T00:00:00Z", "b\n")
            ),
            []
        );
    }

    #[test]
    fn invalid_slug_and_frontmatter_are_errors() {
        let good = page("decision", "active", "2026-11-20T00:00:00Z", "");
        assert_eq!(
            rules("Bad_Name", &good),
            [("invalid_slug", Severity::Error)]
        );
        assert_eq!(
            rules("ok", &page("note", "active", "2026-11-20T00:00:00Z", "")),
            [("invalid_frontmatter", Severity::Error)]
        );
        assert_eq!(
            rules("ok", "no frontmatter"),
            [("invalid_frontmatter", Severity::Error)]
        );
    }

    #[test]
    fn stale_task_boundary_at_30_days() {
        // 2026-10-22 is exactly 30 days before `now`; 2026-10-22T00:00:01Z is 29 days and change.
        let stale = page("task", "active", "2026-10-22T00:00:00Z", "");
        assert_eq!(rules("t", &stale), [("stale_task", Severity::Warning)]);
        assert_eq!(
            rules("t", &page("task", "active", "2026-10-22T00:00:01Z", "")),
            []
        );
        assert_eq!(
            rules("t", &page("task", "archived", "2020-01-01T00:00:00Z", "")),
            []
        );
        assert_eq!(
            rules(
                "t",
                &page("knowledge", "active", "2020-01-01T00:00:00Z", "")
            ),
            []
        );
    }

    #[test]
    fn stored_secret_is_an_error_without_the_value() {
        let key = ["npm", "_", "Zq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAeYuI"].concat();
        let text = page(
            "knowledge",
            "active",
            "2026-11-20T00:00:00Z",
            &format!("x\n{key}\n"),
        );
        let issues = validate("k", &text, &now());
        assert_eq!(issues.len(), 1);
        assert_eq!(
            (issues[0].rule, issues[0].severity),
            ("secret", Severity::Error)
        );
        assert!(
            issues[0].message.contains("line 10"),
            "{}",
            issues[0].message
        );
        assert!(!issues[0].message.contains(&key[4..]));
    }

    #[test]
    fn issues_never_echo_the_rejected_input() {
        let key = ["ghp", "_", "Zq8xK2mN7pR4vT9wB3cD6fG1hJ5kL0sAeYuI"].concat();
        let good = page("task", "active", "2026-11-20T00:00:00Z", "");
        let texts = [
            good.replace("type: task", &format!("type: {key}")),
            good.replace("status: active", &format!("status: {key}")),
            good.replace("updated: 2026-11-20T00:00:00Z", &format!("updated: {key}")),
            good.replace("title: t\n", &format!("title: t\n{key}: x\n")),
            good.replace("title: t\n", &format!("title: t\n{key}\n")),
            good.replace("title: t\n", &format!("title: t\ntitle: {key}\n")),
            good.replace("tags", "x")
                .replace("title: t\n", &format!("title: t\ntags: [{key}\n")),
        ];
        for text in &texts {
            let issues = validate(&key, text, &now());
            let found: Vec<&str> = issues.iter().map(|i| i.rule).collect();
            assert!(found.contains(&"invalid_slug"), "{found:?}");
            assert!(found.contains(&"invalid_frontmatter"), "{found:?}");
            assert!(found.contains(&"secret"), "{found:?}");
            for issue in &issues {
                assert!(!issue.message.contains(&key[4..]), "{}", issue.message);
            }
        }
    }
}
