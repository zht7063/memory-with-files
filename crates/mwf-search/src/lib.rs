//! Tokenization and BM25. Pure computation; depends on no workspace crate.
//!
//! See [docs/crates/mwf-search.md](https://github.com/zht7063/memory-with-files/blob/v2/docs/crates/mwf-search.md).

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

mod tokenize;

pub use tokenize::tokenize;
use tokenize::{Term, for_each_token};

/// BM25 term-frequency saturation (docs/decisions/0039).
pub const K1: f32 = 1.2;
/// BM25 document-length normalization (docs/decisions/0039).
pub const B: f32 = 0.75;

// Field weights (docs/decisions/0039): a term counts this many times per
// occurrence in the field, toward both its frequency and the document length.
const TITLE_WEIGHT: u32 = 3;
const SUMMARY_WEIGHT: u32 = 2;
const TAGS_WEIGHT: u32 = 2;
const BODY_WEIGHT: u32 = 1;

/// One searchable page. The caller (`mwf-app`) builds it from a page and
/// decides which pages take part, such as leaving out archived ones.
#[derive(Debug, Clone, Copy)]
pub struct Doc<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub summary: &'a str,
    pub tags: &'a [String],
    pub body: &'a str,
}

/// A document that matched, best first.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub id: String,
    pub score: f32,
    /// How many distinct query terms the document contains; the hook
    /// relevance threshold `recall_min_terms` compares against it (0039).
    pub matched_terms: usize,
}

/// An in-memory BM25 index over a set of [`Doc`]s.
#[derive(Debug, Default)]
pub struct Index {
    ids: Vec<String>,
    /// Per document: `K1 * (1 - B + B * len / avg_len)`.
    norms: Vec<f32>,
    /// Term ids of non-CJK words, and of CJK terms by packed key.
    words: HashMap<String, u32, BuildHasherDefault<FxHasher>>,
    cjk: HashMap<u64, u32, BuildHasherDefault<FxHasher>>,
    /// The postings of term `t` are `postings[starts[t]..starts[t + 1]]`.
    starts: Vec<u32>,
    /// `(document, weighted term frequency)`, grouped by term, in document
    /// order within a term.
    postings: Vec<(u32, u32)>,
}

impl Index {
    /// Indexes `docs`, weighting fields title ×3, summary ×2, tags ×2, body ×1.
    pub fn build<'a>(docs: impl IntoIterator<Item = Doc<'a>>) -> Index {
        let mut builder = Builder::default();
        let mut lens = Vec::new();
        for doc in docs {
            builder.add_field(doc.title, TITLE_WEIGHT);
            builder.add_field(doc.summary, SUMMARY_WEIGHT);
            for tag in doc.tags {
                builder.add_field(tag, TAGS_WEIGHT);
            }
            builder.add_field(doc.body, BODY_WEIGHT);
            lens.push(builder.finish_doc(builder.index.ids.len() as u32));
            builder.index.ids.push(doc.id.to_owned());
        }
        let mut index = builder.group_postings();
        let total: f64 = lens.iter().map(|&len| f64::from(len)).sum();
        let avg_len = if lens.is_empty() {
            0.0
        } else {
            total / lens.len() as f64
        };
        index.norms = lens
            .iter()
            .map(|&len| {
                let relative = if avg_len > 0.0 {
                    (f64::from(len) / avg_len) as f32
                } else {
                    0.0
                };
                K1 * (1.0 - B + B * relative)
            })
            .collect();
        index
    }

    /// Ranks documents against `query`: BM25 summed over its distinct terms.
    /// Returns at most `limit` documents that contain at least one term, by
    /// score descending, then id ascending.
    pub fn search(&self, query: &str, limit: usize) -> Vec<Hit> {
        self.rank(query, &[], limit)
    }

    /// Ranks documents by similarity to `text`, such as a page just written
    /// (ingest hints and `possible_duplicate`, 0040). Scores like [`search`]
    /// with all of `text` as the query, and leaves out the ids in `exclude`,
    /// such as the page itself.
    ///
    /// [`search`]: Index::search
    pub fn similar_to(&self, text: &str, exclude: &[&str], limit: usize) -> Vec<Hit> {
        self.rank(text, exclude, limit)
    }

    fn rank(&self, query: &str, exclude: &[&str], limit: usize) -> Vec<Hit> {
        if limit == 0 || self.ids.is_empty() {
            return Vec::new();
        }
        let mut query_terms: Vec<u32> = Vec::new();
        for_each_token(query, &mut |term| {
            let id = match term {
                Term::Word(word) => self.words.get(word),
                Term::Cjk(key, _) => self.cjk.get(&key),
            };
            query_terms.extend(id.copied());
        });
        query_terms.sort_unstable();
        query_terms.dedup();

        let n = self.ids.len() as f32;
        let mut scores = vec![0.0f32; self.ids.len()];
        let mut matched = vec![0usize; self.ids.len()];
        for &term in &query_terms {
            let term = term as usize;
            let postings =
                &self.postings[self.starts[term] as usize..self.starts[term + 1] as usize];
            let df = postings.len() as f32;
            let idf = ((n - df + 0.5) / (df + 0.5)).ln_1p();
            for &(doc, tf) in postings {
                let doc = doc as usize;
                let tf = tf as f32;
                scores[doc] += idf * tf * (K1 + 1.0) / (tf + self.norms[doc]);
                matched[doc] += 1;
            }
        }

        let mut ranked: Vec<usize> = (0..self.ids.len())
            .filter(|&doc| matched[doc] > 0 && !exclude.contains(&self.ids[doc].as_str()))
            .collect();
        ranked.sort_unstable_by(|&a, &b| {
            scores[b]
                .total_cmp(&scores[a])
                .then_with(|| self.ids[a].cmp(&self.ids[b]))
        });
        ranked.truncate(limit);
        ranked
            .into_iter()
            .map(|doc| Hit {
                id: self.ids[doc].clone(),
                score: scores[doc],
                matched_terms: matched[doc],
            })
            .collect()
    }
}

/// Accumulates one document's weighted term frequencies at a time.
#[derive(Default)]
struct Builder {
    index: Index,
    /// Per term id: weighted frequency in the current document.
    tf: Vec<u32>,
    /// Term ids with a nonzero `tf` in the current document.
    touched: Vec<u32>,
    len: u32,
    /// `(term, document, weighted term frequency)` of every document so far.
    entries: Vec<(u32, u32, u32)>,
}

impl Builder {
    fn add_field(&mut self, text: &str, weight: u32) {
        let Builder {
            index,
            tf,
            touched,
            len,
            ..
        } = self;
        for_each_token(text, &mut |term| {
            let mut new_id = || {
                tf.push(0);
                tf.len() as u32 - 1
            };
            let id = match term {
                Term::Word(word) => match index.words.get(word) {
                    Some(&id) => id,
                    None => {
                        let id = new_id();
                        index.words.insert(word.to_owned(), id);
                        id
                    }
                },
                Term::Cjk(key, _) => *index.cjk.entry(key).or_insert_with(new_id),
            };
            let count = &mut tf[id as usize];
            if *count == 0 {
                touched.push(id);
            }
            *count += weight;
            *len += weight;
        });
    }

    /// Records the current document's postings as `doc` and returns its
    /// weighted length.
    fn finish_doc(&mut self, doc: u32) -> u32 {
        for &term in &self.touched {
            let count = &mut self.tf[term as usize];
            self.entries.push((term, doc, *count));
            *count = 0;
        }
        self.touched.clear();
        std::mem::take(&mut self.len)
    }

    /// Sorts the entries into per-term postings with a stable counting sort,
    /// which keeps each term's documents in order.
    fn group_postings(self) -> Index {
        let mut index = self.index;
        let mut starts = vec![0u32; self.tf.len() + 1];
        for &(term, _, _) in &self.entries {
            starts[term as usize + 1] += 1;
        }
        for t in 1..starts.len() {
            starts[t] += starts[t - 1];
        }
        let mut next = starts.clone();
        let mut postings = vec![(0, 0); self.entries.len()];
        for (term, doc, tf) in self.entries {
            let slot = &mut next[term as usize];
            postings[*slot as usize] = (doc, tf);
            *slot += 1;
        }
        index.starts = starts;
        index.postings = postings;
        index
    }
}

/// FxHash (as in rustc): much faster than SipHash on the short term strings
/// the index hashes once per token. Terms come from the user's own notes, so
/// SipHash's resistance to crafted collisions buys nothing here.
#[derive(Default)]
pub(crate) struct FxHasher(u64);

impl FxHasher {
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

impl Hasher for FxHasher {
    fn write(&mut self, bytes: &[u8]) {
        let (words, remainder) = bytes.as_chunks::<8>();
        for &word in words {
            self.add(u64::from_le_bytes(word));
        }
        let mut rest = [0; 8];
        rest[..remainder.len()].copy_from_slice(remainder);
        self.add(u64::from_le_bytes(rest));
    }

    fn write_u8(&mut self, byte: u8) {
        self.add(u64::from(byte));
    }

    fn write_u64(&mut self, word: u64) {
        self.add(word);
    }

    fn finish(&self) -> u64 {
        // The multiply leaves the low bits, which pick the bucket, weakest.
        self.0.rotate_left(26)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc<'a>(
        id: &'a str,
        title: &'a str,
        summary: &'a str,
        tags: &'a [String],
        body: &'a str,
    ) -> Doc<'a> {
        Doc {
            id,
            title,
            summary,
            tags,
            body,
        }
    }

    fn body(id: &'static str, body: &'static str) -> Doc<'static> {
        doc(id, "", "", &[], body)
    }

    fn ids(hits: &[Hit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.id.as_str()).collect()
    }

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 1e-4,
            "score {actual} differs from {expected}"
        );
    }

    #[test]
    fn constants_match_adr_0039() {
        assert_eq!((K1, B), (1.2, 0.75));
    }

    #[test]
    fn score_is_bm25_with_k1_and_b() {
        // N = 3, df(beta) = 1, lengths 2, 1, 1, so avg_len = 4/3.
        // idf = ln(1 + (3 - 1 + 0.5) / (1 + 0.5)) = 0.980829
        // norm = 1.2 * (0.25 + 0.75 * 2 / (4/3)) = 1.65
        // score = idf * 1 * 2.2 / (1 + 1.65) = 0.814273
        let index = Index::build([
            body("d1", "alpha beta"),
            body("d2", "alpha"),
            body("d3", "gamma"),
        ]);
        let hits = index.search("beta", 10);
        assert_eq!(ids(&hits), ["d1"]);
        assert_close(hits[0].score, 0.814_273);
    }

    #[test]
    fn fields_are_weighted_title_3_summary_2_tags_2_body_1() {
        // Every document has weighted length 3 and contains "deploy" once,
        // so only the field's weight (the term frequency) differs.
        // idf = ln(1 + 0.5 / 4.5) = 0.105361; norm = 1.2;
        // score(tf) = idf * tf * 2.2 / (tf + 1.2).
        let tag = ["deploy".to_owned()];
        let index = Index::build([
            doc("body", "", "", &[], "deploy x y"),
            doc("tags", "", "", &tag, "z"),
            doc("summary", "", "deploy", &[], "z"),
            doc("title", "deploy", "", &[], ""),
        ]);
        let hits = index.search("deploy", 10);
        assert_eq!(ids(&hits), ["title", "summary", "tags", "body"]);
        assert_close(hits[0].score, 0.165_567);
        assert_close(hits[1].score, 0.144_871);
        assert_close(hits[2].score, 0.144_871);
        assert_close(hits[3].score, 0.105_361);
    }

    #[test]
    fn every_tag_counts_toward_the_tag_field() {
        let tags = ["rust".to_owned(), "rust cli".to_owned()];
        let one = ["rust".to_owned()];
        let index = Index::build([
            doc("two", "", "", &tags, ""),
            doc("one", "", "", &one, "a b c"),
        ]);
        assert_eq!(ids(&index.search("rust", 10)), ["two", "one"]);
    }

    #[test]
    fn longer_documents_score_lower_for_the_same_frequency() {
        let index = Index::build([
            body("long", "rust x y z w v u"),
            body("short", "rust x"),
            body("other", "go"),
        ]);
        assert_eq!(ids(&index.search("rust", 10)), ["short", "long"]);
    }

    #[test]
    fn rarer_terms_weigh_more() {
        let index = Index::build([
            body("common", "cache"),
            body("rare", "lockfile"),
            body("c2", "cache"),
            body("c3", "cache"),
        ]);
        let hits = index.search("cache lockfile", 10);
        assert_eq!(hits[0].id, "rare");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn matched_terms_counts_distinct_query_terms_in_the_document() {
        let index = Index::build([body("both", "rust deploy deploy"), body("one", "rust")]);
        let hits = index.search("Rust rust deploy pipeline", 10);
        assert_eq!(ids(&hits), ["both", "one"]);
        assert_eq!(hits[0].matched_terms, 2);
        assert_eq!(hits[1].matched_terms, 1);
    }

    #[test]
    fn repeating_a_query_term_does_not_change_the_score() {
        let index = Index::build([body("d", "rust deploy"), body("e", "go")]);
        assert_eq!(index.search("rust", 10), index.search("rust rust rust", 10));
    }

    #[test]
    fn cjk_words_match_through_bigrams() {
        let index = Index::build([
            body("deploy", "这次部署流程很长"),
            body("migrate", "数据库迁移"),
        ]);
        let hits = index.search("部署", 10);
        assert_eq!(ids(&hits), ["deploy"]);
        assert_eq!(hits[0].matched_terms, 1);
        assert_eq!(index.search("数据库的迁移", 10)[0].matched_terms, 3);
    }

    #[test]
    fn stopword_only_and_unknown_queries_match_nothing() {
        let index = Index::build([body("d", "the rust book")]);
        assert!(index.search("the of 的", 10).is_empty());
        assert!(index.search("python", 10).is_empty());
        assert!(index.search("", 10).is_empty());
    }

    #[test]
    fn ties_are_broken_by_id_and_limit_truncates() {
        let index = Index::build([
            body("c", "rust"),
            body("a", "rust"),
            body("b", "rust"),
            body("x", "go"),
        ]);
        assert_eq!(ids(&index.search("rust", 10)), ["a", "b", "c"]);
        assert_eq!(ids(&index.search("rust", 2)), ["a", "b"]);
        assert!(index.search("rust", 0).is_empty());
    }

    #[test]
    fn empty_index_matches_nothing() {
        let index = Index::build([]);
        assert!(index.search("rust", 10).is_empty());
        assert!(index.similar_to("rust", &[], 10).is_empty());
    }

    #[test]
    fn similar_to_ranks_by_overlap_and_skips_excluded_ids() {
        let page = "部署 pipeline uses cargo dist and a release workflow";
        let index = Index::build([
            body("self", page),
            body("dup", "部署 pipeline with cargo dist release workflow"),
            body("near", "release workflow notes"),
            body("far", "lint rules"),
        ]);
        let hits = index.similar_to(page, &["self"], 10);
        assert_eq!(ids(&hits), ["dup", "near"]);
        assert!(hits[0].matched_terms > hits[1].matched_terms);
        assert_eq!(ids(&index.similar_to(page, &["self", "dup"], 1)), ["near"]);
    }
}
