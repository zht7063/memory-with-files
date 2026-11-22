//! All page files of a project, read once per operation, and the link graph and search
//! documents built from them.

use mwf_domain::{Page, Slug, Status, internal_links, parse_page, render_index};
use mwf_search::{Doc, Index};
use mwf_store::Project;

use crate::dto::{LinkRef, RelatedPage, Warning};
use crate::error::AppError;

/// Similar pages a write reports at most (ADR 0040).
pub const RELATED_LIMIT: usize = 3;
/// Distinct terms a page must share with the written page to count as related (ADR 0049).
pub const RELATED_MIN_TERMS: usize = 2;

pub(crate) struct Entry {
    pub stem: String,
    pub bytes: Vec<u8>,
    /// `None` when the name is not a slug or the file is not UTF-8 or does not parse.
    pub page: Option<Page>,
}

/// Page files sorted by name. Invalid ones stay in `entries` (they exist as link targets and lint
/// reports them) but take no part in the link graph, `index.md` or search.
pub(crate) struct Corpus {
    pub entries: Vec<Entry>,
}

impl Corpus {
    pub fn load(project: &Project) -> Result<Corpus, AppError> {
        let entries = project
            .read_all_pages()?
            .into_iter()
            .map(|(stem, bytes)| {
                let page = Slug::parse(&stem).ok().and_then(|slug| {
                    let text = std::str::from_utf8(&bytes).ok()?;
                    parse_page(slug, text).ok()
                });
                Entry { stem, bytes, page }
            })
            .collect();
        Ok(Corpus { entries })
    }

    pub fn pages(&self) -> impl Iterator<Item = &Page> {
        self.entries.iter().filter_map(|e| e.page.as_ref())
    }

    pub fn entry(&self, stem: &str) -> Option<&Entry> {
        self.entries
            .binary_search_by(|e| e.stem.as_str().cmp(stem))
            .ok()
            .map(|i| &self.entries[i])
    }

    pub fn index_text(&self) -> String {
        render_index(&self.pages().collect::<Vec<_>>())
    }

    /// Valid pages other than `target` that link to it, by slug.
    pub fn backlinks(&self, target: &Slug) -> Vec<&Page> {
        self.pages()
            .filter(|p| p.slug != *target && links_to(p, target))
            .collect()
    }

    /// Warnings for invalid page files whose text links to `target`: `rename` and `delete
    /// --unlink` cannot rewrite them.
    pub fn skipped_invalid(&self, target: &Slug) -> Vec<Warning> {
        self.entries
            .iter()
            .filter(|e| e.page.is_none())
            .filter(|e| {
                internal_links(&String::from_utf8_lossy(&e.bytes))
                    .iter()
                    .any(|l| l.target == *target)
            })
            .map(|e| Warning {
                rule: "invalid_page_skipped",
                message: format!(
                    "pages/{}.md links to {target}.md but is not a valid page, so its links were not changed; fix it (`mwf lint`) and update the links",
                    e.stem
                ),
            })
            .collect()
    }

    pub fn link_ref(&self, slug: &str) -> LinkRef {
        let entry = self.entry(slug);
        let page = entry.and_then(|e| e.page.as_ref());
        LinkRef {
            slug: slug.to_owned(),
            exists: entry.is_some(),
            title: page.map(|p| p.fm.title.clone()),
            summary: page.map(|p| p.fm.summary.clone()),
        }
    }

    /// `dangling_link` warnings for the links of `page` to page files that do not exist.
    pub fn dangling(&self, page: &Page) -> Vec<Warning> {
        link_targets(&page.body)
            .into_iter()
            .filter(|t| self.entry(t.as_str()).is_none())
            .map(|t| Warning {
                rule: "dangling_link",
                message: format!("links to {t}.md, which does not exist"),
            })
            .collect()
    }

    /// Up to [`RELATED_LIMIT`] active pages most similar to `page` that it does not link to,
    /// each sharing at least [`RELATED_MIN_TERMS`] distinct terms with it (ADR 0040).
    pub fn related_unlinked(&self, page: &Page) -> Vec<RelatedPage> {
        let active: Vec<&Page> = self
            .pages()
            .filter(|p| p.fm.status == Status::Active)
            .collect();
        let index = Index::build(active.iter().map(|p| doc(p)));
        let mut exclude: Vec<String> = link_targets(&page.body)
            .into_iter()
            .map(|s| s.as_str().to_owned())
            .collect();
        exclude.push(page.slug.as_str().to_owned());
        let exclude: Vec<&str> = exclude.iter().map(String::as_str).collect();
        index
            .similar_to(&query_text(page), &exclude, active.len())
            .into_iter()
            .filter(|h| h.matched_terms >= RELATED_MIN_TERMS)
            .filter_map(|h| self.entry(&h.id)?.page.as_ref())
            .take(RELATED_LIMIT)
            .map(|p| RelatedPage {
                slug: p.slug.to_string(),
                title: p.fm.title.clone(),
                summary: p.fm.summary.clone(),
            })
            .collect()
    }
}

pub(crate) fn links_to(page: &Page, target: &Slug) -> bool {
    internal_links(&page.body)
        .iter()
        .any(|l| l.target == *target)
}

/// Distinct internal link targets of `body`, in order of first appearance.
pub(crate) fn link_targets(body: &str) -> Vec<Slug> {
    let mut out: Vec<Slug> = Vec::new();
    for link in internal_links(body) {
        if !out.contains(&link.target) {
            out.push(link.target);
        }
    }
    out
}

pub(crate) fn doc(page: &Page) -> Doc<'_> {
    Doc {
        id: page.slug.as_str(),
        title: &page.fm.title,
        summary: &page.fm.summary,
        tags: &page.fm.tags,
        body: &page.body,
    }
}

/// All searchable text of a page, as a query for `similar_to`.
pub(crate) fn query_text(page: &Page) -> String {
    let mut text = format!("{}\n{}\n", page.fm.title, page.fm.summary);
    for tag in &page.fm.tags {
        text.push_str(tag);
        text.push('\n');
    }
    text.push_str(&page.body);
    text
}
