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
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { registerGetFrames } from './get-frames.js';

/**
 * Pins that selected frames actually REACH the response.
 *
 * This is a whole-pipeline guard, and it exists because the unit tests for the
 * selector could not catch what went wrong: `selectKeyFrames` returned six
 * well-chosen frames and the downstream `deduplicateFrames` step — adjacent
 * comparison at a Hamming threshold of 5, far above the ~5-bits-of-72 range
 * dHash spans across an entire clip — collapsed them back to one. Every
 * selector unit test stayed green; the tool returned a single frame.
 *
 * Asserting the count is greater than one is the whole point: any later step
 * that re-deduplicates a smart-selected set fails here.
 */
afterEach(() => {
  clearAdapters();
});

async function framesFor(options: Record<string, unknown>): Promise<{
  count: number;
  warnings: string[];
  mode: string;
}> {
  const dir = await createTempDir();
  try {
    const clip = join(dir, 'moving.mp4');
    await generateTestClip(clip, 12, '640x480');

    clearAdapters();
    registerAdapter(new LocalFileAdapter());

    const execute = captureToolExecute(registerGetFrames);
    const result = await execute({ url: clip, options }, noProgress);
    const doc = JSON.parse(result.content[0].text ?? '{}');

    return { count: frameCountOf(result), warnings: warningsOf(result), mode: doc.mode };
  } finally {
    await cleanupTempDir(dir);
  }
}

describe('get_frames frame selection reaches the response', () => {
  it('emits the frames smart selection chose, not a re-deduplicated remnant', async () => {
    const { count, warnings, mode } = await framesFor({ maxFrames: 6 });

    expect(mode).toBe('smart');
    expect(count).toBeGreaterThan(1);

    // The count the selector reported and the count emitted must agree — a
    // later step silently thinning the set is exactly the failure guarded here.
    const summary = warnings.find((w) => w.startsWith('Smart frame selection:'));
    expect(summary).toBeDefined();
    expect(Number(/kept (\d+)/.exec(summary ?? '')?.[1])).toBe(count);
    expect(warnings.some((w) => /duplicate frames/.test(w))).toBe(false);
  }, 180_000);

  it('still runs the legacy dedup in sceneChange mode', async () => {
    const { mode } = await framesFor({ maxFrames: 6, frameSelection: 'sceneChange' });
    expect(mode).toBe('scene');
  }, 180_000);

  it('reports dense mode when uniform coverage was explicitly requested', async () => {
    const { mode, count } = await framesFor({ maxFrames: 6, dense: true });
    expect(mode).toBe('dense');
    expect(count).toBeGreaterThan(0);
  }, 180_000);
});
