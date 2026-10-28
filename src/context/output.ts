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
// Tokenizer-free upper-leaning approximation of the o200k_base count, used on
// the hook path. Counts per lexical run instead of per byte: letter runs 1 token
// per 4 chars, digit runs per 3 (o200k splits digits in threes), a lone space is
// free (it prefixes the next word), other whitespace runs and each punctuation
// char cost 1, CJK/kana/fullwidth 0.8, other BMP non-ASCII 1, astral 2; a 10%
// margin is added. Measured against o200k_base it stays within 1.0-1.6x on
// prose, code, JSON and hex hashes (tests/tokenizer.test.ts). Random base64 is
// the known exception and is not expected in memory output.
const RUN =
  /[A-Za-z]+|[0-9]+|[ \t\r\n]+|[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]|[^\u0000-\u007f\u{10000}-\u{10ffff}]|[\u{10000}-\u{10ffff}]|[\s\S]/gu;
export function estimateTokens(text: string) {
  let tenths = 0;
  for (const m of text.matchAll(RUN)) {
    const run = m[0],
      c = run.codePointAt(0)!;
    if (c >= 65 && c <= 122 && /^[A-Za-z]/.test(run))
      tenths += Math.ceil(run.length / 4) * 10;
    else if (c >= 48 && c <= 57) tenths += Math.ceil(run.length / 3) * 10;
    else if (c === 32 || c === 9 || c === 10 || c === 13)
      tenths += run === " " ? 0 : 10;
    else if (c < 128) tenths += 10;
    else if (c > 0xffff) tenths += 20;
    else if (
      (c >= 0x3000 && c <= 0x30ff) ||
      (c >= 0x3400 && c <= 0x9fff) ||
      (c >= 0xff00 && c <= 0xffef)
    )
      tenths += 8;
    else tenths += 10;
  }
  return Math.ceil((tenths * 1.1) / 10);
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
