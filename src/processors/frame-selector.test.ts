import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCENE_CUT_TIMES,
  denseUiClip,
  generateTestClip,
  sceneCutClip,
} from '../../test/helpers/index.js';
import type { IFrameResult } from '../types.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { computeDHash } from './frame-dedup.js';
import { parseTimestamp } from './frame-extractor.js';
import type { IOcrResult } from './frame-ocr.js';
import {
  areDuplicates,
  buildSceneBuckets,
  ocrTextScore,
  selectDiverseFrames,
  selectKeyFrames,
} from './frame-selector.js';
import type { ScoredFrame } from './frame-selector.js';
import { meanColor } from './frame-signals.js';

/** A dHash-shaped buffer whose bytes are all `fill` — distance is predictable. */
function hash(fill: number): Buffer {
  return Buffer.alloc(9, fill);
}

function candidate(overrides: Partial<ScoredFrame> & { seconds: number }): ScoredFrame {
  const { seconds } = overrides;
  return {
    frame: {
      time: `0:${String(seconds).padStart(2, '0')}`,
      filePath: `/frames/${seconds}.jpg`,
      mimeType: 'image/jpeg',
    },
    seconds,
    hash: hash(0x00),
    sharpness: 100,
    textScore: 0,
    // Same mean colour by default, so the hash decides — the colour signal is
    // exercised on its own below rather than quietly gating every other case.
    color: [20, 20, 20],
    text: '',
    ...overrides,
  };
}

describe('areDuplicates', () => {
  const a = candidate({ seconds: 0 });

  it('calls two frames with the same hash, colour and text duplicates', () => {
    expect(areDuplicates(a, candidate({ seconds: 40 }))).toBe(true);
  });

  it('spares frames whose on-screen text differs, however alike the pixels', () => {
    // The rule dedupeKeepingTextChanges established: a static background whose
    // overlay changed carries new information the hash cannot see.
    expect(
      areDuplicates(
        candidate({ seconds: 0, text: 'total 12.00' }),
        candidate({ seconds: 40, text: 'total 98.50' }),
      ),
    ).toBe(false);
  });

  it('spares frames of clearly different colour that hash identically', () => {
    // Solid red vs solid blue: dHash is greyscale + gradient-only, so both are
    // all-zero and indistinguishable to it.
    expect(
      areDuplicates(
        candidate({ seconds: 0, color: [200, 30, 30] }),
        candidate({ seconds: 40, color: [30, 30, 200] }),
      ),
    ).toBe(false);
  });

  it('spares frames whose hash differs by more than the threshold', () => {
    expect(areDuplicates(a, candidate({ seconds: 40, hash: hash(0xff) }))).toBe(false);
  });

  it('never calls an unhashable frame a duplicate', () => {
    expect(areDuplicates(a, candidate({ seconds: 40, hash: null }))).toBe(false);
  });

  it('never calls a frame with an unreadable colour a duplicate', () => {
    expect(areDuplicates(a, candidate({ seconds: 40, color: null }))).toBe(false);
  });
});

describe('ocrTextScore', () => {
  const ocr = (text: string, confidence: number): IOcrResult => ({
    time: '0:01',
    text,
    confidence,
  });

  it('scores a low-confidence recognition as no text at all', () => {
    // Noise must not be able to buy a frame a place in the result.
    expect(ocrTextScore(ocr('Total: $1,299.00 — checkout', 20))).toBe(0);
  });

  it('scores text shorter than the meaningfulness floor as no text', () => {
    expect(ocrTextScore(ocr('ab', 99))).toBe(0);
  });

  it('scores a missing OCR entry as no text', () => {
    expect(ocrTextScore(undefined)).toBe(0);
  });

  it('ranks a text-dense frame above a sparse one', () => {
    const dense = ocrTextScore(ocr('const total = items.reduce((a, b) => a + b.price, 0);', 90));
    const sparse = ocrTextScore(ocr('Loading', 90));
    expect(dense).toBeGreaterThan(sparse);
    expect(sparse).toBeGreaterThan(0);
  });

  it('ranks the same text higher when recognized with more confidence', () => {
    expect(ocrTextScore(ocr('Build succeeded', 95))).toBeGreaterThan(
      ocrTextScore(ocr('Build succeeded', 60)),
    );
  });
});

describe('selectDiverseFrames', () => {
  it('returns nothing for an empty pool or a zero budget', () => {
    expect(selectDiverseFrames([], 5)).toEqual([]);
    expect(selectDiverseFrames([candidate({ seconds: 1 })], 0)).toEqual([]);
  });

  /**
   * The headline bug: upstream deduplicates against the PREVIOUS frame only, so
   * two near-identical frames survive whenever anything different sits between
   * them. Here frames at 0s and 20s are identical and a distinct frame sits at
   * 10s — the old rule keeps all three.
   */
  it('drops a near-duplicate that is far from its twin in time', () => {
    const pool = [
      candidate({ seconds: 0, hash: hash(0x00) }),
      candidate({ seconds: 10, hash: hash(0xff) }),
      candidate({ seconds: 20, hash: hash(0x00) }),
    ];

    const kept = selectDiverseFrames(pool, 3, { minTimeGapSeconds: 0 });

    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.hash?.[0])).toEqual([0x00, 0xff]);
  });

  it('prefers the sharper of two otherwise-equal frames', () => {
    const pool = [
      candidate({ seconds: 0, hash: hash(0x00), sharpness: 5 }),
      candidate({ seconds: 30, hash: hash(0xff), sharpness: 900 }),
    ];

    expect(selectDiverseFrames(pool, 1)[0].seconds).toBe(30);
  });

  it('prefers the text-dense frame over the sharper one when OCR weight dominates', () => {
    const pool = [
      candidate({ seconds: 0, hash: hash(0x00), sharpness: 1000, textScore: 0 }),
      candidate({ seconds: 30, hash: hash(0xff), sharpness: 100, textScore: 50 }),
    ];

    expect(selectDiverseFrames(pool, 1, { ocrWeight: 0.9 })[0].seconds).toBe(30);
    // ...and the same pool inverts when text is ignored, which is what makes
    // the assertion above about the weight rather than about the fixture.
    expect(selectDiverseFrames(pool, 1, { ocrWeight: 0 })[0].seconds).toBe(0);
  });

  /**
   * A text-free pool (b-roll, talking heads) must rank purely on sharpness. The
   * OCR term normalizes against the pool maximum, so when nothing has text it
   * scales every candidate identically instead of penalizing the clip.
   */
  it('ranks a text-free pool by sharpness alone, whatever the OCR weight', () => {
    const pool = [
      candidate({ seconds: 0, hash: hash(0x00), sharpness: 10 }),
      candidate({ seconds: 30, hash: hash(0x0f), sharpness: 800 }),
      candidate({ seconds: 60, hash: hash(0xff), sharpness: 400 }),
    ];

    for (const ocrWeight of [0, 0.4, 1]) {
      const order = selectDiverseFrames(pool, 3, { ocrWeight, minTimeGapSeconds: 0 });
      expect(order).toHaveLength(3);
      // Chronological output, so re-rank by score to read the preference back.
      const best = selectDiverseFrames(pool, 1, { ocrWeight, minTimeGapSeconds: 0 })[0];
      expect(best.seconds).toBe(30);
    }
  });

  it('returns kept frames in chronological order, not score order', () => {
    const pool = [
      candidate({ seconds: 40, hash: hash(0x00), sharpness: 900 }),
      candidate({ seconds: 10, hash: hash(0x0f), sharpness: 500 }),
      candidate({ seconds: 70, hash: hash(0xff), sharpness: 700 }),
    ];

    const kept = selectDiverseFrames(pool, 3, { minTimeGapSeconds: 0 });
    expect(kept.map((k) => k.seconds)).toEqual([10, 40, 70]);
  });

  it('never returns more than the requested count', () => {
    const pool = Array.from({ length: 20 }, (_, i) =>
      candidate({ seconds: i * 5, hash: hash(i * 11), sharpness: 100 + i }),
    );

    expect(selectDiverseFrames(pool, 4)).toHaveLength(4);
  });

  /**
   * Greedy top-score selection alone would happily return four frames from one
   * busy passage. The spacing constraint spreads them; without it this pool
   * (where the sharpest frames are all bunched at the start) collapses.
   */
  it('spreads the selection across the clip instead of clustering', () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) =>
        candidate({ seconds: i, hash: hash(i * 21), sharpness: 1000 - i }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        candidate({ seconds: 60 + i, hash: hash(128 + i * 7), sharpness: 200 - i }),
      ),
    ];

    const kept = selectDiverseFrames(pool, 4);
    expect(kept.some((k) => k.seconds >= 60)).toBe(true);
  });

  /**
   * Spacing is a preference, not a quota. When the content really is bunched,
   * the relaxed second pass must still fill the budget — silently returning one
   * frame because everything happens in five seconds would be a regression.
   */
  it('relaxes the spacing constraint rather than returning short', () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      candidate({ seconds: i, hash: hash(i * 40), sharpness: 500 + i }),
    );

    expect(selectDiverseFrames(pool, 5, { minTimeGapSeconds: 1000 })).toHaveLength(5);
  });

  it('keeps an unhashable frame rather than dropping it', () => {
    const pool = [
      candidate({ seconds: 0, hash: null }),
      candidate({ seconds: 10, hash: null }),
      candidate({ seconds: 20, hash: null }),
    ];

    expect(selectDiverseFrames(pool, 3, { minTimeGapSeconds: 0 })).toHaveLength(3);
  });

  it('is deterministic when scores tie', () => {
    const pool = Array.from({ length: 8 }, (_, i) =>
      candidate({ seconds: i * 3, hash: hash(i * 31), sharpness: 100, textScore: 0 }),
    );

    const first = selectDiverseFrames(pool, 3).map((k) => k.seconds);
    const second = selectDiverseFrames(pool, 3).map((k) => k.seconds);
    expect(first).toEqual(second);
  });
});

describe('buildSceneBuckets', () => {
  it('splits a cut-free clip evenly, so a gradual video still gets coverage', () => {
    // The case that has no scene cuts at all: a screen recording that only ever
    // changes gradually. Without buckets it is ranked globally and the budget
    // lands wherever the score happens to peak.
    const edges = buildSceneBuckets([], [0, 100], 4);
    expect(edges).toEqual([25, 50, 75]);
  });

  it('keeps every scene cut as a boundary', () => {
    const edges = buildSceneBuckets([30], [0, 100], 2);
    expect(edges).toContain(30);
  });

  it('subdivides scenes in proportion to their length', () => {
    // One long scene and one short: the long one must not collapse to a single
    // bucket just because it is one "scene".
    const edges = buildSceneBuckets([80], [0, 100], 5);
    expect(edges).toContain(80);
    expect(edges.filter((e) => e < 80).length).toBeGreaterThan(edges.filter((e) => e > 80).length);
  });

  it('returns no buckets when there is nothing to divide', () => {
    expect(buildSceneBuckets([], [0, 0], 5)).toEqual([]);
    expect(buildSceneBuckets([], [0, 100], 1)).toEqual([]);
  });

  it('ignores cuts outside the clip span', () => {
    expect(buildSceneBuckets([-10, 500], [0, 100], 2)).not.toContain(500);
  });
});

describe('selectDiverseFrames with temporal scene clustering', () => {
  /**
   * The failure global ranking cannot fix: one passage is sharper than the rest,
   * so it wins every comparison and takes the entire budget. Buckets make each
   * region put forward its own best instead.
   */
  it('takes frames from every region, not just the sharpest passage', () => {
    const pool = [
      // A brilliant opening: eight frames, all sharper than anything later.
      ...Array.from({ length: 8 }, (_, i) =>
        candidate({ seconds: i, hash: hash(i * 17), sharpness: 1000 - i }),
      ),
      // ...and a duller remainder that still needs representing.
      ...Array.from({ length: 8 }, (_, i) =>
        candidate({ seconds: 50 + i, hash: hash(140 + i * 13), sharpness: 100 - i }),
      ),
    ];

    const globalOnly = selectDiverseFrames(pool, 4, { minTimeGapSeconds: 0 });
    expect(globalOnly.every((k) => k.seconds < 50)).toBe(true); // all from the opening

    const bucketed = selectDiverseFrames(pool, 4, {
      sceneBuckets: buildSceneBuckets([], [0, 57], 4),
    });
    expect(bucketed.filter((k) => k.seconds < 50).length).toBeGreaterThan(0);
    expect(bucketed.filter((k) => k.seconds >= 50).length).toBeGreaterThan(0);
  });

  it('still picks the best frame WITHIN each bucket', () => {
    const pool = [
      candidate({ seconds: 1, hash: hash(0x01), sharpness: 10 }),
      candidate({ seconds: 4, hash: hash(0x02), sharpness: 900 }),
      candidate({ seconds: 51, hash: hash(0xf1), sharpness: 20 }),
      candidate({ seconds: 54, hash: hash(0xf2), sharpness: 800 }),
    ];

    const kept = selectDiverseFrames(pool, 2, { sceneBuckets: [50] });
    expect(kept.map((k) => k.seconds)).toEqual([4, 54]);
  });

  it('fills from elsewhere rather than returning short when a bucket is empty', () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      candidate({ seconds: i, hash: hash(i * 41), sharpness: 500 + i }),
    );
    // Buckets cover 0-100 but every candidate sits in the first one.
    expect(selectDiverseFrames(pool, 4, { sceneBuckets: [25, 50, 75] })).toHaveLength(4);
  });

  it('never admits a duplicate to satisfy a bucket', () => {
    const pool = [
      candidate({ seconds: 0, hash: hash(0x00) }),
      candidate({ seconds: 60, hash: hash(0x00) }), // identical to the first
    ];
    expect(selectDiverseFrames(pool, 2, { sceneBuckets: [30] })).toHaveLength(1);
  });

  it('returns bucketed results in chronological order', () => {
    const pool = [
      candidate({ seconds: 70, hash: hash(0xa0), sharpness: 900 }),
      candidate({ seconds: 10, hash: hash(0x0a), sharpness: 500 }),
      candidate({ seconds: 40, hash: hash(0x50), sharpness: 700 }),
    ];
    const kept = selectDiverseFrames(pool, 3, { sceneBuckets: [30, 60] });
    expect(kept.map((k) => k.seconds)).toEqual([10, 40, 70]);
  });
});

describe('selectKeyFrames', () => {
  /**
   * The outcome test, on a real clip through the real pipeline: a 6-second
   * `testsrc` (a moving pattern — the repo's standard "real content" control).
   *
   * The pairwise-distance assertion is the point. It is the headline fix stated
   * as a property: EVERY pair of returned frames must be visually distinct, not
   * merely each one distinct from its predecessor. Reverting to adjacent-only
   * deduplication passes a frame-count check and fails this the moment a
   * look-alike reappears later in the clip. Asserting the full budget was met
   * alongside it stops the property from passing vacuously on one frame.
   */
  it('fills the budget with frames that are all pairwise distinct', async () => {
    const dir = await createTempDir();
    try {
      const clip = join(dir, 'moving.mp4');
      await generateTestClip(clip, 6);

      const { frames, warnings } = await selectKeyFrames(clip, dir, {
        maxFrames: 4,
        useOcr: false,
      });

      expect(frames).toHaveLength(4);

      const seconds = frames.map((f: IFrameResult) => parseTimestamp(f.time));
      expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);

      // Assert the property against the real predicate, rebuilt from the
      // emitted files, rather than against a hard-coded distance — the rule is
      // "no two kept frames are duplicates", and a literal threshold here would
      // pin an implementation detail instead.
      const emitted: ScoredFrame[] = await Promise.all(
        frames.map(async (f: IFrameResult) => ({
          frame: f,
          seconds: parseTimestamp(f.time),
          hash: await computeDHash(f.filePath),
          sharpness: 0,
          textScore: 0,
          color: await meanColor(f.filePath),
          text: '',
        })),
      );
      for (let i = 0; i < emitted.length; i++) {
        for (let j = i + 1; j < emitted.length; j++) {
          expect(areDuplicates(emitted[i], emitted[j])).toBe(false);
        }
      }

      expect(warnings.join(' ')).toMatch(/Smart frame selection: scored \d+ candidates/);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('honours a budget smaller than the number of distinct looks', async () => {
    const dir = await createTempDir();
    try {
      const clip = join(dir, 'moving.mp4');
      await generateTestClip(clip, 6);

      const { frames } = await selectKeyFrames(clip, dir, { maxFrames: 1, useOcr: false });
      expect(frames).toHaveLength(1);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  /**
   * The second half of the reported problem: a clip whose content changes
   * WITHOUT a hard cut. `denseUiClip` is built for exactly this — one 15px line
   * changes per second on a 1920x1080 background, which scores ~0 on scene
   * detection. Selection must still produce frames, and the warning must show
   * the uniform sampler is what supplied the candidates, because a scene-cut-only
   * candidate source is precisely what returns nothing here.
   */
  it('still finds candidates when the clip changes gradually and never cuts', async () => {
    const clip = await denseUiClip();
    const dir = await createTempDir();
    try {
      const { frames, warnings } = await selectKeyFrames(clip, dir, {
        maxFrames: 6,
        useOcr: false,
      });

      expect(frames.length).toBeGreaterThan(0);

      const summary = warnings.find((w) => w.startsWith('Smart frame selection:'));
      expect(summary).toBeDefined();
      const uniform = Number(/(\d+) uniform/.exec(summary ?? '')?.[1]);
      expect(uniform).toBeGreaterThan(0);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  /**
   * The case that forced the colour signal into {@link areDuplicates}: three
   * solid red / blue / green segments. dHash greyscales and compares each pixel
   * to its right neighbour, so a flat card hashes to all-zero whatever its
   * colour — all three are 0 bits apart, and a hash-only duplicate test throws
   * two of them away. Mean colour separates them by ~283-358.
   */
  it('keeps every solid-colour scene, which the hash alone cannot tell apart', async () => {
    const dir = await createTempDir();
    try {
      const { frames } = await selectKeyFrames(await sceneCutClip(), dir, {
        maxFrames: 12,
        useOcr: false,
      });

      expect(frames).toHaveLength(3);
      const seconds = frames.map((f: IFrameResult) => parseTimestamp(f.time));
      expect(seconds.filter((sec) => sec < SCENE_CUT_TIMES[0])).toHaveLength(1);
      expect(
        seconds.filter((sec) => sec >= SCENE_CUT_TIMES[0] && sec < SCENE_CUT_TIMES[1]),
      ).toHaveLength(1);
      expect(seconds.filter((sec) => sec >= SCENE_CUT_TIMES[1])).toHaveLength(1);
    } finally {
      await cleanupTempDir(dir);
    }
  }, 180_000);

  it('returns nothing for a zero budget without touching ffmpeg', async () => {
    const { frames, ocrByPath } = await selectKeyFrames('/no/such/video.mp4', '/no/such/dir', {
      maxFrames: 0,
    });
    expect(frames).toEqual([]);
    expect(ocrByPath.size).toBe(0);
  });

  /**
   * Graceful degradation, the project's rule: an unreadable source produces an
   * empty result plus a reason, never a throw — and the reason must be a clean
   * single line, not ffmpeg's argv and banner.
   */
  it('degrades to an empty result with a path-free reason on an unusable source', async () => {
    const dir = await createTempDir();
    try {
      const { frames, warnings } = await selectKeyFrames('/definitely/not/a/video.mp4', dir, {
        maxFrames: 5,
        useOcr: false,
      });

      expect(frames).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
      for (const warning of warnings) {
        expect(warning).not.toContain('\n');
        expect(warning).not.toContain('/definitely/not/a/video.mp4');
      }
    } finally {
      await cleanupTempDir(dir);
    }
  }, 60_000);
});
