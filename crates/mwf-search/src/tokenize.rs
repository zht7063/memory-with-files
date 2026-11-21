//! Tokenizer (docs/decisions/0011): words of non-CJK text are split on
//! Unicode word boundaries and lowercased; runs of CJK characters become
//! character bigrams; stopwords are dropped.

use std::collections::HashSet;
use std::hash::BuildHasherDefault;
use std::sync::LazyLock;

use unicode_segmentation::UnicodeSegmentation;

use crate::FxHasher;

/// Splits `text` into search terms.
///
/// - Text outside CJK scripts is split on Unicode word boundaries (UAX #29)
///   and lowercased: `"Deploy mwf-search"` → `deploy`, `mwf`, `search`.
/// - Each run of CJK characters (Han, Hiragana, Katakana, Hangul, Bopomofo) yields its
///   overlapping character bigrams: `"部署失败"` → `部署`, `署失`, `失败`. A run
///   of a single character yields that character. Any other character, such
///   as punctuation, a space, or a Latin letter, ends the run.
/// - Terms in the built-in stopword list are removed.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for_each_token(text, &mut |term| terms.push(term.text().to_owned()));
    terms
}

/// A term as the index sees it. CJK terms (one or two characters) carry a
/// packed key so the index can look them up without hashing or comparing
/// strings.
pub(crate) enum Term<'a> {
    Word(&'a str),
    Cjk(u64, &'a str),
}

impl Term<'_> {
    pub(crate) fn text(&self) -> &str {
        match self {
            Term::Word(text) | Term::Cjk(_, text) => text,
        }
    }
}

/// Calls `f` with each term of `text`, in order, without allocating a string
/// per term. [`tokenize`] and the index share it.
pub(crate) fn for_each_token(text: &str, f: &mut impl FnMut(Term<'_>)) {
    let mut lower = String::new();
    let mut run_start = 0;
    let mut run_cjk = false;
    for (i, c) in text.char_indices() {
        let cjk = is_cjk(c);
        if cjk != run_cjk {
            emit_run(&text[run_start..i], run_cjk, &mut lower, f);
            run_start = i;
            run_cjk = cjk;
        }
    }
    emit_run(&text[run_start..], run_cjk, &mut lower, f);
}

fn emit_run(run: &str, cjk: bool, lower: &mut String, f: &mut impl FnMut(Term<'_>)) {
    if cjk {
        emit_bigrams(run, f);
    } else if run.is_ascii() {
        ascii_words(run, |word| {
            lower.clear();
            lower.push_str(word);
            lower.make_ascii_lowercase();
            if !is_stopword(lower) {
                f(Term::Word(lower));
            }
        });
    } else {
        for word in run.unicode_words() {
            *lower = word.to_lowercase();
            if !is_stopword(lower) {
                f(Term::Word(lower));
            }
        }
    }
}

/// `str::unicode_words` for ASCII text, which is most of what notes hold and
/// several times faster than the general UAX #29 state machine. Letters,
/// digits, and `_` join (WB5, WB8 to WB10, WB13a/b); `:`, `.`, or `'` joins
/// two letters (WB6, WB7); `.`, `,`, `;`, or `'` joins two digits (WB11,
/// WB12). Like `unicode_words`, it skips words without a letter or digit.
fn ascii_words<'a>(run: &'a str, mut f: impl FnMut(&'a str)) {
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let joins = |before: u8, mid: u8, after: u8| {
        (before.is_ascii_alphabetic()
            && after.is_ascii_alphabetic()
            && matches!(mid, b':' | b'.' | b'\''))
            || (before.is_ascii_digit()
                && after.is_ascii_digit()
                && matches!(mid, b'.' | b',' | b';' | b'\''))
    };
    let bytes = run.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !is_word(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut alphanumeric = false;
        loop {
            alphanumeric |= bytes[i].is_ascii_alphanumeric();
            i += 1;
            match (bytes.get(i), bytes.get(i + 1)) {
                (Some(&next), _) if is_word(next) => {}
                (Some(&mid), Some(&after)) if joins(bytes[i - 1], mid, after) => i += 1,
                _ => break,
            }
        }
        if alphanumeric {
            f(&run[start..i]);
        }
    }
}

fn emit_bigrams(run: &str, f: &mut impl FnMut(Term<'_>)) {
    let mut prev: Option<(usize, char)> = None;
    for (i, c) in run.char_indices() {
        if let Some((start, first)) = prev {
            let bigram = &run[start..i + c.len_utf8()];
            if !is_stopword(bigram) {
                f(Term::Cjk(cjk_key(first, Some(c)), bigram));
            }
        }
        prev = Some((i, c));
    }
    // A lone character has no bigram; keep it so one-character queries match.
    if let Some((0, c)) = prev
        && !is_stopword(run)
    {
        f(Term::Cjk(cjk_key(c, None), run));
    }
}

/// Packs one or two characters into a key; `'\0'`, never CJK, marks a lone
/// character.
fn cjk_key(first: char, second: Option<char>) -> u64 {
    u64::from(first) << 32 | u64::from(second.unwrap_or('\0'))
}

/// Letters, marks, and iteration marks of the Han, Hiragana, Katakana,
/// Hangul, and Bopomofo scripts, including supplementary-plane kana and Han
/// extensions. Unicode blocks also hold punctuation and symbols, such as
/// `・` (U+30FB) and `゛` (U+309B), so only their letter ranges count;
/// those characters end a run like any other punctuation.
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF       // Hangul Jamo
        | 0x3005..=0x3007     // 々 〆 〇
        | 0x3021..=0x3029     // Hangzhou numerals
        | 0x3031..=0x3035     // vertical kana repeat marks
        | 0x3038..=0x303C     // 〸 〹 〺 〻 〼
        | 0x3041..=0x3096     // Hiragana letters
        | 0x3099..=0x309A     // combining (semi-)voiced sound marks
        | 0x309D..=0x309F     // ゝ ゞ ゟ
        | 0x30A1..=0x30FA     // Katakana letters
        | 0x30FC..=0x30FF     // ー ヽ ヾ ヿ
        | 0x3105..=0x312F     // Bopomofo
        | 0x3131..=0x318E     // Hangul Compatibility Jamo
        | 0x31A0..=0x31BF     // Bopomofo Extended
        | 0x31F0..=0x31FF     // Katakana Phonetic Extensions
        | 0x3400..=0x4DBF     // CJK Unified Ideographs Extension A
        | 0x4E00..=0x9FFF     // CJK Unified Ideographs
        | 0xA960..=0xA97C     // Hangul Jamo Extended-A
        | 0xAC00..=0xD7A3     // Hangul Syllables
        | 0xD7B0..=0xD7FB     // Hangul Jamo Extended-B
        | 0xF900..=0xFAD9     // CJK Compatibility Ideographs
        | 0xFF66..=0xFF9F     // Halfwidth Katakana letters and sound marks
        | 0xFFA0..=0xFFDC     // Halfwidth Hangul letters
        | 0x1AFF0..=0x1B16F   // Kana Extended-B, Kana Supplement, Kana Extended-A, Small Kana Extension
        | 0x20000..=0x2FA1F   // CJK Unified Ideographs Extensions B to F, I, and compatibility supplement
        | 0x30000..=0x3347F // CJK Unified Ideographs Extensions G, H, and J
    )
}

fn is_stopword(term: &str) -> bool {
    // A hash set: a binary search costs about eight string comparisons per
    // term, a third of the whole tokenizer's time.
    static SET: LazyLock<HashSet<&str, BuildHasherDefault<FxHasher>>> =
        LazyLock::new(|| STOPWORDS.iter().copied().collect());
    // No stopword is longer than "yourselves".
    term.len() <= 10 && SET.contains(term)
}

/// Common English function words and Chinese function characters and words,
/// sorted by bytes.
const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "above",
    "after",
    "again",
    "against",
    "all",
    "am",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "because",
    "been",
    "before",
    "being",
    "below",
    "between",
    "both",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "doing",
    "down",
    "during",
    "each",
    "few",
    "for",
    "from",
    "further",
    "had",
    "has",
    "have",
    "having",
    "he",
    "her",
    "here",
    "hers",
    "herself",
    "him",
    "himself",
    "his",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "itself",
    "just",
    "me",
    "more",
    "most",
    "my",
    "myself",
    "no",
    "nor",
    "not",
    "now",
    "of",
    "off",
    "on",
    "once",
    "only",
    "or",
    "other",
    "our",
    "ours",
    "ourselves",
    "out",
    "over",
    "own",
    "same",
    "she",
    "should",
    "so",
    "some",
    "such",
    "than",
    "that",
    "the",
    "their",
    "theirs",
    "them",
    "themselves",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "to",
    "too",
    "under",
    "until",
    "up",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
    "yours",
    "yourself",
    "yourselves",
    "一个",
    "与",
    "也",
    "了",
    "什么",
    "他们",
    "以及",
    "但是",
    "你们",
    "及",
    "吗",
    "吧",
    "呢",
    "和",
    "啊",
    "因为",
    "在",
    "如果",
    "它们",
    "就",
    "并且",
    "怎么",
    "我们",
    "或",
    "或者",
    "所以",
    "把",
    "是",
    "然后",
    "的",
    "着",
    "而",
    "而且",
    "被",
    "这个",
    "这些",
    "这样",
    "那个",
    "那些",
    "那样",
    "都",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(text: &str) -> Vec<String> {
        tokenize(text)
    }

    #[test]
    fn latin_words_are_split_on_word_boundaries_and_lowercased() {
        assert_eq!(
            terms("Deploy, WORLD! mwf-search v2 foo_bar 3.14"),
            ["deploy", "world", "mwf", "search", "v2", "foo_bar", "3.14"]
        );
        assert_eq!(terms("ÜBER Été"), ["über", "été"]);
    }

    #[test]
    fn stopwords_are_removed_after_lowercasing() {
        assert_eq!(terms("The quick fox AND the dog"), ["quick", "fox", "dog"]);
        assert!(terms("the of and to").is_empty());
    }

    #[test]
    fn cjk_runs_become_overlapping_bigrams() {
        assert_eq!(terms("部署失败"), ["部署", "署失", "失败"]);
        assert_eq!(terms("部署"), ["部署"]);
    }

    #[test]
    fn a_lone_cjk_character_is_its_own_term() {
        assert_eq!(terms("库"), ["库"]);
        assert_eq!(terms("用Rust写"), ["用", "rust", "写"]);
    }

    #[test]
    fn cjk_stopwords_are_removed_as_characters_and_bigrams() {
        assert!(terms("的").is_empty());
        assert_eq!(terms("这个部署"), ["个部", "部署"]);
    }

    #[test]
    fn punctuation_and_spaces_end_a_cjk_run() {
        assert_eq!(terms("部署，迁移 回滚"), ["部署", "迁移", "回滚"]);
    }

    #[test]
    fn latin_text_between_cjk_runs_is_tokenized_as_words() {
        assert_eq!(
            terms("数据库Migration脚本"),
            ["数据", "据库", "migration", "脚本"]
        );
    }

    #[test]
    fn japanese_and_korean_scripts_are_cjk() {
        assert_eq!(terms("テスト"), ["テス", "スト"]);
        assert_eq!(terms("東京へ"), ["東京", "京へ"]);
        assert_eq!(terms("배포 실패"), ["배포", "실패"]);
        assert_eq!(terms("𠀀𠀁"), ["𠀀𠀁"]);
        // Kana Supplement (U+1B001) and Han Extension J (U+323B0).
        assert_eq!(terms("あ\u{1B001}い"), ["あ\u{1B001}", "\u{1B001}い"]);
        assert_eq!(terms("山\u{323B0}川"), ["山\u{323B0}", "\u{323B0}川"]);
        assert_eq!(terms("ㄅㄆ"), ["ㄅㄆ"]);
    }

    #[test]
    fn cjk_punctuation_ends_a_run_and_iteration_marks_join_it() {
        assert!(terms("・").is_empty());
        assert_eq!(terms("カ・ナ"), ["カ", "ナ"]);
        assert_eq!(terms("テスト・ケース"), ["テス", "スト", "ケー", "ース"]);
        assert_eq!(terms("時々刻々"), ["時々", "々刻", "刻々"]);
        assert_eq!(terms("「部署」『迁移』"), ["部署", "迁移"]);
        assert_eq!(terms("ゝ゛ゞ"), ["ゝ", "ゞ"]);
    }

    #[test]
    fn empty_and_punctuation_only_text_has_no_terms() {
        assert!(terms("").is_empty());
        assert!(terms(" ，。!? -- ").is_empty());
    }

    #[test]
    fn ascii_fast_path_splits_like_unicode_words() {
        // Every string of up to 4 bytes over letters, digits, and the
        // characters that join or split words in UAX #29.
        let alphabet = b"aB7_.,;:' -";
        let mut text = Vec::new();
        for len in 1..=4u32 {
            for mut n in 0..alphabet.len().pow(len) {
                text.clear();
                for _ in 0..len {
                    text.push(alphabet[n % alphabet.len()]);
                    n /= alphabet.len();
                }
                let text = std::str::from_utf8(&text).unwrap();
                let mut fast = Vec::new();
                ascii_words(text, |word| fast.push(word));
                assert_eq!(fast, text.unicode_words().collect::<Vec<_>>(), "{text:?}");
            }
        }
        let prose = "e.g. it's 3.14, 1,000;2 a:b x_1 _ __ R2-D2 ok.\n\tdone";
        let mut fast = Vec::new();
        ascii_words(prose, |word| fast.push(word));
        assert_eq!(fast, prose.unicode_words().collect::<Vec<_>>());
    }

    #[test]
    fn stopword_list_is_sorted_and_unique() {
        assert!(STOPWORDS.windows(2).all(|w| w[0] < w[1]));
        assert!(STOPWORDS.iter().all(|w| w.len() <= 10 && is_stopword(w)));
    }
}
