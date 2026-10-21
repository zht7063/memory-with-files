import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** Minimal deterministic ustar archive of regular files, rooted at package/. */
export function tgzDirectory(directory: string, destination: string) {
  const names: string[] = [];
  function visit(relative: string) {
    for (const entry of fs.readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) names.push(name);
      else throw new Error(`ustar requires regular files: ${name}`);
    }
  }
  visit("");
  names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const blocks: Buffer[] = [];
  for (const relative of names) {
    const name = `package/${relative}`;
    const header = Buffer.alloc(512);
    let leaf = name,
      prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const split = [...name.matchAll(/\//g)]
        .map((match) => match.index)
        .reverse()
        .find(
          (index) =>
            Buffer.byteLength(name.slice(0, index)) <= 155 &&
            Buffer.byteLength(name.slice(index + 1)) <= 100,
        );
      if (split === undefined) throw new Error(`ustar path too long: ${name}`);
      prefix = name.slice(0, split);
      leaf = name.slice(split + 1);
    }
    header.write(leaf, 0, 100);
    function octal(value: number, offset: number, width: number) {
      const digits = value.toString(8);
      if (digits.length >= width) throw new Error("ustar numeric overflow");
      header.write(digits.padStart(width - 1, "0") + "\0", offset, width);
    }
    const data = fs.readFileSync(path.join(directory, relative));
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(prefix, 345, 155);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(blocks), { level: 9 });
  compressed[9] = 255; // Unknown OS, independent of the build platform.
  fs.writeFileSync(destination, compressed);
}

/** Extract npm's ustar files, including POSIX extended path headers. */
export function extractTgz(compressed: Buffer, destination: string) {
  const tar = gunzipSync(compressed);
  let extendedPath: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString()
        .split("\0")[0];
    const size = parseInt(field(124, 12), 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    )
      throw new Error("Invalid tar entry size");
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = field(156, 1);
    if (type === "x") {
      for (let cursor = 0; cursor < data.length; ) {
        const space = data.indexOf(32, cursor);
        const length = Number(data.subarray(cursor, space).toString());
        if (
          space < cursor ||
          !Number.isSafeInteger(length) ||
          length <= space - cursor + 1 ||
          cursor + length > data.length
        )
          throw new Error("Invalid tar extended header");
        const record = data.subarray(space + 1, cursor + length - 1).toString();
        if (record.startsWith("path=")) extendedPath = record.slice(5);
        cursor += length;
      }
      continue;
    }
    const prefix = field(345, 155);
    const name = extendedPath ?? (prefix ? prefix + "/" : "") + field(0, 100);
    extendedPath = undefined;
    if (
      !name.startsWith("package/") ||
      name.split("/").some((part) => part === "..") ||
      name.includes("\\")
    )
      throw new Error(`Unsafe tar path: ${name}`);
    const target = path.join(destination, name);
    if (type === "5") fs.mkdirSync(target, { recursive: true });
    else if (type === "0" || type === "") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    } else throw new Error(`Unsupported tar entry type: ${type}`);
  }
}
