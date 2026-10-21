import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { zipDirectory } from "../scripts/lib/zip.ts";

// Read the central directory independently, then inflate and validate every entry.
function unzip(zip: Buffer) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const files = new Map<string, Buffer>();
  let cursor = zip.readUInt32LE(end + 16);
  const start = cursor;
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const length = zip.readUInt16LE(cursor + 28);
    const name = zip.subarray(cursor + 46, cursor + 46 + length).toString();
    const offset = zip.readUInt32LE(cursor + 42);
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    assert.equal(zip.readUInt16LE(cursor + 10), 8);
    assert.equal(zip.readUInt16LE(offset + 6), 0x800);
    const dataStart =
      offset +
      30 +
      zip.readUInt16LE(offset + 26) +
      zip.readUInt16LE(offset + 28);
    assert.equal(
      zip.subarray(offset + 30, offset + 30 + length).toString(),
      name,
    );
    const data = inflateRawSync(
      zip.subarray(dataStart, dataStart + zip.readUInt32LE(cursor + 20)),
    );
    assert.equal(data.length, zip.readUInt32LE(cursor + 24));
    // Independent bitwise CRC implementation, separate from the writer.
    let crc = -1;
    for (const byte of data) {
      let value = (crc ^ byte) & 255;
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      crc = (crc >>> 8) ^ value;
    }
    assert.equal((crc ^ -1) >>> 0, zip.readUInt32LE(cursor + 16));
    assert.equal(zip.readUInt32LE(offset + 14), zip.readUInt32LE(cursor + 16));
    assert.ok(!files.has(name));
    files.set(name, data);
    cursor +=
      46 +
      length +
      zip.readUInt16LE(cursor + 30) +
      zip.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(cursor - start, zip.readUInt32LE(end + 12));
  return files;
}

test("pure Node ZIP round-trips nested UTF-8, empty and binary files", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-zip-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, "source");
  fs.mkdirSync(path.join(source, "目录"), { recursive: true });
  const expected = new Map([
    ["目录/hello.txt", Buffer.from("hello world\n".repeat(100))],
    ["empty", Buffer.alloc(0)],
    ["binary", Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
  ]);
  for (const [name, bytes] of expected)
    fs.writeFileSync(path.join(source, name), bytes);
  const output = path.join(base, "test.zip");
  zipDirectory(source, output);
  assert.deepEqual(
    unzip(fs.readFileSync(output)),
    new Map([...expected].sort(([a], [b]) => a.localeCompare(b))),
  );
});

test(
  "packed Codex release includes matching manifest and complete runtime",
  { timeout: 180_000 },
  () => {
    execFileSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/pack-release.ts"],
      { timeout: 150_000 },
    );
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const files = unzip(
      fs.readFileSync(`releases/mwf-codex-${pkg.version}.zip`),
    );
    const manifest = JSON.parse(files.get("plugin.json")!.toString());
    const runtime = JSON.parse(files.get("runtime/package.json")!.toString());
    const source = JSON.parse(
      fs.readFileSync("packaging/codex/plugin.json", "utf8"),
    );
    assert.equal(source.version, pkg.version);
    assert.equal(manifest.version, pkg.version);
    assert.equal(runtime.version, manifest.version);
    for (const name of [
      "runtime/dist/cli.js",
      "runtime/dist/core.js",
      "hooks/hooks.json",
      "skills/setup/SKILL.md",
      "runtime/node_modules/js-tiktoken/package.json",
    ])
      assert.ok(files.has(name), `Missing ${name}`);
  },
);
