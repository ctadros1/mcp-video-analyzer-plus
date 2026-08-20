import type { IFrameResult } from '../types.js';
import { warningReason } from '../utils/warnings.js';
import { computeDHash, hammingDistance } from './frame-dedup.js';
import type { KeyFrameExtraction } from './frame-extractor.js';
import { extractDenseFrames, extractSceneFrames, parseTimestamp } from './frame-extractor.js';
import { isMeaningfulOcr, ocrFrames } from './frame-ocr.js';
import type { IOcrResult } from './frame-ocr.js';
import { colorDistance, computeSharpness, meanColor } from './frame-signals.js';

/**
 * How frames are chosen once candidates exist.
 *
 * - `'sceneChange'` — the upstream behaviour: keep whatever ffmpeg's scene
 *   detector fired on, deduplicated against the immediately preceding frame.
 * - `'smart'` — over-sample candidates, score them, then greedily select a
 *   diverse subset. The default.
 */
export type FrameSelectionMode = 'smart' | 'sceneChange';

/** Candidates generated per requested frame, before the hard cap below. */
const DEFAULT_CANDIDATE_MULTIPLIER = 3;

/** Share of the score carried by the OCR-text signal; the rest is sharpness. */
const DEFAULT_OCR_WEIGHT = 0.4;

/**
 * Ceiling on candidates regardless of the multiplier.
 *
 * Every candidate costs a decode, a perceptual hash, a sharpness pass and —
 * when OCR scoring is on — a Tesseract recognition. `maxFrames` tops out at 60,
 * so an unbounded 3x multiplier would put 180 frames through OCR for a single
 * `analyze_video` call.
 */
const MAX_CANDIDATES = 90;

/**
 * Hard ceiling on frames sent to OCR for scoring, and the multiple of the
 * requested frame count used below it.
 *
 * OCR is what selection costs. Measured on a 6-minute 1080p clip, selection
 * without it ran 4.4s against the legacy extractor's 4.1s — a rounding error —
 * and WITH it, 20.0s. That was recognizing every one of 60 candidates, each
 * upscaled to 3000px by `preprocessForOcr`, and it pushed a real export past
 * the MCP client's timeout entirely.
 *
 * The fix is to recognize a shortlist rather than the whole pool: the text
 * signal only has to rank the frames that are still in contention. Twice the
 * requested count leaves real headroom for text to overturn sharpness, while
 * cutting the work by more than half at the default budget.
 */
const OCR_SHORTLIST_MULTIPLE = 2;
const OCR_SHORTLIST_CEILING = 24;

/**
 * Wall-clock budget for the whole OCR scoring pass.
 *
 * A shortlist bounds the frame COUNT, not the time per frame, and that varies
 * by orders of magnitude with resolution and how much text is on screen. This
 * is the backstop that keeps a pathological video from timing out the client:
 * past the budget the text signal is abandoned for every candidate at once —
 * never for some of them, which would rank the recognized frames against zeros
 * and silently bias the result toward whichever ones happened to finish first.
 */
const OCR_SCORING_BUDGET_MS = 20_000;

/** Thrown to stop `ocrFrames` once the scoring budget is spent. */
const OCR_BUDGET_EXCEEDED = Symbol('ocr-budget-exceeded');

/**
 * Scene threshold for CANDIDATE generation, as a fraction of the caller's.
 *
 * Deliberately far more sensitive than the emitted-frame threshold: the point
 * of over-sampling is to let scoring — not a pixel-difference cutoff — decide
 * what survives. Gradual on-screen changes never cross the caller's 0.1 and are
 * exactly the content that returned zero frames before.
 */
const CANDIDATE_THRESHOLD_FACTOR = 0.4;
const MIN_CANDIDATE_THRESHOLD = 0.02;

/**
 * Two candidates closer together than this (seconds) are the same moment
 * arriving from both sources — the scene detector and the uniform sampler.
 */
const CANDIDATE_TIME_EPSILON = 0.5;

/**
 * Hamming distance (of 72 bits) at or below which two frames may be duplicates.
 *
 * Deliberately far LOWER than `deduplicateFrames`' 5, because this constraint
 * is applied differently and the hash turned out to have very little range.
 * Upstream compares a frame only with its immediate predecessor, so one
 * rejection costs one frame; here every candidate is compared with every frame
 * already kept, so rejections compound.
 *
 * Measured over all candidate pairs of the repo's own fixtures, dHash spans
 * almost nothing: a 30-second moving `testsrc` clip tops out at 5-6 bits
 * (median 4), and clips whose on-screen text changes top out at 1-2. A
 * threshold of 5 therefore kept ONE frame out of thirty — far worse than the
 * behaviour this replaces. At 1 the hash is used only for what it can actually
 * prove: that two frames are all but identical.
 *
 * It is one of THREE conditions — see {@link areDuplicates}. The hash alone
 * cannot carry this decision, which is what the measurement above showed.
 */
const MIN_HAMMING_DISTANCE = 1;

/**
 * Mean-colour distance below which two frames count as the same look.
 *
 * Calibrated on the same fixtures: two frames of one UI differing only in a
 * line of text measure ~0.01 apart, while solid red / blue / green cards — the
 * case the hash cannot see at all — measure 283-358 apart. Anything under 3 is
 * comfortably inside "same scene" for every clip measured.
 */
const MAX_DUPLICATE_COLOR_DISTANCE = 3;

/**
 * Minimum spacing between kept frames, as a fraction of the even spacing that
 * `target` frames would have across the clip. Below 1.0 by a wide margin: this
 * only exists to stop greedy top-score selection from returning ten frames of
 * the one visually busy passage and nothing from the rest of the video.
 */
const TIME_GAP_FRACTION = 0.35;

/** A candidate frame with every signal selection needs, before ranking. */
export interface ScoredFrame {
  frame: IFrameResult;
  /** Position in the clip, parsed back from `frame.time`. */
  seconds: number;
  /** dHash, or null when the frame could not be hashed (treated as distinct). */
  hash: Buffer | null;
  /** Laplacian variance — higher is sharper. Raw, normalized at ranking time. */
  sharpness: number;
  /** On-screen-text density. Raw, normalized at ranking time. */
  textScore: number;
  /**
   * Mean R,G,B — separates scenes the gradient-only hash cannot. Null if it
   * could not be read, which makes the frame un-duplicatable (a safe keep).
   *
   * Required rather than optional on purpose: an omitted colour reads as null,
   * and null makes {@link areDuplicates} answer "not a duplicate" for every
   * pair — silently disabling de-duplication instead of failing.
   */
  color: number[] | null;
  /** Normalized OCR text, or `''` when there is none worth trusting. */
  text: string;
}

export interface SelectionTuning {
  /** Share of the score carried by OCR text density (0-1). */
  ocrWeight?: number;
  /** Hamming distance at or below which two frames may be duplicates. */
  minHammingDistance?: number;
  /** Explicit spacing floor in seconds; derived from the clip span when unset. */
  minTimeGapSeconds?: number;
}

/**
 * OCR text density for one frame.
 *
 * `log1p` on the character count rather than the count itself: a single
 * text-heavy frame (a full terminal, a wall of code) would otherwise flatten
 * every other candidate's normalized score to near zero. Low-confidence
 * recognitions score 0 — noise must not be able to fake an informative frame.
 */
export function ocrTextScore(result: IOcrResult | undefined): number {
  if (!result || !isMeaningfulOcr(result)) return 0;
  const characters = result.text.replace(/\s+/g, ' ').trim().length;
  return Math.log1p(characters) * (result.confidence / 100);
}

/**
 * Rank candidates and greedily keep a diverse subset of at most `target`.
 *
 * Pure and synchronous: every signal is already computed by the caller, so the
 * selection policy itself is unit-testable without ffmpeg, sharp or Tesseract.
 *
 * Both signals are normalized against the pool maximum rather than an absolute
 * scale. That is what keeps the OCR term from penalizing b-roll: on a clip
 * where nothing is legible, every candidate scores 0 for text and sharpness
 * alone decides the ranking — the text term cannot drag a whole pool down, only
 * reorder it when some frames really do carry more text than others.
 *
 * Selection runs in two passes. The first enforces both constraints; the second
 * relaxes the temporal spacing (never the visual-distinctness one) to fill the
 * remaining budget. Without the second pass a clip whose content is bunched
 * into one passage would return fewer frames than asked for.
 */
export function selectDiverseFrames(
  candidates: ScoredFrame[],
  target: number,
  tuning: SelectionTuning = {},
): ScoredFrame[] {
  if (target <= 0 || candidates.length === 0) return [];

  const ocrWeight = clamp01(tuning.ocrWeight ?? DEFAULT_OCR_WEIGHT);
  const minHamming = tuning.minHammingDistance ?? MIN_HAMMING_DISTANCE;

  const maxSharpness = Math.max(...candidates.map((c) => c.sharpness), 0);
  const maxText = Math.max(...candidates.map((c) => c.textScore), 0);

  const scored = candidates.map((candidate) => {
    const sharpNorm = maxSharpness > 0 ? candidate.sharpness / maxSharpness : 0;
    const textNorm = maxText > 0 ? candidate.textScore / maxText : 0;
    return { candidate, score: (1 - ocrWeight) * sharpNorm + ocrWeight * textNorm };
  });

  // Ties fall through to sharpness, then to time. Sharpness second matters at
  // `ocrWeight: 1` on a clip with no legible text: every candidate then scores
  // 0, and breaking straight to time would hand back the earliest frames rather
  // than the clearest ones. Time last keeps the result deterministic — two
  // identical frames must not reorder between runs.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.candidate.sharpness - a.candidate.sharpness ||
      a.candidate.seconds - b.candidate.seconds,
  );

  const times = candidates.map((c) => c.seconds);
  const span = Math.max(...times) - Math.min(...times);
  const minGap = tuning.minTimeGapSeconds ?? (span > 0 ? (span / target) * TIME_GAP_FRACTION : 0);

  const kept: ScoredFrame[] = [];
  const taken = new Set<ScoredFrame>();

  const admit = (gap: number): void => {
    for (const { candidate } of scored) {
      if (kept.length >= target) return;
      if (taken.has(candidate)) continue;
      if (!isDistinct(candidate, kept, minHamming, gap)) continue;
      kept.push(candidate);
      taken.add(candidate);
    }
  };

  admit(minGap);
  if (kept.length < target && minGap > 0) admit(0);

  return kept.sort((a, b) => a.seconds - b.seconds);
}

/**
 * Whether two frames carry the same information — the test that decides which
 * candidate is redundant.
 *
 * Three signals, and a frame is a duplicate only when ALL of them agree. Each
 * one is blind where another sees:
 *
 * - **On-screen text.** Different legible text means different information,
 *   whatever the pixels say. This is the rule `dedupeKeepingTextChanges`
 *   already establishes for static-background clips whose only change is an
 *   overlay; the same reasoning has to hold here or selection would undo it.
 * - **Perceptual hash.** Catches all-but-identical framing, but is greyscale
 *   and gradient-only, so it cannot tell a red card from a blue one.
 * - **Mean colour.** Exactly covers that blind spot, and stays near zero for
 *   two frames of the same scene.
 *
 * A frame that could not be hashed is never called a duplicate — the same safe
 * fallback `deduplicateFrames` makes, so a failed read costs ranking quality
 * but never silently drops a frame.
 */
export function areDuplicates(
  a: ScoredFrame,
  b: ScoredFrame,
  minHamming = MIN_HAMMING_DISTANCE,
): boolean {
  if (a.text && b.text && a.text !== b.text) return false;
  if (!a.hash || !b.hash) return false;
  if (hammingDistance(a.hash, b.hash) > minHamming) return false;
  return colorDistance(a.color, b.color) <= MAX_DUPLICATE_COLOR_DISTANCE;
}

/** Distinct from every already-kept frame, and far enough from each in time. */
function isDistinct(
  candidate: ScoredFrame,
  kept: ScoredFrame[],
  minHamming: number,
  minGap: number,
): boolean {
  for (const other of kept) {
    if (minGap > 0 && Math.abs(candidate.seconds - other.seconds) < minGap) return false;
    if (areDuplicates(candidate, other, minHamming)) return false;
  }
  return true;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OCR_WEIGHT;
  return Math.min(1, Math.max(0, value));
}

export interface SmartSelectionOptions {
  /** Caller's scene-change sensitivity; relaxed for candidate generation. */
  threshold?: number;
  /** Frames to return. */
  maxFrames?: number;
  /** Candidates per requested frame (default 3, capped at 90 total). */
  candidateMultiplier?: number;
  /** Share of the score carried by OCR text density (default 0.4). */
  ocrWeight?: number;
  /** Run OCR to score candidates. Off leaves sharpness + diversity. */
  useOcr?: boolean;
  ocrLanguage?: string;
}

export interface SmartFrameSelection extends KeyFrameExtraction {
  /**
   * OCR results for the selected frames, keyed by the file path they had when
   * OCR ran (the pre-optimization candidate path).
   *
   * Selection already paid for this recognition; handing it back lets the
   * analysis pipeline reuse it instead of OCR-ing the same frames a second
   * time. Empty when OCR scoring did not run.
   */
  ocrByPath: ReadonlyMap<string, IOcrResult>;
}

/**
 * Over-sample, score, and select — the `'smart'` half of {@link FrameSelectionMode}.
 *
 * Candidates come from BOTH a relaxed scene detector and uniform temporal
 * sampling, merged. That pairing is the point: scene cuts alone miss passages
 * that change gradually (a scrolling document, a slowly redrawn dashboard),
 * and uniform sampling alone lands mid-transition on hard cuts. Whichever
 * source contributed it, a candidate then has to earn its place on sharpness,
 * on-screen text and distinctness from everything already kept.
 *
 * Never throws — extraction failures degrade to `[]` plus a warning, matching
 * `extractKeyFrames` and the project's graceful-degradation rule.
 */
export async function selectKeyFrames(
  videoPath: string,
  outputDir: string,
  options: SmartSelectionOptions = {},
): Promise<SmartFrameSelection> {
  const warnings: string[] = [];
  const empty = {
    frames: [] as IFrameResult[],
    warnings,
    ocrByPath: new Map<string, IOcrResult>(),
  };

  const target = options.maxFrames ?? 20;
  if (target <= 0) return empty;

  const multiplier = Math.max(1, options.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER);
  const budget = Math.min(Math.round(target * multiplier), MAX_CANDIDATES);

  const sceneThreshold = Math.max(
    (options.threshold ?? 0.1) * CANDIDATE_THRESHOLD_FACTOR,
    MIN_CANDIDATE_THRESHOLD,
  );

  const [sceneFrames, uniformFrames] = await Promise.all([
    extractSceneFrames(videoPath, outputDir, {
      threshold: sceneThreshold,
      maxFrames: budget,
    }).catch((e: unknown) => {
      warnings.push(`Scene candidate extraction failed: ${warningReason(e)}`);
      return [] as IFrameResult[];
    }),
    extractDenseFrames(videoPath, outputDir, { maxFrames: budget }).catch((e: unknown) => {
      warnings.push(`Uniform candidate sampling failed: ${warningReason(e)}`);
      return [] as IFrameResult[];
    }),
  ]);

  const candidates = mergeCandidates(sceneFrames, uniformFrames, budget);
  if (candidates.length === 0) {
    warnings.push(
      'Smart frame selection found no candidate frames — neither scene detection nor uniform sampling produced output.',
    );
    return empty;
  }

  const hashes = await Promise.all(
    candidates.map((frame) => computeDHash(frame.filePath).catch(() => null)),
  );
  const sharpness = await Promise.all(
    candidates.map((frame) => computeSharpness(frame.filePath).catch(() => 0)),
  );
  const colors = await Promise.all(candidates.map((frame) => meanColor(frame.filePath)));

  /** OCR results keyed by the candidate they were computed for. */
  const ocrByFrame = new Map<IFrameResult, IOcrResult>();

  const scored: ScoredFrame[] = candidates.map((frame, i) => ({
    frame,
    seconds: secondsOf(frame),
    hash: hashes[i],
    sharpness: sharpness[i],
    textScore: 0,
    color: colors[i],
    text: '',
  }));

  // A weight of 0 says on-screen text must not influence the ranking, so
  // recognizing it would be pure cost. Checked before the shortlist, since it
  // makes the entire pass unnecessary rather than merely smaller.
  const ocrWeight = options.ocrWeight ?? DEFAULT_OCR_WEIGHT;
  const wantsOcr = (options.useOcr ?? true) && ocrWeight > 0;

  // Shortlist first, on the cheap signals alone: OCR only has to separate the
  // frames still in contention, and the pool is where the cost lives.
  const shortlistSize = Math.min(target * OCR_SHORTLIST_MULTIPLE, OCR_SHORTLIST_CEILING);
  const pool = wantsOcr ? selectDiverseFrames(scored, shortlistSize, { ocrWeight: 0 }) : scored;

  if (wantsOcr) {
    const ocrResults = await ocrWithBudget(pool, options.ocrLanguage);
    if (ocrResults === null) {
      warnings.push(
        `Smart selection abandoned the OCR signal after ${OCR_SCORING_BUDGET_MS / 1000}s (${pool.length} frames); ranked on sharpness and visual diversity only.`,
      );
    } else if (ocrResults.length !== pool.length) {
      warnings.push(
        'OCR scoring unavailable (tesseract.js missing or recognition aborted); ranked on sharpness and visual diversity only.',
      );
    } else {
      pool.forEach((entry, i) => {
        entry.textScore = ocrTextScore(ocrResults[i]);
        entry.text = normalizeOcrText(ocrResults[i]);
        if (ocrResults[i]) ocrByFrame.set(entry.frame, ocrResults[i]);
      });
    }
  }

  const selected = selectDiverseFrames(pool, target, { ocrWeight });

  const ocrByPath = new Map<string, IOcrResult>();
  for (const entry of selected) {
    const result = ocrByFrame.get(entry.frame);
    if (result) ocrByPath.set(entry.frame.filePath, result);
  }

  warnings.push(
    `Smart frame selection: scored ${candidates.length} candidates ` +
      `(${sceneFrames.length} scene-change, ${uniformFrames.length} uniform)` +
      `${pool.length < candidates.length ? `, OCR-ranked the top ${pool.length}` : ''} ` +
      `and kept ${selected.length}.`,
  );

  return { frames: selected.map((entry) => entry.frame), warnings, ocrByPath };
}

/**
 * Recognize `pool`, giving up if the wall-clock budget runs out.
 *
 * Returns null when the budget was hit — all-or-nothing on purpose. Handing
 * back the frames that finished would rank them against zeros for the ones that
 * did not, which is not "partial data", it is a systematically wrong ordering
 * that favours whatever the loop reached first.
 */
async function ocrWithBudget(
  pool: ScoredFrame[],
  language: string | undefined,
): Promise<IOcrResult[] | null> {
  const deadline = Date.now() + OCR_SCORING_BUDGET_MS;
  try {
    return await ocrFrames(
      pool.map((entry) => entry.frame),
      language,
      () => {
        // The only hook `ocrFrames` offers between frames. Throwing here stops
        // the loop and still runs its `finally`, so the worker is terminated
        // rather than left alive holding a language model.
        if (Date.now() > deadline) throw OCR_BUDGET_EXCEEDED;
      },
    );
  } catch (error: unknown) {
    if (error === OCR_BUDGET_EXCEEDED) return null;
    return [];
  }
}

/**
 * One candidate list from both sources, in time order, without the duplicates
 * that arise where a scene cut and a sampling tick land on the same moment.
 *
 * Scene frames win a tie: they sit ON the cut, while the uniform tick that
 * matched is up to half a second late and may already be mid-transition.
 */
function mergeCandidates(
  sceneFrames: IFrameResult[],
  uniformFrames: IFrameResult[],
  budget: number,
): IFrameResult[] {
  const ordered = [...sceneFrames, ...uniformFrames].sort((a, b) => secondsOf(a) - secondsOf(b));

  const merged: IFrameResult[] = [];
  const fromScene = new Set(sceneFrames);
  for (const frame of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(secondsOf(frame) - secondsOf(previous)) < CANDIDATE_TIME_EPSILON) {
      if (fromScene.has(frame) && !fromScene.has(previous)) merged[merged.length - 1] = frame;
      continue;
    }
    merged.push(frame);
  }

  if (merged.length <= budget) return merged;

  // Over budget: thin evenly across the clip rather than truncating the tail,
  // which would drop the entire back half of a long video.
  const step = merged.length / budget;
  return Array.from({ length: budget }, (_, i) => merged[Math.floor(i * step)]);
}

/**
 * OCR text in the form the duplicate test compares — the same normalization
 * `dedupeKeepingTextChanges` applies, and `''` for anything below the
 * confidence floor so noise cannot pass as a change.
 */
function normalizeOcrText(result: IOcrResult | undefined): string {
  if (!result || !isMeaningfulOcr(result)) return '';
  return result.text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A frame's position in seconds; unparseable timestamps sort to the front. */
function secondsOf(frame: IFrameResult): number {
  try {
    return parseTimestamp(frame.time);
  } catch {
    return 0;
  }
}
