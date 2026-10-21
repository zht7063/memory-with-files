import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
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

// Independent ustar reader, including prefix fields and header checksums.
function untgz(compressed: Buffer) {
  const tar = gunzipSync(compressed);
  const files = new Map<string, Buffer>();
  let previous = Buffer.alloc(0);
  for (let offset = 0; offset < tar.length - 1024; ) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString()
        .split("\0")[0];
    assert.equal(field(257, 6), "ustar");
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    assert.equal(parseInt(field(148, 8), 8), checksum);
    assert.equal(parseInt(field(100, 8), 8), 0o644);
    for (const [start, length] of [
      [108, 8],
      [116, 8],
      [136, 12],
    ])
      assert.equal(parseInt(field(start, length), 8), 0);
    const prefix = field(345, 155);
    const name = (prefix ? prefix + "/" : "") + field(0, 100);
    assert.ok(name.startsWith("package/"));
    assert.ok(Buffer.compare(previous, Buffer.from(name)) < 0);
    previous = Buffer.from(name);
    const size = parseInt(field(124, 12), 8);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.subarray(-1024).every((byte) => byte === 0));
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
  "packed releases are deterministic and include complete Codex and Pi runtimes",
  { timeout: 180_000 },
  async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "mwf-release-test-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const npmPack = JSON.parse(
      (
        await promisify(execFile)(
          "npm",
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            base,
            "--cache",
            path.join(base, "cache"),
          ],
          { encoding: "utf8" },
        )
      ).stdout,
    );
    await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "scripts/pack-release.ts"],
      { timeout: 150_000 },
    );
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const filename = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
    const tgz = fs.readFileSync(path.join("releases", filename));
    const zipBefore = fs.readFileSync(`releases/mwf-codex-${pkg.version}.zip`);
    const hash = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "scripts/pack-release.ts"],
      { timeout: 150_000 },
    );
    assert.equal(
      hash(fs.readFileSync(path.join("releases", filename))),
      hash(tgz),
    );
    assert.equal(
      hash(fs.readFileSync(`releases/mwf-codex-${pkg.version}.zip`)),
      hash(zipBefore),
    );
    assert.equal(tgz[9], 255);
    const tar = untgz(tgz);
    assert.deepEqual(
      [...tar.keys()].sort(),
      npmPack[0].files
        .map((file: { path: string }) => `package/${file.path}`)
        .sort(),
    );
    const packed = JSON.parse(tar.get("package/package.json")!.toString());
    assert.ok(Array.isArray(packed.pi.extensions));
    assert.ok(packed.pi.extensions.length > 0);
    for (const extension of packed.pi.extensions)
      assert.ok(
        tar.has(`package/${extension.replace(/^\.\//, "")}`),
        extension,
      );
    assert.ok(!tar.has("package/scripts/pack-release.ts"));
    assert.ok(!tar.has("package/package-lock.json"));
    assert.ok(tar.has("package/readme.md"));
    assert.ok(tar.has("package/LICENSE"));
    assert.ok(
      fs
        .readFileSync("releases/SHA256SUMS", "utf8")
        .split("\n")
        .includes(`${hash(tgz)}  ${filename}`),
    );
    const status = JSON.parse(
      fs.readFileSync("releases/RELEASE-STATUS.json", "utf8"),
    );
    assert.ok(status.artifacts.includes(filename));
    const files = unzip(
      fs.readFileSync(`releases/mwf-codex-${pkg.version}.zip`),
    );
    for (const [directory, entries, entrypoint] of [
      ["pi", tar, "package/dist/integrations/pi/index.js"],
      ["codex", files, "runtime/dist/mcp.js"],
    ] as const) {
      const extracted = path.join(base, directory);
      for (const [name, data] of entries) {
        const target = path.join(extracted, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
      }
      await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(pathToFileURL(path.join(extracted, entrypoint)).href)})`,
        ],
        { cwd: extracted, timeout: 30_000 },
      );
    }
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
