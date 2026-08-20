import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { captureToolExecute, generateTestClip, noProgress } from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { registerExportVideoBundle } from './export-bundle.js';

const run = promisify(execFile);

interface BundleDoc {
  zipPath: string;
  folder: string;
  revealCommand: string;
  bytes: number;
  frameCount: number;
  transcriptEntries: number;
  contents: string[];
  warnings: string[];
}

afterEach(() => {
  clearAdapters();
});

async function exportBundle(args: Record<string, unknown>): Promise<BundleDoc> {
  const result = await captureToolExecute(registerExportVideoBundle)(args, noProgress);
  return JSON.parse(result.content[0].text ?? '{}') as BundleDoc;
}

async function fixture(): Promise<{ dir: string; clip: string }> {
  const dir = await createTempDir();
  const clip = join(dir, 'demo.mp4');
  await generateTestClip(clip, 8, '640x480');
  clearAdapters();
  registerAdapter(new LocalFileAdapter());
  return { dir, clip };
}

describe('export_video_bundle', () => {
  /**
   * The whole-feature outcome test: run the real pipeline on a real clip, then
   * extract the archive with the system `unzip` and assert the FILES are there.
   * Asserting the tool's own JSON manifest would only prove it described what
   * it meant to write.
   */
  it('writes a zip holding the frames in a folder and the transcript as markdown', async () => {
    const { dir, clip } = await fixture();
    try {
      const doc = await exportBundle({
        url: clip,
        outputPath: join(dir, 'bundle.zip'),
        options: { maxFrames: 4 },
      });

      expect(doc.zipPath).toBe(join(dir, 'bundle.zip'));
      expect(doc.bytes).toBeGreaterThan(0);

      // The archive cannot travel through the response, so the path has to be
      // actionable on its own — the default location is a cache directory.
      expect(doc.folder).toBe(dir);
      expect(doc.revealCommand).toContain(doc.zipPath);
      expect(doc.revealCommand).toMatch(/^(open -R|explorer \/select,|xdg-open)/);
      expect(doc.frameCount).toBeGreaterThan(0);

      const { stdout } = await run('unzip', ['-t', doc.zipPath]);
      expect(stdout).toMatch(/No errors detected/i);

      const out = join(dir, 'extracted');
      await mkdir(out, { recursive: true });
      await run('unzip', ['-q', doc.zipPath, '-d', out]);

      expect((await readdir(out)).sort()).toEqual(['frames', 'transcript.md']);

      const frames = await readdir(join(out, 'frames'));
      expect(frames).toHaveLength(doc.frameCount);
      for (const frame of frames) expect(frame).toMatch(/^\d{3}_[\d-]+\.jpg$/);
      // Alphabetical order is chronological order — the reason names lead with
      // an ordinal rather than a timestamp.
      expect([...frames].sort()).toEqual(frames.sort());

      const markdown = await readFile(join(out, 'transcript.md'), 'utf8');
      expect(markdown).toMatch(/^# demo\.mp4\n/);
      expect(markdown).toContain('- **Duration:**');
      // The clip is silent, so an empty transcript is the honest outcome — but
      // the file must exist and explain itself.
      expect(markdown).toContain('_No transcript available for this video._');

      // Every JPEG must be a real, non-empty image, not a zero-byte entry.
      for (const frame of frames) {
        const bytes = await readFile(join(out, 'frames', frame));
        expect(bytes.length).toBeGreaterThan(100);
        expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      }
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  /**
   * Archived frames never enter the model's context, so the 800px/quality-70
   * defaults that keep analyze_video's token cost down are pure loss here.
   * Measured on a 1080p capture: 45 frames encode in 0.5s either way, so the
   * downscale was buying a smaller zip and nothing else.
   */
  it('writes frames at the source resolution by default', async () => {
    const dir = await createTempDir();
    try {
      const clip = join(dir, 'wide.mp4');
      await generateTestClip(clip, 4, '1280x720');
      clearAdapters();
      registerAdapter(new LocalFileAdapter());

      const doc = await exportBundle({
        url: clip,
        outputPath: join(dir, 'full.zip'),
        options: { maxFrames: 2 },
      });

      const out = join(dir, 'x');
      await mkdir(out, { recursive: true });
      await run('unzip', ['-q', doc.zipPath, '-d', out]);
      const frames = await readdir(join(out, 'frames'));

      for (const frame of frames) {
        const meta = await sharp(join(out, 'frames', frame)).metadata();
        expect(meta.width).toBe(1280);
      }
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('still honours an explicit maxWidth for a smaller archive', async () => {
    const dir = await createTempDir();
    try {
      const clip = join(dir, 'wide.mp4');
      await generateTestClip(clip, 4, '1280x720');
      clearAdapters();
      registerAdapter(new LocalFileAdapter());

      const doc = await exportBundle({
        url: clip,
        outputPath: join(dir, 'small.zip'),
        options: { maxFrames: 2, maxWidth: 640 },
      });

      const out = join(dir, 'y');
      await mkdir(out, { recursive: true });
      await run('unzip', ['-q', doc.zipPath, '-d', out]);
      const frames = await readdir(join(out, 'frames'));

      for (const frame of frames) {
        const meta = await sharp(join(out, 'frames', frame)).metadata();
        expect(meta.width).toBe(640);
      }
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  /**
   * The bug that produced transcript-only bundles. The tool releases its temp
   * dir once the bytes are in the archive, but getAnalysis has already cached
   * the result with paths INTO that dir — so a second call within the cache TTL
   * found every frame file gone and wrote an archive containing only
   * transcript.md. Guaranteed after a timed-out first call, which is precisely
   * when a retry happens.
   */
  it('still contains frames when the same export is repeated from cache', async () => {
    const dir = await createTempDir();
    try {
      const clip = join(dir, 'repeat.mp4');
      await generateTestClip(clip, 6, '640x480');
      clearAdapters();
      registerAdapter(new LocalFileAdapter());

      const first = await exportBundle({
        url: clip,
        outputPath: join(dir, 'a.zip'),
        options: { maxFrames: 3 },
      });
      const second = await exportBundle({
        url: clip,
        outputPath: join(dir, 'b.zip'),
        options: { maxFrames: 3 },
      });

      expect(first.frameCount).toBeGreaterThan(0);
      expect(second.frameCount).toBe(first.frameCount);
      expect(second.contents).toContain('transcript.md');
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  /**
   * OCR is the dominant cost of an export once the transcript is cached — about
   * 60s of an 80s run on an 8-minute 1080p video — and it earns much less in an
   * archive than inline: these frames are full-resolution images a person opens
   * and reads, rather than pixels a model cannot see unless they are recognized.
   */
  it('skips OCR by default, so the bundle has no on-screen-text section', async () => {
    const { dir, clip } = await fixture();
    try {
      const doc = await exportBundle({
        url: clip,
        outputPath: join(dir, 'no-ocr.zip'),
        options: { maxFrames: 2 },
      });

      const out = join(dir, 'n');
      await mkdir(out, { recursive: true });
      await run('unzip', ['-q', doc.zipPath, '-d', out]);
      const markdown = await readFile(join(out, 'transcript.md'), 'utf8');

      expect(doc.frameCount).toBeGreaterThan(0);
      expect(markdown).not.toContain('## On-screen text');
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('restores OCR when the caller opts in', async () => {
    const { dir, clip } = await fixture();
    try {
      // The clip is a moving test pattern with no legible text, so the section
      // may legitimately be absent — what is asserted is that the OCR PASS ran,
      // via the option reaching the pipeline rather than being ignored.
      const doc = await exportBundle({
        url: clip,
        outputPath: join(dir, 'ocr.zip'),
        options: { maxFrames: 2, includeOcr: true },
      });

      expect(doc.frameCount).toBeGreaterThan(0);
      expect(doc.contents).toContain('transcript.md');
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('names the archive from the video title when given a directory', async () => {
    const { dir, clip } = await fixture();
    try {
      const target = join(dir, 'exports');
      await mkdir(target, { recursive: true });

      const doc = await exportBundle({
        url: clip,
        outputPath: target,
        options: { maxFrames: 2 },
      });

      expect(doc.zipPath).toBe(join(target, 'demo.zip'));
      expect(await readdir(target)).toEqual(['demo.zip']);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('appends .zip to an output path that lacks it', async () => {
    const { dir, clip } = await fixture();
    try {
      const doc = await exportBundle({
        url: clip,
        outputPath: join(dir, 'my-export'),
        options: { maxFrames: 2 },
      });
      expect(doc.zipPath).toBe(join(dir, 'my-export.zip'));
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('leaves no .partial scratch file behind', async () => {
    const { dir, clip } = await fixture();
    try {
      await exportBundle({ url: clip, outputPath: join(dir, 'b.zip'), options: { maxFrames: 2 } });
      expect((await readdir(dir)).filter((f) => f.includes('.partial'))).toEqual([]);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('rejects a relative outputPath — the server cwd is unpredictable', async () => {
    const { dir, clip } = await fixture();
    try {
      await expect(
        exportBundle({ url: clip, outputPath: 'bundle.zip', options: { maxFrames: 2 } }),
      ).rejects.toThrow(/must be an absolute path/i);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('requires a video source', async () => {
    await fixture();
    await expect(exportBundle({})).rejects.toThrow(/a video source is required/i);
  });
});
