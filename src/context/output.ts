import { createRequire } from "node:module";
import { MWFError } from "../storage/index.js";
import type { Result } from "../contracts/result.js";
type Encoder = { encode(text: string, allowed: [], disallowed: []): number[] };
let encoder: Encoder | undefined;
// The o200k_base rank table costs ~3 s to build on slow hosts (issue #30), so it
// is neither imported nor built until the first exact measurement. A long-lived
// process (MCP server, Pi) pays that once and reuses the encoder; short-lived
// hook processes never reach it because they measure with estimateTokens().
function loadEncoder(): Encoder {
  if (encoder) return encoder;
  const require = createRequire(import.meta.url);
  const { Tiktoken } = require("js-tiktoken/lite") as {
    Tiktoken: new (ranks: unknown) => Encoder;
  };
  encoder = new Tiktoken(require("js-tiktoken/ranks/o200k_base"));
  return encoder;
}
export const tokenizerLoaded = () => encoder !== undefined;
export const ESTIMATE_TOKENIZER_ID = "approx_chars_v1";
// Tokenizer-free CONSERVATIVE estimate of the o200k_base count, used on the hook
// path (issue #30). Goal: never below the exact count for natural text and
// structured data, at the price of over-counting (so the hook injects somewhat
// less context than the exact tokenizer would allow). Two hard facts bound it:
// a token covers at least one UTF-8 byte, so the result is clamped to the byte
// length; and everything is rounded up after a 10% margin.
//
// Costs per lexical run (tenths of a token), calibrated against o200k_base on
// prose, code, JSON, markdown, whitespace, URLs, hashes, simplified/traditional
// Chinese, Japanese, Korean, Cyrillic, Greek, Arabic, Thai, Hindi, Vietnamese,
// emoji, combining marks and rare CJK (tests/tokenizer.test.ts):
//  - letter runs: 1 token per 4 chars; digit runs: per 3 (o200k splits digits in
//    threes); letter runs >= 8 chars cost 0.6/char and alphanumeric runs >= 16
//    chars (identifiers, hashes, base64) 0.65/char, because random ASCII measures
//    0.52-0.73 tokens/char
//  - a lone space is free (it prefixes the next word); other whitespace runs cost
//    1 + n/8 (n/4 when they contain "\r", which tokenizes as ~2 per pair)
//  - ASCII punctuation costs 0.7 per char (a same-character run such as "-----" 1 + n/8); control characters 1 each
//  - non-ASCII per character: kana/CJK punctuation 1.1, fullwidth forms 1.5,
//    Han 1.1 and Hangul 0.8 while the text repeats a small character set, but
//    2.0 / 2.2 once >= 64 of them are >70% distinct (rare characters fall back
//    toward one token per byte), combining marks 2, Latin/Greek/Cyrillic/Hebrew/Arabic/Indic/Thai
//    1.0, general punctuation 1.0, symbols/dingbats/other BMP and rare CJK
//    extension A 3.0 (about one token per UTF-8 byte), emoji 2.2, other astral 4.0
// This is a calibrated conservative estimate, not a proof. Known gaps: very
// short random ASCII fragments (<8 letters) and a handful of rare Han characters
// scattered in otherwise ordinary text can exceed their per-run cost. The byte
// clamp and max_output_bytes remain the hard bounds.
function charTenths(c: number) {
  if (c >= 0x3000 && c <= 0x30ff) return 11;
  if (c >= 0xff00 && c <= 0xffef) return 15;
  if (c >= 0x0300 && c <= 0x036f) return 20;
  if (c >= 0x20d0 && c <= 0x20ff) return 20;
  if (c >= 0x0370 && c <= 0x052f) return 7;
  if (c >= 0x0590 && c <= 0x06ff) return 7;
  if (c >= 0x0900 && c <= 0x097f) return 7;
  if (c >= 0x0e00 && c <= 0x0e7f) return 7;
  if (c >= 0x1e00 && c <= 0x1eff) return 7;
  if (c >= 0x0080 && c <= 0x0e7f) return 10;
  if (c >= 0x2000 && c <= 0x206f) return 10;
  if (c >= 0x1f000 && c <= 0x1faff) return 22;
  if (c > 0xffff) return 40;
  return 30;
}
// Han and Hangul cost depends on the text: ordinary prose repeats a small set of
// common characters (cheap in o200k), while many distinct characters means rare
// ones that fall back toward one token per byte.
const wide = (c: number) =>
  c >= 0x4e00 && c <= 0x9fff
    ? 1
    : (c >= 0xac00 && c <= 0xd7af) ||
        (c >= 0x1100 && c <= 0x11ff) ||
        (c >= 0x3130 && c <= 0x318f)
      ? 2
      : 0;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isPunct = (c: number) => c > 32 && c < 127 && !isLetter(c) && !isDigit(c);
export function estimateTokens(text: string) {
  const n = text.length;
  let tenths = 0,
    i = 0;
  const seen = [new Set<number>(), new Set<number>()],
    count = [0, 0];
  while (i < n) {
    const c = text.charCodeAt(i);
    if (isLetter(c) || isDigit(c)) {
      let j = i,
        digits = true,
        letters = true;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (!isLetter(d) && !isDigit(d)) break;
        if (!isDigit(d)) digits = false;
        if (!isLetter(d)) letters = false;
        j++;
      }
      const len = j - i;
      if (digits) tenths += Math.ceil(len / 3) * 10;
      else if (len >= 16) tenths += Math.ceil(len * 6.5);
      else if (letters && len >= 8) tenths += Math.ceil(len * 6);
      else {
        // Short mixed run: price each letter/digit sub-run separately.
        let k = i;
        while (k < j) {
          const letter = isLetter(text.charCodeAt(k));
          let m = k;
          while (m < j && isLetter(text.charCodeAt(m)) === letter) m++;
          tenths += Math.ceil((m - k) / (letter ? 4 : 3)) * 10;
          k = m;
        }
      }
      i = j;
    } else if (isWs(c)) {
      let j = i,
        cr = false;
      while (j < n && isWs(text.charCodeAt(j))) {
        if (text.charCodeAt(j) === 13) cr = true;
        j++;
      }
      const len = j - i;
      if (len === 1 && c === 32) tenths += 0;
      else tenths += (1 + Math.ceil(len / (cr ? 4 : 8))) * 10;
      i = j;
    } else if (isPunct(c)) {
      let j = i;
      while (j < n && isPunct(text.charCodeAt(j))) j++;
      // Price same-character sub-runs ("-----") as one token per 8, others 0.7 each.
      let k = i;
      while (k < j) {
        let m = k + 1;
        while (m < j && text.charCodeAt(m) === text.charCodeAt(k)) m++;
        tenths += m - k > 1 ? (1 + Math.ceil((m - k) / 8)) * 10 : 7;
        k = m;
      }
      tenths = Math.ceil(tenths / 10) * 10;
      i = j;
    } else if (c < 128) {
      tenths += 10;
      i++;
    } else {
      const cp = text.codePointAt(i)!,
        w = wide(cp);
      if (w) {
        seen[w - 1].add(cp);
        count[w - 1]++;
      } else tenths += charTenths(cp);
      i += cp > 0xffff ? 2 : 1;
    }
  }
  // [common, rare] tenths per char: Han 11/20, Hangul 8/22.
  for (const [k, [common, rare]] of [
    [11, 20],
    [8, 22],
  ].entries())
    tenths +=
      count[k] *
      (count[k] >= 64 && seen[k].size / count[k] > 0.7 ? rare : common);
  return Math.min(Math.ceil((tenths * 1.1) / 10), Buffer.byteLength(text));
}
export type Measure = "exact" | "estimate";
export function measure(text: string, mode: Measure = "exact") {
  return {
    reference_tokens:
      mode === "estimate"
        ? estimateTokens(text)
        : loadEncoder().encode(text, [], []).length,
    bytes: Buffer.byteLength(text),
  };
}
export const limits = {
  bootstrap: [1024, 8192],
  recall: [2048, 16384],
  get: [4096, 32768],
} as const;
export type BudgetInput = {
  max_reference_tokens?: number;
  max_output_bytes?: number;
  cursor?: string;
};
export function decodeCursor(cursor: string | undefined, identity: unknown) {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (v.version !== 1 || !Number.isSafeInteger(v.offset) || v.offset < 0)
      throw new Error();
    if (JSON.stringify(v.identity) !== JSON.stringify(identity))
      throw new MWFError("RECORD_CHANGED", "Content changed; restart reading.");
    return v.offset as number;
  } catch (e) {
    if (e instanceof MWFError) throw e;
    throw new MWFError("INVALID_INPUT", "Invalid cursor.");
  }
}
export function encodeCursor(identity: unknown, offset: number) {
  return Buffer.from(JSON.stringify({ version: 1, identity, offset })).toString(
    "base64url",
  );
}
// The same compact JSON is the CLI/MCP model-visible serialization.
export const serialize = (result: unknown) => JSON.stringify(result);
export function boundResult(
  result: Result,
  input: BudgetInput,
  kind: keyof typeof limits,
  page?: { text: string; identity: unknown },
  mode: Measure = "exact",
) {
  const [defaultTokens, defaultBytes] = limits[kind];
  const tokenLimit = input.max_reference_tokens ?? defaultTokens,
    byteLimit = input.max_output_bytes ?? defaultBytes;
  const data = result.data as Record<string, unknown>;
  data.partial ??= false;
  data.omitted ??= { by_budget: 0, by_status: 0, already_loaded: 0 };
  const budget = {
    limit_reference_tokens: tokenLimit,
    used_reference_tokens: 0,
    tokenizer_id: mode === "estimate" ? ESTIMATE_TOKENIZER_ID : "o200k_base",
    max_output_bytes: byteLimit,
    output_bytes: 0,
  };
  data.budget = budget;
  const fits = () => {
    for (let i = 0; i < 12; i++) {
      const text = serialize(result);
      if (Buffer.byteLength(text) > byteLimit) return false;
      const m = measure(text, mode);
      if (
        m.reference_tokens === budget.used_reference_tokens &&
        m.bytes === budget.output_bytes
      )
        return m.reference_tokens <= tokenLimit;
      budget.used_reference_tokens = m.reference_tokens;
      budget.output_bytes = m.bytes;
    }
    throw new MWFError(
      "BUDGET_TOO_SMALL",
      "Could not stabilize output measurement.",
    );
  };
  if (page) {
    const chars = [...page.text],
      start = decodeCursor(input.cursor, page.identity);
    if (start > chars.length)
      throw new MWFError("INVALID_INPUT", "Cursor is beyond content.");
    const render = (n: number) => {
      data.fragment = chars.slice(start, start + n).join("");
      data.partial = start + n < chars.length;
      (data.omitted as { by_budget: number }).by_budget = data.partial ? 1 : 0;
      data.cursor = data.partial
        ? encodeCursor(page.identity, start + n)
        : null;
    };
    let lo = 0,
      hi = Math.min(chars.length - start, byteLimit);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      render(mid);
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    render(lo);
    if (!fits() || (lo === 0 && start < chars.length))
      throw new MWFError(
        "BUDGET_TOO_SMALL",
        "Budget cannot fit a progressing page.",
      );
  } else {
    const entries = data.entries as unknown[] | undefined;
    while (!fits()) {
      if (entries?.length) {
        entries.pop();
        (data.omitted as { by_budget: number }).by_budget++;
        data.partial = true;
      } else if (data.handoff) {
        data.handoff = null;
        data.partial = true;
        (data.omitted as { by_budget: number }).by_budget++;
      } else
        throw new MWFError(
          "BUDGET_TOO_SMALL",
          "Budget cannot fit the minimum result.",
        );
    }
  }
  return result;
}
