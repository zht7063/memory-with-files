import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import { MWFError } from "../storage/index.js";
import type { Result } from "../contracts/result.js";
let encoder: Tiktoken | undefined;
export function measure(text: string) {
  encoder ??= new Tiktoken(ranks);
  return {
    reference_tokens: encoder.encode(text, [], []).length,
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
    tokenizer_id: "o200k_base",
    max_output_bytes: byteLimit,
    output_bytes: 0,
  };
  data.budget = budget;
  const fits = () => {
    for (let i = 0; i < 12; i++) {
      const text = serialize(result);
      if (Buffer.byteLength(text) > byteLimit) return false;
      const m = measure(text);
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
