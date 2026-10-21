import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write a classic ZIP with UTF-8 names and raw DEFLATE file data. */
export function zipDirectory(directory: string, destination: string) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0,
    count = 0,
    centralSize = 0;
  function visit(relative: string) {
    for (const entry of fs
      .readdirSync(path.join(directory, relative), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(name);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`ZIP requires regular files: ${name}`);
      const filename = Buffer.from(name),
        data = fs.readFileSync(path.join(directory, name));
      const compressed = deflateRawSync(data),
        crc = crc32(data);
      if (
        filename.length > 0xffff ||
        count >= 0xffff ||
        data.length >= 0xffffffff ||
        compressed.length >= 0xffffffff ||
        offset + 30 + filename.length + compressed.length >= 0xffffffff
      )
        throw new Error("ZIP64 is not supported");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(0x21, 12); // 1980-01-01
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressed.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(filename.length, 26);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      header.copy(record, 6, 4, 30);
      record.writeUInt32LE(offset, 42);
      local.push(header, filename, compressed);
      central.push(record, filename);
      offset += header.length + filename.length + compressed.length;
      centralSize += record.length + filename.length;
      count++;
    }
  }
  visit("");
  if (offset + centralSize >= 0xffffffff)
    throw new Error("ZIP64 is not supported");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(destination, Buffer.concat([...local, ...central, end]));
}
