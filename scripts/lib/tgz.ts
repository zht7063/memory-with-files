import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

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
  fs.writeFileSync(destination, gzipSync(Buffer.concat(blocks), { level: 9 }));
}
