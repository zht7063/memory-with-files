import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";
import { measure } from "../dist/context/output.js";

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
