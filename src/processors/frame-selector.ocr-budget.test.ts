import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateTestClip } from '../../test/helpers/index.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';

/**
 * Guards the cost of the OCR scoring pass — the regression that made a real
 * export time out.
 *
 * Selection used to recognize EVERY candidate: 60 frames, each upscaled to
 * 3000px by `preprocessForOcr`. Measured on a 6-minute 1080p clip that took
 * 20.0s against the legacy extractor's 4.1s, and on a longer, text-dense file it
 * exceeded the MCP client's timeout outright. The frame COUNT handed to OCR is
 * therefore the thing to pin: it is what the fix bounds, and a timing assertion
 * would be flaky on shared CI.
 */
const state = vi.hoisted(() => ({ ocrBatches: [] as number[] }));

vi.mock('../processors/frame-ocr.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ocrFrames: async (frames: { time: string }[]) => {
      state.ocrBatches.push(frames.length);
      return frames.map((f) => ({ time: f.time, text: 'sample on-screen text', confidence: 90 }));
    },
  };
});

const { selectKeyFrames } = await import('./frame-selector.js');

async function selectFrom(options: Record<string, unknown>): Promise<{
  frames: number;
  ocrCalls: number[];
  ocrByPath: number;
  warnings: string[];
}> {
  state.ocrBatches.length = 0;
  const dir = await createTempDir();
  try {
    const clip = join(dir, 'clip.mp4');
    await generateTestClip(clip, 20, '640x480');
    const result = await selectKeyFrames(clip, dir, options);
    return {
      frames: result.frames.length,
      ocrCalls: [...state.ocrBatches],
      ocrByPath: result.ocrByPath.size,
      warnings: result.warnings,
    };
  } finally {
    await cleanupTempDir(dir);
  }
}

describe('OCR scoring cost', () => {
  it('recognizes a shortlist, not the whole candidate pool', async () => {
    const { ocrCalls, frames } = await selectFrom({ maxFrames: 4, useOcr: true });

    expect(ocrCalls).toHaveLength(1);
    // Twice the requested count is the contract; the pool behind it is larger
    // (maxFrames x candidateMultiplier), and recognizing all of it is the bug.
    expect(ocrCalls[0]).toBeLessThanOrEqual(4 * 2);
    expect(frames).toBeGreaterThan(0);
  }, 180_000);

  it('never exceeds the absolute ceiling, however many frames are requested', async () => {
    const { ocrCalls } = await selectFrom({ maxFrames: 60, useOcr: true });
    expect(ocrCalls[0]).toBeLessThanOrEqual(12);
  }, 180_000);

  it('skips OCR entirely when its weight is zero', async () => {
    // Weight 0 says text must not affect the ranking, so recognizing it would
    // be pure cost — and this is the documented escape hatch for slow videos.
    const { ocrCalls } = await selectFrom({ maxFrames: 6, useOcr: true, ocrWeight: 0 });
    expect(ocrCalls).toEqual([]);
  }, 180_000);

  it('skips OCR when the caller opts out', async () => {
    const { ocrCalls } = await selectFrom({ maxFrames: 6, useOcr: false });
    expect(ocrCalls).toEqual([]);
  }, 180_000);

  /**
   * The bug the shortlist introduced, and the reason this file exists twice
   * over: the shortlist was passed on as the SELECTION pool, so `maxFrames: 20`
   * came back with six frames — the shortlist is itself de-duplicated, and
   * selection could not see past it. Scoring narrows what gets read; only the
   * budget decides how many frames come out.
   */
  it('does not let the OCR shortlist cap how many frames are returned', async () => {
    const withOcr = await selectFrom({ maxFrames: 20, useOcr: true });
    const withoutOcr = await selectFrom({ maxFrames: 20, useOcr: false });

    // Whatever the clip supports, enabling OCR must not reduce it.
    expect(withOcr.frames).toBe(withoutOcr.frames);
    // ...and the shortlist really was smaller than the result, or this proves nothing.
    expect(withOcr.ocrCalls[0]).toBeLessThan(withOcr.frames + 1);
  }, 180_000);

  /**
   * The shortlist must not cost the pipeline its reuse: `analyze-core` takes
   * these results instead of running its own OCR pass over the selected frames,
   * so an empty map here silently doubles the OCR work downstream.
   */
  it('still hands back OCR results for every selected frame', async () => {
    const { frames, ocrByPath } = await selectFrom({ maxFrames: 4, useOcr: true });
    expect(ocrByPath).toBe(frames);
  }, 180_000);
});
