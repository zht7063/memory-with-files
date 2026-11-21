//! 5,000-page search benchmark (docs/decisions/0011, 0021, 0047). A search
//! builds the index from every page and then ranks, so `build_and_search` is
//! the number to watch: it must stay under about 100 ms at the reference page
//! size of about 0.5 KB (`sentences = 2`). The larger sizes are for reference.

use divan::{Bencher, black_box};
use mwf_search::{Doc, Index};

const PAGES: usize = 5_000;
const QUERY: &str = "数据库迁移 deploy pipeline 回滚";

fn main() {
    divan::main();
}

struct Page {
    id: String,
    title: String,
    summary: String,
    tags: Vec<String>,
    body: String,
}

impl Page {
    fn doc(&self) -> Doc<'_> {
        Doc {
            id: &self.id,
            title: &self.title,
            summary: &self.summary,
            tags: &self.tags,
            body: &self.body,
        }
    }
}

/// Deterministic pseudo-random text: Latin words from a 3,000-word vocabulary
/// and Chinese sentences from 2,000 common-range ideographs, both skewed so a
/// few terms are frequent and most are rare, like real notes.
struct Gen(u64);

impl Gen {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn skewed(&mut self, n: u64) -> u64 {
        self.next() % n * (self.next() % n) / n
    }

    fn word(&mut self, out: &mut String) {
        const SYLLABLES: [&str; 16] = [
            "ka", "lo", "mi", "ner", "po", "qu", "ra", "sen", "ti", "vu", "wex", "zor", "dep",
            "loy", "pipe", "line",
        ];
        let mut w = self.skewed(3_000);
        for _ in 0..3 {
            out.push_str(SYLLABLES[(w % 16) as usize]);
            w /= 16;
        }
    }

    fn latin(&mut self, words: usize, out: &mut String) {
        for _ in 0..words {
            self.word(out);
            out.push(' ');
        }
    }

    fn chinese(&mut self, chars: usize, out: &mut String) {
        for _ in 0..chars {
            let c = char::from_u32(0x4E00 + self.skewed(2_000) as u32).unwrap_or('中');
            out.push(c);
        }
        out.push('。');
    }

    fn page(&mut self, i: usize, sentences: usize) -> Page {
        let mut title = String::new();
        self.latin(4, &mut title);
        self.chinese(4, &mut title);
        let mut summary = String::new();
        self.latin(12, &mut summary);
        self.chinese(12, &mut summary);
        let tags = (0..3)
            .map(|_| {
                let mut tag = String::new();
                self.word(&mut tag);
                tag
            })
            .collect();
        // Each sentence pair, 12 Latin words and 20 Chinese characters, is
        // about 160 bytes.
        let mut body = String::new();
        for _ in 0..sentences {
            self.latin(12, &mut body);
            self.chinese(20, &mut body);
            body.push('\n');
        }
        Page {
            id: format!("page-{i:04}"),
            title,
            summary,
            tags,
            body,
        }
    }
}

fn corpus(sentences: usize) -> Vec<Page> {
    let mut generator = Gen(0x5eed);
    (0..PAGES).map(|i| generator.page(i, sentences)).collect()
}

/// Sentence pairs per page body: about 0.5 KB per page in all (the reference
/// size, 0047), then 1 and 1.8 KB.
const SIZES: [usize; 3] = [2, 5, 10];

#[divan::bench(args = SIZES, sample_count = 20)]
fn build_and_search(bencher: Bencher, sentences: usize) {
    let pages = corpus(sentences);
    bencher.bench(|| {
        let index = Index::build(pages.iter().map(Page::doc));
        index.search(black_box(QUERY), 10)
    });
}

#[divan::bench(args = SIZES)]
fn search(bencher: Bencher, sentences: usize) {
    let pages = corpus(sentences);
    let index = Index::build(pages.iter().map(Page::doc));
    bencher.bench(|| index.search(black_box(QUERY), 10));
}

#[divan::bench(args = SIZES)]
fn similar_to(bencher: Bencher, sentences: usize) {
    let pages = corpus(sentences);
    let index = Index::build(pages.iter().map(Page::doc));
    let page = &pages[42];
    bencher.bench(|| index.similar_to(black_box(&page.body), &[&page.id], 3));
}
