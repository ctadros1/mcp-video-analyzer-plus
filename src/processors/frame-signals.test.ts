import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { colorDistance, computeSharpness, laplacianVariance, meanColor } from './frame-signals.js';

/** A checkerboard: the densest edge content an image of this size can carry. */
function checkerboard(width: number, height: number, cell: number): Buffer {
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      data[y * width + x] = on ? 255 : 0;
    }
  }
  return data;
}

describe('laplacianVariance', () => {
  it('is zero for a flat image (no edges at all)', () => {
    const flat = Buffer.alloc(32 * 32, 128);
    expect(laplacianVariance(flat, 32, 32)).toBe(0);
  });

  it('ranks a checkerboard above a flat image', () => {
    const flat = Buffer.alloc(64 * 64, 128);
    const edges = checkerboard(64, 64, 4);
    expect(laplacianVariance(edges, 64, 64)).toBeGreaterThan(laplacianVariance(flat, 64, 64));
  });

  it('ranks fine detail above coarse detail at the same size', () => {
    const fine = laplacianVariance(checkerboard(64, 64, 2), 64, 64);
    const coarse = laplacianVariance(checkerboard(64, 64, 16), 64, 64);
    expect(fine).toBeGreaterThan(coarse);
  });

  it('returns 0 for images too small to convolve', () => {
    expect(laplacianVariance(Buffer.alloc(4, 200), 2, 2)).toBe(0);
  });

  it('reads the first channel when the buffer is interleaved RGB', () => {
    // Same checkerboard, spread across 3 channels — the stride must be honored,
    // or the metric reads two neighbours of the wrong colour plane as an edge.
    const gray = checkerboard(32, 32, 4);
    const rgb = Buffer.alloc(32 * 32 * 3);
    for (let i = 0; i < gray.length; i++) {
      rgb[i * 3] = gray[i];
      rgb[i * 3 + 1] = gray[i];
      rgb[i * 3 + 2] = gray[i];
    }
    expect(laplacianVariance(rgb, 32, 32, 3)).toBeCloseTo(laplacianVariance(gray, 32, 32, 1), 5);
  });
});

describe('computeSharpness', () => {
  /**
   * The outcome test, on real image files through real sharp decoding: a blur
   * is exactly what a mid-transition video frame is, and rejecting those is the
   * whole reason this metric exists. An implementation that scored them equally
   * would pass every synthetic-buffer test above and still be useless.
   */
  it('scores a blurred frame far below the sharp original', async () => {
    const dir = await createTempDir();
    try {
      const pixels = checkerboard(160, 160, 4);
      const raw = { raw: { width: 160, height: 160, channels: 1 as const } };

      const sharpPath = join(dir, 'sharp.jpg');
      const blurredPath = join(dir, 'blurred.jpg');
      await sharp(pixels, raw).jpeg({ quality: 95 }).toFile(sharpPath);
      await sharp(pixels, raw).blur(6).jpeg({ quality: 95 }).toFile(blurredPath);

      const sharpScore = await computeSharpness(sharpPath);
      const blurredScore = await computeSharpness(blurredPath);

      expect(sharpScore).toBeGreaterThan(0);
      expect(blurredScore).toBeLessThan(sharpScore / 2);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it('rejects an unreadable file rather than reporting it as sharp', async () => {
    await expect(computeSharpness(join('does', 'not', 'exist.jpg'))).rejects.toThrow();
  });
});

describe('colorDistance', () => {
  it('is zero for identical colours', () => {
    expect(colorDistance([10, 20, 30], [10, 20, 30])).toBe(0);
  });

  it('grows with how far apart the colours are', () => {
    expect(colorDistance([200, 30, 30], [30, 30, 200])).toBeGreaterThan(
      colorDistance([200, 30, 30], [190, 30, 40]),
    );
  });

  it('is Infinity when either colour is missing, so nothing reads as a duplicate', () => {
    expect(colorDistance(null, [1, 2, 3])).toBe(Infinity);
    expect(colorDistance([1, 2, 3], null)).toBe(Infinity);
    expect(colorDistance([], [1, 2, 3])).toBe(Infinity);
  });
});

describe('meanColor', () => {
  /**
   * The measurement this signal exists for: solid colour cards are 0 Hamming
   * bits apart under dHash (greyscale, gradient-only) and must be separated by
   * something else. Two frames of one scene have to stay close, or the signal
   * would break de-duplication instead of completing it.
   */
  it('separates solid colours far more than it separates shades of one colour', async () => {
    const dir = await createTempDir();
    try {
      const card = async (name: string, background: { r: number; g: number; b: number }) => {
        const path = join(dir, name);
        await sharp({ create: { width: 64, height: 64, channels: 3, background } })
          .jpeg()
          .toFile(path);
        return meanColor(path);
      };

      const red = await card('red.jpg', { r: 220, g: 20, b: 20 });
      const blue = await card('blue.jpg', { r: 20, g: 20, b: 220 });
      const nearlyRed = await card('nearly-red.jpg', { r: 219, g: 21, b: 21 });

      expect(colorDistance(red, blue)).toBeGreaterThan(100);
      expect(colorDistance(red, nearlyRed)).toBeLessThan(3);
    } finally {
      await cleanupTempDir(dir);
    }
  });

  it('returns null for an unreadable file instead of throwing', async () => {
    expect(await meanColor(join('does', 'not', 'exist.jpg'))).toBeNull();
  });
});
