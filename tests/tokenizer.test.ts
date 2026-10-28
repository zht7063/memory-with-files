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

// Deterministic high-entropy text (sha256 stream), unlike a low-bit LCG which
// repeats and compresses far better than real hashes or secrets.
function rnd(alphabet: string, n: number, seed: number) {
  let out = "";
  for (let i = 0; out.length < n; i++)
    for (const b of createHash("sha256").update(`${seed}:${i}`).digest())
      if (out.length < n) out += alphabet[b % alphabet.length];
  return out;
}
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    String.fromCodePoint(from + i),
  ).join("");

test("hook-path estimate is conservative (>= o200k_base, <= bytes) on prose, code, JSON, whitespace and every script", () => {
  const tokenizer = new Tiktoken(ranks);
  const repo = new URL("../", import.meta.url);
  const file = (f: string) => fs.readFileSync(new URL(f, repo), "utf8");
  const hex = Array.from({ length: 40 }, (_, i) =>
    createHash("sha256").update(String(i)).digest("hex"),
  );
  // [name, text, max allowed over-estimate]; the cap keeps the estimate useful,
  // the lower bound (>= exact) is the contract.
  const samples: [string, string, number][] = [
    ["readme", file("readme.md"), 2.5],
    ["changelog", file("CHANGELOG.md"), 2.5],
    ["typescript", file("src/core/index.ts"), 2.5],
    ["package-lock json", file("package-lock.json").slice(0, 8000), 2.5],
    ["hex hashes", hex.join('","'), 2.5],
    [
      "result json",
      JSON.stringify({
        ok: true,
        data: Array.from({ length: 20 }, (_, i) => ({
          id: "PREF-20261028-" + i,
          content_hash: hex[i],
          summary: "Use pnpm not npm in this repo",
        })),
      }),
      2.5,
    ],
    [
      "simplified chinese",
      "代理设置与失效条件，中文测试内容需要在这里保持稳定。".repeat(80),
      2.5,
    ],
    [
      "traditional chinese",
      "記憶體載入時間過長導致逾時，請重新啟動並檢查設定檔案。".repeat(40),
      2.5,
    ],
    ["rare han (distinct)", range(0x7120, 0x7120 + 800), 3],
    ["rare han ext A", range(0x3400, 0x3400 + 800), 3],
    ["rare han ext B", range(0x20000, 0x20000 + 500), 3],
    [
      "japanese",
      "これはメモリの読み込みに関するテストです。漢字とカタカナ。".repeat(40),
      2.5,
    ],
    [
      "korean",
      "이것은 메모리 로딩에 대한 테스트입니다. 한글 문장입니다.".repeat(40),
      3,
    ],
    ["hangul (distinct)", range(0xac00, 0xac00 + 800), 3],
    [
      "cyrillic",
      "Это тест загрузки памяти и тайм-аута хука при запуске ".repeat(40),
      3,
    ],
    [
      "greek",
      "Αυτή είναι μια δοκιμή φόρτωσης μνήμης και χρονικού ορίου ".repeat(40),
      3,
    ],
    [
      "arabic",
      "هذا اختبار لتحميل الذاكرة والمهلة الزمنية للخطاف ".repeat(40),
      3,
    ],
    ["thai", "นี่คือการทดสอบการโหลดหน่วยความจำและการหมดเวลา".repeat(40), 3],
    ["hindi", "यह मेमोरी लोडिंग और टाइमआउट का परीक्षण है ".repeat(40), 3],
    [
      "vietnamese",
      "Đây là bài kiểm tra tải bộ nhớ và thời gian chờ của hook ".repeat(40),
      3,
    ],
    [
      "accented latin",
      "Ünïcödé façade naïve coöperate Ångström Łódź Ñandú Čeština ".repeat(60),
      3,
    ],
    [
      "mixed zh/en",
      "使用 `mwf_recall` 读取 PREF-0001 的摘要，timeout=5s，路径 src/mcp.ts。".repeat(
        40,
      ),
      2.5,
    ],
    ["emoji", "😀🧪🚀😃😄😁😆😅🤣😂".repeat(60), 3],
    ["emoji zwj/flags/skin", "👨‍👩‍👧‍👦🇨🇳🇺🇸👍🏽🧑🏾‍💻".repeat(60), 3],
    ["bmp symbols", range(0x2600, 0x2600 + 400), 3],
    ["combining marks", "e\u0301\u0302\u0303\u0304\u0305\u0306".repeat(200), 3],
    [
      "zalgo",
      "Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319".repeat(
        80,
      ),
      3,
    ],
    ["fullwidth ascii", range(0xff21, 0xff21 + 26).repeat(30), 3],
    ["indentation", "            x\n    y\n\t\tz\n".repeat(300), 3],
    ["newlines", "\n".repeat(2000), 4],
    ["crlf", "line\r\n".repeat(500), 3],
    ["blank lines + spaces", "a\n\n\n    \n\n\t\n b".repeat(200), 3],
    ["spaces only", " ".repeat(500), 600],
    [
      "urls",
      "https://example.com/path/to/resource?query=1&x=2#frag ".repeat(60),
      3,
    ],
    ["random letters", rnd("abcdefghijklmnopqrstuvwxyz", 3000, 1), 3],
    ["random hex", rnd("0123456789abcdef", 3000, 9), 3],
    ["random digits", rnd("0123456789", 3000, 11), 3],
    ["random alnum", rnd("abcdefghijklmnopqrstuvwxyz0123456789", 3000, 3), 3],
    [
      "random base64",
      rnd(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
        3000,
        5,
      ),
      4,
    ],
    [
      "random punctuation",
      rnd("!@#$%^&*()_+-=[]{};:'\",.<>/?\\|`~", 3000, 13),
      6,
    ],
    ["control chars", rnd("\u0001\u0002\u0003\u0007\u001b", 1000, 2), 3],
  ];
  for (const [name, text, cap] of samples) {
    const exact = tokenizer.encode(text, [], []).length;
    const estimate = estimateTokens(text);
    assert.ok(
      estimate >= exact,
      `${name}: underestimate ${estimate} < ${exact}`,
    );
    assert.ok(
      estimate <= Buffer.byteLength(text),
      `${name}: above the one-token-per-byte bound`,
    );
    assert.ok(
      estimate <= exact * cap,
      `${name}: too loose ${estimate} > ${cap}*${exact}`,
    );
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
