//! `lint`: the single-file rules of `mwf_domain::validate` plus the corpus rules composed here
//! (ADR 0035): `dangling_link`, `orphan`, `index_drift`, `possible_duplicate`, and
//! `invalid_config` (ADR 0049).

use std::collections::{BTreeSet, HashMap, HashSet};

use mwf_domain::{Page, Status, validate};
use mwf_search::Index;

use crate::App;
use crate::corpus::{Corpus, doc, link_targets, query_text};
use crate::dto::{LintIssue, LintReport, Severity};
use crate::error::AppError;

/// Two active pages are `possible_duplicate` when one of them scores at least this fraction of
/// the best BM25 score for the other's full text, which is normally that page's own score: the
/// other page is mostly covered by it (ADR 0049).
pub const DUPLICATE_SIMILARITY: f32 = 0.8;
/// Candidates per page checked for `possible_duplicate`.
const DUPLICATE_CANDIDATES: usize = 6;

fn issue(page: Option<&str>, rule: &'static str, severity: Severity, message: String) -> LintIssue {
    LintIssue {
        page: page.map(str::to_owned),
        rule,
        severity,
        message,
    }
}

impl App {
    /// Checks every page file and the project; never writes. Issues are sorted by page (project
    /// issues first), then rule.
    pub fn lint(&self) -> Result<LintReport, AppError> {
        let now = self.now()?;
        let mut issues = Vec::new();
        if let Err(e) = self.project.config() {
            issues.push(issue(
                None,
                "invalid_config",
                Severity::Error,
                e.to_string(),
            ));
        }
        let corpus = Corpus::load(&self.project)?;
        for e in &corpus.entries {
            match std::str::from_utf8(&e.bytes) {
                Err(_) => issues.push(issue(
                    Some(&e.stem),
                    "invalid_frontmatter",
                    Severity::Error,
                    "the page file is not UTF-8".to_owned(),
                )),
                Ok(text) => {
                    for i in validate(&e.stem, text, &now) {
                        let severity = match i.severity {
                            mwf_domain::Severity::Error => Severity::Error,
                            mwf_domain::Severity::Warning => Severity::Warning,
                        };
                        issues.push(issue(Some(&e.stem), i.rule, severity, i.message));
                    }
                }
            }
        }

        let mut linked: HashSet<&str> = HashSet::new();
        for page in corpus.pages() {
            for target in link_targets(&page.body) {
                if corpus.entry(target.as_str()).is_none() {
                    issues.push(issue(
                        Some(page.slug.as_str()),
                        "dangling_link",
                        Severity::Warning,
                        format!("links to {target}.md, which does not exist"),
                    ));
                }
                if target != page.slug
                    && let Some(e) = corpus.entry(target.as_str())
                {
                    linked.insert(e.stem.as_str());
                }
            }
        }
        for page in corpus.pages() {
            if page.fm.status == Status::Active && !linked.contains(page.slug.as_str()) {
                issues.push(issue(
                    Some(page.slug.as_str()),
                    "orphan",
                    Severity::Warning,
                    "no other page links here; link it from a related page".to_owned(),
                ));
            }
        }

        let index = corpus.index_text();
        match self.project.read_index()? {
            Some(bytes) if bytes == index.as_bytes() => {}
            Some(_) => issues.push(issue(
                None,
                "index_drift",
                Severity::Warning,
                "index.md does not match the pages; run `mwf index --rebuild`".to_owned(),
            )),
            None => issues.push(issue(
                None,
                "index_drift",
                Severity::Warning,
                "index.md is missing; run `mwf index --rebuild`".to_owned(),
            )),
        }

        for (a, b) in duplicates(&corpus) {
            for (this, other) in [(a, b), (b, a)] {
                issues.push(issue(
                    Some(this.slug.as_str()),
                    "possible_duplicate",
                    Severity::Warning,
                    format!(
                        "very similar to {} (\"{}\"); merge them or link them",
                        other.slug, other.fm.title
                    ),
                ));
            }
        }

        issues.sort_by(|x, y| (&x.page, x.rule).cmp(&(&y.page, y.rule)));
        let errors = issues
            .iter()
            .filter(|i| i.severity == Severity::Error)
            .count();
        Ok(LintReport {
            warnings: issues.len() - errors,
            errors,
            issues,
        })
    }
}

/// Pairs of active pages (first slug < second) where either covers the other (see
/// [`DUPLICATE_SIMILARITY`]).
fn duplicates(corpus: &Corpus) -> Vec<(&Page, &Page)> {
    let active: Vec<&Page> = corpus
        .pages()
        .filter(|p| p.fm.status == Status::Active)
        .collect();
    let index = Index::build(active.iter().map(|p| doc(p)));
    let mut close: HashMap<&str, HashSet<String>> = HashMap::new();
    for page in &active {
        let hits = index.similar_to(&query_text(page), &[], DUPLICATE_CANDIDATES);
        let Some(best) = hits.first().map(|h| h.score) else {
            continue;
        };
        let set = hits
            .into_iter()
            .filter(|h| h.id != page.slug.as_str() && h.score >= best * DUPLICATE_SIMILARITY)
            .map(|h| h.id)
            .collect();
        close.insert(page.slug.as_str(), set);
    }
    let by_slug: HashMap<&str, &Page> = active.iter().map(|p| (p.slug.as_str(), *p)).collect();
    // Each unordered pair once, sorted.
    let pairs: BTreeSet<(&str, &str)> = close
        .iter()
        .flat_map(|(a, others)| {
            others.iter().map(move |b| {
                if *a < b.as_str() {
                    (*a, b.as_str())
                } else {
                    (b.as_str(), *a)
                }
            })
        })
        .collect();
    pairs
        .into_iter()
        .filter_map(|(x, y)| Some((*by_slug.get(x)?, *by_slug.get(y)?)))
        .collect()
}
