import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const bytes = (text: string) => Buffer.from(text, "utf8");
/** Portable ustar archive with fixed ownership/mode/mtime, then deterministic gzip. */
export function npmArchive(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = [];
  for (const path of Object.keys(files).sort()) {
    const name = "package/" + path;
    if (name.length > 100 || name.includes("..")) throw new Error("Invalid SDK archive path");
    const data = bytes(files[path]),
      header = Buffer.alloc(512);
    header.write(name);
    const octal = (offset: number, length: number, value: number) =>
      header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, n) => sum + n, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** ZIP stored entries with fixed DOS date; used for dependency-free Python wheels. */
export function zipFiles(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const path of Object.keys(files).sort()) {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid SDK archive path");
    const name = bytes(path),
      data = bytes(files[path]),
      crc = crc32(data),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function wheelArchive(name: string, version: string, files: Record<string, string>) {
  const normalizedVersion = version.replace(
    /-([0-9A-Za-z.-]+)$/,
    (_match, suffix: string) => ".dev0+sv" + Buffer.from(suffix).toString("hex"),
  );
  const info = `${name}-${normalizedVersion}.dist-info`;
  const content = {
    ...files,
    [`${info}/METADATA`]: `Metadata-Version: 2.1\nName: ${name}\nVersion: ${normalizedVersion}\nRequires-Python: >=3.11\nSummary: Generated HTTP client\n\nSource SDK version: ${version}\n`,
    [`${info}/WHEEL`]: "Wheel-Version: 1.0\nGenerator: postbox\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  };
  const record =
    Object.keys(content)
      .sort()
      .map(
        (path) =>
          `${path},sha256=${createHash("sha256").update(content[path]).digest("base64url")},${Buffer.byteLength(content[path])}`,
      )
      .join("\n") + `\n${info}/RECORD,,\n`;
  content[`${info}/RECORD`] = record;
  return { archive: zipFiles(content), version: normalizedVersion, files: content };
}
