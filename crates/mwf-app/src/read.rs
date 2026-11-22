//! Read operations. None takes the write lock (ADR 0033).

use mwf_domain::{Page, PageType, Rev, Slug, Status, render_page};
use mwf_search::Index;
use mwf_store::LOCK_WAIT;

use crate::corpus::{Corpus, doc, link_targets};
use crate::dto::{ListIn, PageSummary, PageView, SearchHit, SearchIn, StatusFilter};
use crate::error::AppError;
use crate::{App, parse_stored};

/// The page filters of `search` and `list`.
struct Filter {
    types: Vec<PageType>,
    tags: Vec<String>,
    status: StatusFilter,
}

impl Filter {
    fn new(types: &[String], tags: &[String], status: StatusFilter) -> Result<Filter, AppError> {
        Ok(Filter {
            types: types
                .iter()
                .map(|t| t.parse::<PageType>())
                .collect::<Result<_, _>>()?,
            tags: tags.to_vec(),
            status,
        })
    }

    fn matches(&self, page: &Page) -> bool {
        let status = match self.status {
            StatusFilter::Active => page.fm.status == Status::Active,
            StatusFilter::Archived => page.fm.status == Status::Archived,
            StatusFilter::All => true,
        };
        status
            && (self.types.is_empty() || self.types.contains(&page.fm.page_type))
            && self.tags.iter().all(|t| page.fm.tags.contains(t))
    }
}

/// The rev of a corpus page: of its file bytes, which parsed to `page`.
fn rev(corpus: &Corpus, page: &Page) -> String {
    corpus
        .entry(page.slug.as_str())
        .map_or_else(
            || Rev::of(render_page(page).as_bytes()),
            |e| Rev::of(&e.bytes),
        )
        .to_string()
}

impl App {
    /// One page with its rev, and the title and summary of the pages it links to and that link
    /// to it (ADR 0040).
    pub fn show(&self, slug: &str) -> Result<PageView, AppError> {
        let slug = Slug::parse(slug)?;
        let bytes = self
            .project
            .read_page(&slug)?
            .ok_or_else(|| AppError::not_found(&slug))?;
        let page = parse_stored(&slug, &bytes)?;
        let corpus = Corpus::load(&self.project)?;
        let links_out = link_targets(&page.body)
            .iter()
            .map(|t| corpus.link_ref(t.as_str()))
            .collect();
        let links_in = corpus
            .backlinks(&slug)
            .into_iter()
            .map(|p| corpus.link_ref(p.slug.as_str()))
            .collect();
        let fm = page.fm;
        Ok(PageView {
            slug: slug.to_string(),
            rev: Rev::of(&bytes).to_string(),
            title: fm.title,
            page_type: fm.page_type.as_str().to_owned(),
            summary: fm.summary,
            tags: fm.tags,
            status: fm.status.as_str().to_owned(),
            created: fm.created.to_string(),
            updated: fm.updated.to_string(),
            body: page.body,
            links_out,
            links_in,
        })
    }

    /// BM25 over the pages that pass the filters (ADR 0039).
    pub fn search(&self, q: &SearchIn) -> Result<Vec<SearchHit>, AppError> {
        let filter = Filter::new(&q.types, &q.tags, q.status)?;
        let corpus = Corpus::load(&self.project)?;
        let pages: Vec<&Page> = corpus.pages().filter(|p| filter.matches(p)).collect();
        let index = Index::build(pages.iter().map(|p| doc(p)));
        Ok(index
            .search(&q.query, q.limit)
            .into_iter()
            .filter_map(|hit| {
                let page = corpus.entry(&hit.id)?.page.as_ref()?;
                Some(SearchHit {
                    slug: hit.id,
                    title: page.fm.title.clone(),
                    page_type: page.fm.page_type.as_str().to_owned(),
                    summary: page.fm.summary.clone(),
                    status: page.fm.status.as_str().to_owned(),
                    score: hit.score,
                    rev: rev(&corpus, page),
                })
            })
            .collect())
    }

    /// Valid pages that pass the filters, by slug.
    pub fn list(&self, q: &ListIn) -> Result<Vec<PageSummary>, AppError> {
        let filter = Filter::new(&q.types, &q.tags, q.status)?;
        let corpus = Corpus::load(&self.project)?;
        Ok(corpus
            .pages()
            .filter(|p| filter.matches(p))
            .map(|p| PageSummary {
                slug: p.slug.to_string(),
                title: p.fm.title.clone(),
                page_type: p.fm.page_type.as_str().to_owned(),
                summary: p.fm.summary.clone(),
                tags: p.fm.tags.clone(),
                status: p.fm.status.as_str().to_owned(),
                updated: p.fm.updated.to_string(),
                rev: rev(&corpus, p),
            })
            .collect())
    }

    /// The table of contents rendered from the current pages (never a stale `index.md`).
    /// With `rebuild`, also writes it to `index.md` under the write lock when it differs; this
    /// is not a page write and appends no `log.md` line (ADR 0049).
    pub fn index(&self, rebuild: bool) -> Result<String, AppError> {
        if !rebuild {
            return Ok(Corpus::load(&self.project)?.index_text());
        }
        let mut guard = self.project.lock(LOCK_WAIT)?;
        let project = guard.project();
        let text = Corpus::load(project)?.index_text();
        if project.read_index()?.as_deref() != Some(text.as_bytes()) {
            guard.write_index(&text)?;
        }
        Ok(text)
    }

    /// The last `n` lines of `log.md`, oldest first.
    pub fn log(&self, n: usize) -> Result<Vec<String>, AppError> {
        Ok(self.project.read_log(n)?)
    }
}
