import { open, readFile, stat } from 'node:fs/promises';

/**
 * A minimal, dependency-free ZIP writer.
 *
 * Deliberately STORE-only (compression method 0). The payload is JPEG frames,
 * which are already compressed — deflating them buys a percent or two for the
 * cost of pulling the whole pipeline through zlib — and a stored archive is the
 * simplest structure the format has, which matters when the alternative is
 * trusting a hand-rolled implementation of something more elaborate. The result
 * is an ordinary `.zip` that every extractor opens.
 *
 * Adding a packaging dependency was the other option. This is ~100 lines against
 * a new entry in a tree that `npm audit` gates on every release, for a format
 * whose stored variant has not changed since 1989.
 */

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry header carries. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS packed date/time — what ZIP stores instead of a Unix timestamp.
 *
 * Seconds have 1-bit-per-2-seconds resolution and the epoch is 1980, so an
 * earlier date is clamped rather than written as a negative year that some
 * extractors reject.
 */
export function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(when.getFullYear(), 1980);
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time, date };
}

/** 4 GiB — the ceiling of the 32-bit size fields. Beyond it ZIP64 is required. */
const ZIP32_LIMIT = 0xffffffff;

/** Bit 11 of the general-purpose flags: entry names are UTF-8, not CP437. */
const UTF8_NAME_FLAG = 0x0800;

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;

export interface ZipEntry {
  /**
   * Path inside the archive. Always forward slashes — the format mandates them
   * regardless of host OS, and a backslash here produces a file literally named
   * `frames\\001.jpg` on extraction rather than a `frames` directory.
   */
  name: string;
  /** File to read the bytes from. Mutually exclusive with `data`. */
  sourcePath?: string;
  /** Literal content. Mutually exclusive with `sourcePath`. */
  data?: Buffer | string;
  /** Modification time recorded for the entry. Defaults to the source file's. */
  modified?: Date;
}

export interface ZipResult {
  path: string;
  /** Size of the finished archive in bytes. */
  bytes: number;
  /** Entry names actually written, in archive order. */
  names: string[];
}

/**
 * Write `entries` to `outputPath` as a ZIP archive.
 *
 * Entries are streamed one at a time — each file is read, written and released
 * before the next is opened — so peak memory is one frame, not the whole
 * bundle. Directories are implied by the entry paths (`frames/001.jpg` creates
 * `frames/`), which is what every extractor does with them.
 *
 * Throws on a ZIP64-sized input rather than emitting a truncated 32-bit header,
 * which would produce an archive that opens and silently yields the wrong bytes.
 */
export async function writeZipArchive(outputPath: string, entries: ZipEntry[]): Promise<ZipResult> {
  const handle = await open(outputPath, 'w');
  const central: Buffer[] = [];
  const names: string[] = [];
  let offset = 0;

  const put = async (chunk: Buffer): Promise<void> => {
    await handle.write(chunk);
    offset += chunk.length;
  };

  try {
    for (const entry of entries) {
      const data = await entryData(entry);
      if (data.length > ZIP32_LIMIT) {
        throw new Error(
          `Cannot add "${entry.name}" to the archive: ${data.length} bytes exceeds the 4 GiB ZIP limit.`,
        );
      }

      const name = Buffer.from(entry.name, 'utf8');
      const { time, date } = dosDateTime(entry.modified ?? (await entryMtime(entry)));
      const checksum = crc32(data);
      const localOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
      local.writeUInt16LE(20, 4); // version needed: 2.0
      local.writeUInt16LE(UTF8_NAME_FLAG, 6);
      local.writeUInt16LE(0, 8); // method: stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18); // compressed size
      local.writeUInt32LE(data.length, 22); // uncompressed size
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // extra field length

      await put(local);
      await put(name);
      await put(data);

      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
      record.writeUInt16LE(20, 4); // version made by
      record.writeUInt16LE(20, 6); // version needed
      record.writeUInt16LE(UTF8_NAME_FLAG, 8);
      record.writeUInt16LE(0, 10); // method: stored
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(date, 14);
      record.writeUInt32LE(checksum, 16);
      record.writeUInt32LE(data.length, 20);
      record.writeUInt32LE(data.length, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt16LE(0, 30); // extra field length
      record.writeUInt16LE(0, 32); // comment length
      record.writeUInt16LE(0, 34); // disk number start
      record.writeUInt16LE(0, 36); // internal attributes
      record.writeUInt32LE(0, 38); // external attributes
      record.writeUInt32LE(localOffset, 42);

      central.push(record, name);
      names.push(entry.name);
    }

    const centralOffset = offset;
    for (const chunk of central) await put(chunk);
    const centralSize = offset - centralOffset;

    if (centralOffset > ZIP32_LIMIT) {
      throw new Error('Cannot write the archive: total size exceeds the 4 GiB ZIP limit.');
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIR_SIGNATURE, 0);
    end.writeUInt16LE(0, 4); // this disk
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(names.length, 8);
    end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20); // comment length
    await put(end);

    return { path: outputPath, bytes: offset, names };
  } finally {
    await handle.close();
  }
}

async function entryData(entry: ZipEntry): Promise<Buffer> {
  if (entry.data !== undefined) {
    return Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
  }
  if (!entry.sourcePath) {
    throw new Error(`Archive entry "${entry.name}" has neither sourcePath nor data.`);
  }
  return readFile(entry.sourcePath);
}

async function entryMtime(entry: ZipEntry): Promise<Date> {
  if (!entry.sourcePath) return new Date();
  try {
    return (await stat(entry.sourcePath)).mtime;
  } catch {
    return new Date();
  }
}

/**
 * A filename safe on every platform this server runs on.
 *
 * Windows rejects `:` outright, which rules out using a `M:SS` timestamp
 * verbatim — the same trap `copyFrames` documents for frame basenames.
 *
 * Sanitizes the WHOLE string rather than taking its `basename`. The input is a
 * video title, not a path: `basename('My Video: Part 1/2')` is `2`, which
 * silently throws the title away. Replacing both separators is also what makes
 * the result traversal-safe — with no `/` or `\\` left, a `..` cannot escape
 * the directory it is joined to.
 *
 * Length is capped at a word boundary. A blunt slice cut a real title to
 * `...Kole-Jain-(10`, which reads as a corrupted name rather than a shortened
 * one — the fragment `(10` is the start of `(1080p)` and means nothing on its
 * own. Cutting back to the last separator loses a word and keeps the rest
 * legible. A single token longer than the cap has no boundary to fall back to,
 * so it is truncated as-is rather than reduced to nothing.
 */
export function safeFileName(raw: string, fallback = 'video'): string {
  // Control characters are matched by codepoint rather than by an escape range
  // in the pattern: a literal \x00-\x1f class is an eslint no-control-regex
  // error, and the rule is right that such a pattern is easy to misread.
  const printable = [...raw]
    .map((character) => ((character.codePointAt(0) ?? 0) < 0x20 ? '-' : character))
    .join('');

  const cleaned = trimEdges(printable.replace(/[<>:"/\\|?*\s]+/g, '-').replace(/-+/g, '-'));
  if (cleaned.length <= MAX_FILE_NAME) return cleaned || fallback;

  const clipped = cleaned.slice(0, MAX_FILE_NAME);
  // Only step back when the cut landed INSIDE a word; a cut that happened to
  // fall on a separator is already at a boundary. `lastIndexOf` returning -1
  // is checked rather than passed to `slice`, where it would quietly mean
  // "drop the final character" instead of "there is no boundary".
  const lastSeparator = clipped.lastIndexOf('-');
  const boundary =
    cleaned[MAX_FILE_NAME] === '-'
      ? clipped
      : lastSeparator > 0
        ? clipped.slice(0, lastSeparator)
        : '';

  return trimEdges(boundary) || trimEdges(clipped) || fallback;
}

const MAX_FILE_NAME = 60;

/** Leading/trailing dots, dashes and opening brackets left by sanitizing. */
function trimEdges(value: string): string {
  return value.replace(/^[.\-([{]+/, '').replace(/[.\-([{]+$/, '');
}
