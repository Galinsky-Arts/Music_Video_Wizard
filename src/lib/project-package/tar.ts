import { createWriteStream } from "node:fs";
import { once } from "node:events";
import type { Readable } from "node:stream";

/**
 * Minimal POSIX ustar support for project packages: regular files only, short
 * safe names, streamed so memory stays bounded regardless of package size.
 */
export const TAR_BLOCK = 512;

function octal(value: number, length: number) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

export function tarHeader(name: string, size: number, mtimeSeconds = 0): Buffer {
  if (!isSafeEntryName(name)) throw new Error("Unsafe package entry name: " + name);
  if (!Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) {
    throw new Error("Package entry size is out of range.");
  }
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(Math.max(0, Math.floor(mtimeSeconds)), 12), 136, 12, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

export function tarPadding(size: number): Buffer {
  const remainder = size % TAR_BLOCK;
  return Buffer.alloc(remainder ? TAR_BLOCK - remainder : 0, 0);
}

export function tarEnd(): Buffer {
  return Buffer.alloc(TAR_BLOCK * 2, 0);
}

/** Only flat, known entry names: no traversal, absolute paths or links. */
export function isSafeEntryName(name: string) {
  return name === "manifest.json" ||
    name === "checksums.json" ||
    /^media\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/.test(name);
}

export interface ExtractedEntry {
  name: string;
  size: number;
  path: string;
}

function parseOctal(field: Buffer) {
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("Invalid tar numeric field.");
  return text ? parseInt(text, 8) : 0;
}

function verifyChecksum(header: Buffer) {
  const expected = parseOctal(header.subarray(148, 156));
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (sum !== expected) throw new Error("Package header checksum mismatch.");
}

/**
 * Streams a tar archive to files under `directory` (named by index, never by
 * the untrusted entry name). Enforces entry count and total byte limits.
 */
export async function extractTar(input: Readable, options: {
  directory: string;
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
}): Promise<ExtractedEntry[]> {
  const entries: ExtractedEntry[] = [];
  const names = new Set<string>();
  let buffer = Buffer.alloc(0);
  let total = 0;
  let ended = false;
  let current: { name: string; remaining: number; padding: number; stream: ReturnType<typeof createWriteStream> } | null = null;

  const startEntry = (header: Buffer) => {
    if (header.every((byte) => byte === 0)) {
      ended = true;
      return;
    }
    verifyChecksum(header);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const type = String.fromCharCode(header[156]!);
    const size = parseOctal(header.subarray(124, 136));
    if (prefix || !isSafeEntryName(name) || (type !== "0" && type !== "\0")) {
      throw new Error("Package contains an unsupported or unsafe entry.");
    }
    if (names.has(name)) throw new Error("Package contains a duplicate entry: " + name);
    if (entries.length >= options.maxEntries) throw new Error("Package contains too many entries.");
    if (size > options.maxEntryBytes) throw new Error("Package entry exceeds the size limit: " + name);
    total += size;
    if (total > options.maxTotalBytes) throw new Error("Package exceeds the total size limit.");
    names.add(name);
    const path = options.directory + "/entry-" + String(entries.length);
    entries.push({ name, size, path });
    current = { name, remaining: size, padding: tarPadding(size).length, stream: createWriteStream(path, { mode: 0o600 }) };
  };

  for await (const chunk of input) {
    if (ended) continue;
    buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : Buffer.from(chunk as Buffer);
    while (!ended) {
      if (current) {
        const active = current as { remaining: number; padding: number; stream: ReturnType<typeof createWriteStream> };
        if (active.remaining > 0) {
          if (!buffer.length) break;
          const take = Math.min(active.remaining, buffer.length);
          if (!active.stream.write(buffer.subarray(0, take))) await once(active.stream, "drain");
          buffer = buffer.subarray(take);
          active.remaining -= take;
          continue;
        }
        if (buffer.length < active.padding) break;
        buffer = buffer.subarray(active.padding);
        active.stream.end();
        await once(active.stream, "close");
        current = null;
        continue;
      }
      if (buffer.length < TAR_BLOCK) break;
      const header = buffer.subarray(0, TAR_BLOCK);
      buffer = buffer.subarray(TAR_BLOCK);
      startEntry(header);
    }
  }
  if (current || !ended) {
    const open = current as { stream: ReturnType<typeof createWriteStream> } | null;
    open?.stream.destroy();
    throw new Error("Package archive is truncated.");
  }
  return entries;
}
