import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureToolExecute,
  frameCountOf,
  generateTestClip,
  noProgress,
  warningsOf,
} from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import type { IVideoAdapter } from '../adapters/adapter.interface.js';
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { registerGetFrameAt } from './get-frame-at.js';
import { registerGetFrames } from './get-frames.js';
import { registerGetMetadata } from './get-metadata.js';
import { registerGetTranscript } from './get-transcript.js';

/**
 * End-to-end proof of the `localFallbackPath` contract at the TOOL boundary —
 * schema through handler through response.
 *
 * The remote adapter reproduces the reported failure exactly: yt-dlp blocked by
 * YouTube's anti-bot, which in this codebase is not a thrown error but a
 * `downloadVideo` that returns null after reporting the reason through
 * `onWarning`. Anything that only watched for exceptions would sail past it,
 * which is why the degraded path is asserted here and not only in the unit
 * tests for the runner.
 */
const BLOCKED = 'https://www.youtube.com/watch?v=blocked1234';
const BLOCK_REASON =
  'Video download failed: ERROR: [youtube] blocked1234: Sign in to confirm you are not a bot.';

function blockedAdapter(): IVideoAdapter {
  return {
    name: 'ytdlp',
    capabilities: {
      transcript: true,
      metadata: true,
      comments: false,
      chapters: false,
      aiSummary: false,
      videoDownload: true,
    },
    canHandle: (url) => url === BLOCKED,
    getMetadata: async () => {
      throw new Error('Failed to fetch metadata: HTTP Error 403: Forbidden');
    },
    getTranscript: async () => {
      throw new Error('HTTP Error 403: Forbidden');
    },
    getComments: async () => [],
    getChapters: async () => [],
    getAiSummary: async () => null,
    downloadVideo: async (_url, _destDir, onWarning) => {
      onWarning?.(BLOCK_REASON);
      return null;
    },
  };
}

/** A local clip with real, decodable content plus the adapters under test. */
async function fixture(): Promise<{ dir: string; clip: string }> {
  const dir = await createTempDir();
  const clip = join(dir, 'local-copy.mp4');
  await generateTestClip(clip, 3);
  clearAdapters();
  registerAdapter(blockedAdapter());
  registerAdapter(new LocalFileAdapter());
  return { dir, clip };
}

afterEach(() => {
  clearAdapters();
});

describe('get_frames with localFallbackPath', () => {
  it('serves frames from the local file when the remote source is blocked', async () => {
    const { dir, clip } = await fixture();
    try {
      const execute = captureToolExecute(registerGetFrames);
      const result = await execute({ url: BLOCKED, localFallbackPath: clip }, noProgress);

      expect(frameCountOf(result)).toBeGreaterThan(0);

      const warnings = warningsOf(result);
      const note = warnings.find((w) => w.startsWith('Remote extraction failed'));
      expect(note).toBeDefined();
      // The point of the note: which source served this, and why not the other.
      // `remoteFailureInWarnings` reports the FIRST remote failure of the
      // attempt, which here is the 403 on metadata — it precedes the blocked
      // download. Both are the same outage; the note names the earliest cause.
      expect(note).toContain('localFallbackPath');
      expect(note).toMatch(/HTTP Error 403/);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 120_000);

  it('reports zero frames and no fallback note when no local copy was offered', async () => {
    const { dir } = await fixture();
    try {
      const execute = captureToolExecute(registerGetFrames);
      const result = await execute({ url: BLOCKED }, noProgress);

      expect(frameCountOf(result)).toBe(0);
      expect(warningsOf(result).some((w) => w.startsWith('Remote extraction failed'))).toBe(false);
      expect(warningsOf(result).join(' ')).toMatch(/not a bot/);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 120_000);

  /**
   * The "behaves identically to today's local-file support" clause: with no
   * url, the local file is the source and nothing remote is attempted — the
   * blocked adapter would have thrown on metadata if it had been consulted.
   */
  it('reads the local file directly when only localFallbackPath is given', async () => {
    const { dir, clip } = await fixture();
    try {
      const execute = captureToolExecute(registerGetFrames);
      const result = await execute({ localFallbackPath: clip }, noProgress);

      expect(frameCountOf(result)).toBeGreaterThan(0);
      expect(warningsOf(result).some((w) => w.startsWith('Remote extraction failed'))).toBe(false);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 120_000);

  it('rejects a call that names no source at all', async () => {
    await fixture();
    const execute = captureToolExecute(registerGetFrames);
    await expect(execute({}, noProgress)).rejects.toThrow(/a video source is required/i);
  });
});

describe('get_frame_at with localFallbackPath', () => {
  it('extracts the requested timestamp from the local file when the remote is blocked', async () => {
    const { dir, clip } = await fixture();
    try {
      const execute = captureToolExecute(registerGetFrameAt);
      const result = await execute(
        { url: BLOCKED, localFallbackPath: clip, timestamp: '0:01' },
        noProgress,
      );

      expect(frameCountOf(result)).toBe(1);
      expect(warningsOf(result).some((w) => w.startsWith('Remote extraction failed'))).toBe(true);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 120_000);

  /**
   * Input validation still throws, and must throw BEFORE any fallback: a bad
   * timestamp is a mistake in the call, and retrying it against another file
   * would bury the real error under a second identical one.
   */
  it('throws on an invalid timestamp instead of retrying against the local file', async () => {
    const { dir, clip } = await fixture();
    try {
      const execute = captureToolExecute(registerGetFrameAt);
      await expect(
        execute({ url: BLOCKED, localFallbackPath: clip, timestamp: 'banana' }, noProgress),
      ).rejects.toThrow(/Invalid timestamp/);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});

describe('get_metadata with localFallbackPath', () => {
  it('probes the local file when the remote metadata fetch is blocked', async () => {
    const { dir, clip } = await fixture();
    try {
      const execute = captureToolExecute(registerGetMetadata);
      const result = await execute({ url: BLOCKED, localFallbackPath: clip }, noProgress);
      const doc = JSON.parse(result.content[0].text ?? '{}');

      expect(doc.metadata.platform).toBe('local');
      expect(doc.metadata.duration).toBeGreaterThan(0);
      expect(doc.warnings.some((w: string) => w.startsWith('Remote extraction failed'))).toBe(true);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 120_000);
});

describe('get_transcript with localFallbackPath', () => {
  it('falls back to the local file when the remote transcript fetch is blocked', async () => {
    const { dir, clip } = await fixture();
    try {
      const execute = captureToolExecute(registerGetTranscript);
      const result = await execute({ url: BLOCKED, localFallbackPath: clip }, noProgress);
      const doc = JSON.parse(result.content[0].text ?? '{}');

      expect(doc.warnings.some((w: string) => w.startsWith('Remote extraction failed'))).toBe(true);
      // The clip has no audio track, so "no transcript" is the honest outcome —
      // what is asserted here is WHICH source produced it, exactly once.
      expect(
        doc.warnings.filter((w: string) => w === 'No transcript available for this video.'),
      ).toHaveLength(1);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 120_000);
});
