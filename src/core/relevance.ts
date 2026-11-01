/**
 * Relevance of a stored record to a free-text message, for hook auto-recall (`min_relevance`).
 *
 * The FTS index is a trigram index queried with OR, so a prompt full of ordinary words ("with",
 * "the", "reply") matches almost any record. bm25 is no help on a small project (IDF is about 0 and
 * the scale is unstable), so the judgement is made on distinctive terms instead:
 *  - stopwords (English, and a few Chinese question words) and terms shorter than 3 characters
 *    carry no weight, except an allow-list of 2-character technical terms (`db`, `ci`, `k8`, …);
 *  - a term found in the title scores 2, one found only in the body scores 1 (each distinct term
 *    once; the title and body text are the full stored text, lower-cased);
 *  - a Chinese / Japanese / Korean run is cut into 3-character pieces (as the index does); the run
 *    counts as ONE term and only when at least `CJK_MIN_PIECES` of its distinct pieces are found,
 *    so one coincidental 3-character match ("怎么样") is not enough;
 *  - 2-character allow-listed terms match whole tokens only ("go" does not match "google").
 */

export const DEFAULT_RECALL_MIN_SCORE = 2;
export const MAX_RECALL_MIN_SCORE = 20;
/** A CJK run counts only when this many of its distinct 3-character pieces match (or all, for a short run). */
export const CJK_MIN_PIECES = 2;

const STOPWORDS_EN = `
a about above after again all also am an and any are as at be because been before being below
between both but by can could did do does doing done down during each else even ever every few for
from further had has have having he her here hers him his how i if in into is it its just let like
me more most my no nor not now of off on once one only or other our out over own same she should
so some such than that the their them then there these they this those through to too under until
up very was we were what when where which while who whom why will with would you your yours
please ok okay yes thanks thank hello hey hi sure right well got get gets make made say said says
tell told ask asked answer answers reply replies word words exactly nothing anything something
sentence sentences short brief briefly explain remind call calls tool tools use used using need
want wants try next continue again also still keep given give take took see look check
`
  .split(/\s+/)
  .filter(Boolean);

/** Chinese question / filler pieces that appear in many notes and mean nothing on their own. */
const STOPWORDS_CJK = `
为什么 怎么样 怎么办 怎么了 是什么 什么是 什么样 有没有 能不能 可不可以 可以吗 好不好 对不对
是不是 要不要 行不行 多少钱 什么时候 一下子 不知道 我们的 你们的 他们的 这个是 那个是
`
  .split(/\s+/)
  .filter(Boolean);

/** Two-character technical terms that count (everything else under 3 characters does not). */
const SHORT_TECH = new Set([
  'ai',
  'ci',
  'cd',
  'db',
  'go',
  'io',
  'ip',
  'js',
  'k8',
  'ml',
  'os',
  'pr',
  'py',
  'qa',
  'rs',
  'tf',
  'ts',
  'ui',
  'ux',
  'vm',
]);
/** Short terms that are also ordinary English words: they never score more than 1 on their own. */
const SHORT_AMBIGUOUS = new Set(['go', 'io', 'ip', 'os', 'pr']);

const STOP = new Set([...STOPWORDS_EN, ...STOPWORDS_CJK]);
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;
const MAX_TERMS = 40;

export interface ScoringTerm {
  /** Lower-cased pieces: one for an ordinary word, the 3-character pieces for a CJK run. */
  pieces: string[];
  cjk: boolean;
  /** Short allow-listed term: whole-token match, and capped at 1 when ambiguous. */
  short: boolean;
  /** Pieces that must match for the term to count. */
  need: number;
  cap: number;
}

/** The distinctive terms of a query; empty means the message has nothing to look up. */
export function scoringTerms(query: string, cjkMinPieces = CJK_MIN_PIECES): ScoringTerm[] {
  const out: ScoringTerm[] = [];
  const seen = new Set<string>();
  let budget = MAX_TERMS;
  for (const run of query.match(/[\p{L}\p{N}_.-]+/gu) ?? []) {
    // Sentence punctuation sticks to words ("else."); inner dots stay ("a.sh").
    const key = run.toLowerCase().replace(/^[._-]+|[._-]+$/gu, '');
    if (!key || seen.has(key) || budget <= 0) continue;
    seen.add(key);
    const chars = [...key];
    if (CJK_RE.test(key)) {
      const pieces: string[] = [];
      if (chars.length > 3) {
        for (let i = 0; i + 3 <= chars.length; i++) pieces.push(chars.slice(i, i + 3).join(''));
      } else if (chars.length === 3) pieces.push(key);
      const kept = [...new Set(pieces)].filter((p) => !STOP.has(p));
      if (!kept.length) continue;
      budget -= kept.length;
      out.push({
        pieces: kept,
        cjk: true,
        short: false,
        need: Math.min(cjkMinPieces, kept.length),
        cap: 2,
      });
    } else if (chars.length >= 3) {
      if (STOP.has(key)) continue;
      budget--;
      out.push({ pieces: [key], cjk: false, short: false, need: 1, cap: 2 });
    } else if (SHORT_TECH.has(key)) {
      budget--;
      out.push({
        pieces: [key],
        cjk: false,
        short: true,
        need: 1,
        cap: SHORT_AMBIGUOUS.has(key) ? 1 : 2,
      });
    }
  }
  return out;
}

function hasToken(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : (text[at - 1] as string);
    const after = text[at + token.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = at + 1;
  }
}

/** Score a record (title + body) against the distinctive terms of the query. */
export function relevanceScore(terms: ScoringTerm[], title: string, body: string): number {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const inText = (text: string): number =>
      term.short
        ? Number(hasToken(text, term.pieces[0] as string))
        : term.pieces.filter((p) => text.includes(p)).length;
    const inTitle = inText(t);
    const inAny = term.short
      ? Number(inTitle > 0 || hasToken(b, term.pieces[0] as string))
      : term.pieces.filter((p) => t.includes(p) || b.includes(p)).length;
    if (inTitle >= term.need) score += Math.min(2, term.cap);
    else if (inAny >= term.need) score += 1;
  }
  return score;
}

/** All search terms a scoring query needs from the index (for candidate retrieval). */
export function searchTermsOf(terms: ScoringTerm[]): string[] {
  return terms.flatMap((t) => t.pieces);
}
