import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { estimateTokens, measure } from "../dist/context/output.js";

test("offline o200k_base matches independent Python reference vectors", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/o200k-reference.json", import.meta.url),
      "utf8",
    ),
  );
  const tokenizer = new Tiktoken(ranks);
  for (const vector of fixture.vectors) {
    assert.deepEqual(tokenizer.encode(vector.text, [], []), vector.ids);
    assert.equal(measure(vector.text).reference_tokens, vector.ids.length);
    assert.equal(measure(vector.text).bytes, Buffer.byteLength(vector.text));
  }
});

test("hook-path estimate stays between 1.0x and 2x of o200k_base on prose, code, JSON, CJK and hashes", () => {
  const tokenizer = new Tiktoken(ranks);
  const repo = new URL("../", import.meta.url);
  const hex = Array.from({ length: 40 }, (_, i) =>
    createHash("sha256").update(String(i)).digest("hex"),
  ).join('","');
  const samples = [
    ...[
      "readme.md",
      "CHANGELOG.md",
      "src/core/index.ts",
      "package-lock.json",
    ].map((f) => fs.readFileSync(new URL(f, repo), "utf8")),
    "代理设置与失效条件，中文测试内容需要在这里保持稳定。".repeat(80),
    "😀🧪🚀".repeat(100),
    hex,
    JSON.stringify({
      ok: true,
      data: {
        entries: Array.from({ length: 20 }, (_, i) => ({
          id: "PREF-20261028-" + i,
          content_hash: createHash("sha256")
            .update("x" + i)
            .digest("hex"),
          summary: "Use pnpm not npm in this repo",
        })),
      },
    }),
  ];
  for (const text of samples) {
    const exact = tokenizer.encode(text, [], []).length;
    const estimate = estimateTokens(text);
    assert.ok(estimate >= exact, `underestimate ${estimate} < ${exact}`);
    assert.ok(estimate <= exact * 2, `too loose ${estimate} > 2*${exact}`);
    assert.equal(measure(text, "estimate").reference_tokens, estimate);
  }
  assert.equal(estimateTokens(""), 0);
});

test("tokenizer is lazy: estimate mode never loads it, exact mode loads once and reuses it", () => {
  const script = `
    import { measure, tokenizerLoaded } from ${JSON.stringify(new URL("../dist/context/output.js", import.meta.url).href)};
    const out = [tokenizerLoaded()];
    measure("hello world", "estimate");
    out.push(tokenizerLoaded());
    const a = measure("hello world").reference_tokens;
    out.push(tokenizerLoaded());
    const t0 = performance.now();
    const b = measure("hello world again").reference_tokens;
    out.push(performance.now() - t0 < 200, a, b > 0);
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [false, false, true, true, 2, true]);
});
