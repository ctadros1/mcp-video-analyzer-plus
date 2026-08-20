import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from './temp-files.js';
import { crc32, dosDateTime, safeFileName, writeZipArchive } from './zip.js';

const run = promisify(execFile);

describe('crc32', () => {
  /**
   * Pinned against the published IEEE 802.3 check values rather than against
   * this implementation's own output — a self-consistent checksum would pass
   * its own test forever while producing archives every real extractor rejects.
   */
  it('matches the standard check vectors', () => {
    expect(crc32(Buffer.from(''))).toBe(0x00000000);
    expect(crc32(Buffer.from('a'))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from('abc'))).toBe(0x352441c2);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('dosDateTime', () => {
  it('packs a date into the MS-DOS fields', () => {
    const { time, date } = dosDateTime(new Date(2026, 7, 19, 14, 35, 20));
    expect(date >> 9).toBe(2026 - 1980);
    expect((date >> 5) & 0xf).toBe(8); // August
    expect(date & 0x1f).toBe(19);
    expect(time >> 11).toBe(14);
    expect((time >> 5) & 0x3f).toBe(35);
    expect((time & 0x1f) * 2).toBe(20);
  });

  it('clamps a pre-1980 date instead of writing a negative year', () => {
    // The DOS epoch is 1980; a smaller year underflows the 7-bit field and some
    // extractors refuse the entry outright.
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe('safeFileName', () => {
  it('keeps the whole title rather than treating it as a path', () => {
    // basename() would return "2" here and silently throw the title away.
    expect(safeFileName('My Video: Part 1/2')).toBe('My-Video-Part-1-2');
  });

  it('strips characters Windows rejects', () => {
    expect(safeFileName('a:b*c?d"e<f>g|h')).toBe('a-b-c-d-e-f-g-h');
  });

  it('cannot produce a path that escapes its directory', () => {
    const name = safeFileName('../../etc/passwd');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name.startsWith('.')).toBe(false);
  });

  it('falls back when the input sanitizes to nothing', () => {
    expect(safeFileName('   ', 'video')).toBe('video');
    expect(safeFileName('///', 'video')).toBe('video');
  });

  it('bounds the length', () => {
    expect(safeFileName('a'.repeat(500)).length).toBeLessThanOrEqual(60);
  });
});

describe('writeZipArchive', () => {
  async function archiveWith(dir: string): Promise<string> {
    const photo = join(dir, 'photo.jpg');
    await writeFile(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]));

    const target = join(dir, 'bundle.zip');
    await writeZipArchive(target, [
      { name: 'frames/001_0-04.jpg', sourcePath: photo },
      { name: 'transcript.md', data: '# Title\n\n**[0:04]** hello\n' },
    ]);
    return target;
  }

  it('writes the ZIP structure the format specifies', async () => {
    const dir = await createTempDir();
    try {
      const bytes = await readFile(await archiveWith(dir));

      expect(bytes.readUInt32LE(0)).toBe(0x04034b50); // first local header
      // End-of-central-directory is the last 22 bytes (no archive comment).
      const end = bytes.length - 22;
      expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
      expect(bytes.readUInt16LE(end + 10)).toBe(2); // total entries

      const centralOffset = bytes.readUInt32LE(end + 16);
      expect(bytes.readUInt32LE(centralOffset)).toBe(0x02014b50);
      expect(bytes.readUInt32LE(end + 12)).toBe(end - centralOffset); // central size
    } finally {
      await cleanupTempDir(dir);
    }
  });

  /**
   * The test that actually matters, and the reason a hand-rolled writer is
   * defensible at all: a real extractor has to accept the archive. A structural
   * assertion only proves the file matches this implementation's idea of the
   * format — `unzip -t` proves it matches somebody else's.
   *
   * Not a probe-and-skip: if `unzip` is present it MUST pass. It is absent on
   * some Windows runners, which is the only case that skips.
   */
  it('produces an archive the system unzip accepts and extracts intact', async () => {
    const unzip = await run('unzip', ['-v']).then(
      () => true,
      () => false,
    );
    if (!unzip) {
      expect(process.platform).toBe('win32');
      return;
    }

    const dir = await createTempDir();
    try {
      const target = await archiveWith(dir);

      const { stdout } = await run('unzip', ['-t', target]);
      expect(stdout).toMatch(/No errors detected/i);

      const out = join(dir, 'extracted');
      await mkdir(out, { recursive: true });
      await run('unzip', ['-q', target, '-d', out]);

      expect(await readdir(out)).toEqual(expect.arrayContaining(['frames', 'transcript.md']));
      expect(await readdir(join(out, 'frames'))).toEqual(['001_0-04.jpg']);
      expect(await readFile(join(out, 'transcript.md'), 'utf8')).toBe(
        '# Title\n\n**[0:04]** hello\n',
      );
      expect([...(await readFile(join(out, 'frames', '001_0-04.jpg')))]).toEqual([
        0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5,
      ]);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it('writes an empty archive without corrupting the trailer', async () => {
    const dir = await createTempDir();
    try {
      const target = join(dir, 'empty.zip');
      const result = await writeZipArchive(target, []);
      expect(result.bytes).toBe(22);
      expect(result.names).toEqual([]);
      expect((await readFile(target)).readUInt32LE(0)).toBe(0x06054b50);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it('rejects an entry with neither content nor a source file', async () => {
    const dir = await createTempDir();
    try {
      await expect(
        writeZipArchive(join(dir, 'bad.zip'), [{ name: 'nothing.txt' }]),
      ).rejects.toThrow(/neither sourcePath nor data/);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it('reports UTF-8 entry names as UTF-8', async () => {
    const dir = await createTempDir();
    try {
      const target = join(dir, 'unicode.zip');
      await writeZipArchive(target, [{ name: 'café/naïve.md', data: 'x' }]);
      const bytes = await readFile(target);
      // General-purpose bit 11 must be set, or extractors decode the name as CP437.
      expect(bytes.readUInt16LE(6) & 0x0800).toBe(0x0800);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});
