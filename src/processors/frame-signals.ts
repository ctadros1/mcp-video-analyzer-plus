import sharp from 'sharp';

/**
 * Cheap per-frame image signals used to rank and de-duplicate candidate frames.
 *
 * Everything here reads one already-extracted JPEG through `sharp` — no new
 * dependency, no decode of the source video, no per-frame API call.
 */

/**
 * Width the frame is reduced to before the Laplacian pass.
 *
 * Two reasons, both load-bearing. Cost: the convolution is per-pixel and runs
 * on every candidate. Comparability: Laplacian variance rises with resolution,
 * so scoring a 1920px scene frame against a 640px one would rank by source
 * size rather than by focus — every candidate must be measured at one scale.
 */
const ANALYSIS_WIDTH = 320;

/**
 * Laplacian variance of a frame — the standard reference-free blur metric.
 *
 * A sharp image has strong second derivatives at its edges, so the response of
 * a Laplacian kernel is spread wide and its variance is high; motion blur and
 * dissolve frames smear those edges away and the variance collapses. That is
 * precisely the mid-transition frame the scene detector likes to fire on, which
 * is why this exists.
 *
 * The convolution is written out rather than handed to `sharp.convolve()`
 * because sharp clamps its output to the unsigned 8-bit range: every negative
 * half of the response — half the signal — would be flattened to zero before
 * the variance was taken, and a blurry frame would score closer to a sharp one
 * than it deserves.
 *
 * Returns 0 for images too small to convolve. The absolute value is meaningless
 * on its own; it is only ever compared against other frames from the same clip.
 */
export async function computeSharpness(imagePath: string): Promise<number> {
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .resize({ width: ANALYSIS_WIDTH, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return laplacianVariance(data, info.width, info.height, info.channels);
}

/**
 * Variance of the 3x3 Laplacian response over the interior pixels.
 *
 * Exported for its own unit test: the metric has no meaningful absolute scale,
 * so the only way to pin it is to feed it synthetic buffers whose relative
 * ordering is known (flat < noisy) rather than to assert a number.
 */
export function laplacianVariance(
  data: Uint8Array,
  width: number,
  height: number,
  channels = 1,
): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * channels;
      const response =
        4 * data[i] -
        data[i - channels] -
        data[i + channels] -
        data[i - width * channels] -
        data[i + width * channels];
      sum += response;
      sumSquares += response * response;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

/**
 * Mean R, G, B of a frame (0-255 each), or null when it cannot be read.
 *
 * Pairs with the perceptual hash rather than duplicating it, because the two
 * are blind in opposite directions. `computeDHash` greyscales the frame and
 * compares each pixel to its right neighbour, so it encodes *gradient* and
 * discards colour entirely: three solid red / blue / green cards hash
 * identically (measured: Hamming distance 0 between all pairs), and a hash-only
 * duplicate test throws two of the three away. Mean colour separates those at a
 * distance of ~283-358 while correctly reporting ~0.01 for two frames of the
 * same UI whose only difference is a line of text — which is the case the OCR
 * signal, not this one, is there to catch.
 *
 * Uses the same `sharp(...).stats()` call `isBlackFrame` already makes.
 */
export async function meanColor(imagePath: string): Promise<number[] | null> {
  try {
    const { channels } = await sharp(imagePath).stats();
    if (channels.length === 0) return null;
    return channels.slice(0, 3).map((channel) => channel.mean);
  } catch {
    return null;
  }
}

/** Euclidean distance between two mean-colour vectors; Infinity if either is absent. */
export function colorDistance(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || b.length === 0) return Infinity;
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}
