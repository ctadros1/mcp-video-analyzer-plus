import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames, generateTimestamps } from '../processors/browser-frame-extractor.js';
import { deduplicateFrames, filterBlackFrames } from '../processors/frame-dedup.js';
import {
  extractKeyFrames,
  formatTimestamp,
  probeVideoDuration,
} from '../processors/frame-extractor.js';
import { selectKeyFrames } from '../processors/frame-selector.js';
import { optimizeFramesKeepingOriginals } from '../processors/image-optimizer.js';
import { createProgressReporter } from '../utils/progress.js';
import {
  localFallbackPathParam,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
  videoUrlParam,
} from '../utils/source-fallback.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { toLocalPath } from '../utils/url-detector.js';
import { warningReason } from '../utils/warnings.js';
import { maxWidthParam } from './frame-options.js';

const GetFramesSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
  options: z
    .object({
      maxFrames: z
        .number()
        .min(1)
        .max(60)
        .default(20)
        .optional()
        .describe('Maximum number of frames to extract (default: 20)'),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.1)
        .optional()
        .describe('Scene-change sensitivity 0.0-1.0 (default: 0.1)'),
      dense: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          'Use dense sampling (1 frame/sec) instead of scene-change detection. Takes precedence over frameSelection — asking for uniform coverage means uniform coverage.',
        ),
      frameSelection: z
        .enum(['smart', 'sceneChange'])
        .optional()
        .describe(
          'How frames are chosen when dense is false. "smart" (default) over-samples candidates (scene cuts + uniform sampling), scores them on sharpness, and greedily keeps a visually diverse subset. "sceneChange" is the legacy path. This tool does not run OCR, so the smart score here is sharpness + diversity only — use analyze_video for the on-screen-text signal.',
        ),
      maxWidth: maxWidthParam,
    })
    .optional(),
});

export function registerGetFrames(server: FastMCP): void {
  server.addTool({
    name: 'get_frames',
    description: `Extract key frames from a video URL without transcript or metadata.

Two extraction modes:
- Scene-change detection (default): captures visual transitions
- Dense sampling (dense=true): captures 1 frame/sec for full video coverage

Returns optimized, deduplicated JPEG frames.

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).`,
    parameters: GetFramesSchema,
    annotations: {
      title: 'Get Frames',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { options } = args;
      const source = resolveVideoSource(args);
      const maxFrames = options?.maxFrames ?? 20;
      const threshold = options?.threshold ?? 0.1;
      const dense = options?.dense ?? false;
      const frameSelection = options?.frameSelection ?? 'smart';

      await progress(0, 'Starting frame extraction...');

      const extractFrom = async (url: string) => {
        let adapter;
        try {
          adapter = getAdapter(url);
        } catch (error) {
          if (error instanceof UserError) throw error;
          throw new UserError(`Failed to detect video platform for URL: ${url}`);
        }

        const warnings: string[] = [];
        const tempDir = await createTempDir();

        // Get metadata for duration (needed for browser fallback). Surface the
        // failure: the browser fallback is gated on duration > 0, so a swallowed
        // metadata error would skip it and mislabel the result as "install
        // yt-dlp" when the real cause was the metadata fetch.
        const metadata = await adapter.getMetadata(url).catch((e: unknown) => {
          warnings.push(`Could not fetch video metadata: ${warningReason(e)}`);
          return {
            platform: adapter.name,
            title: 'Unknown',
            duration: 0,
            durationFormatted: '0:00',
            url,
          };
        });

        let frames: { time: string; filePath: string; mimeType: string }[] = [];

        // Strategy 1: Download + ffmpeg
        if (adapter.capabilities.videoDownload) {
          const videoPath = await adapter.downloadVideo(url, tempDir, (w) => warnings.push(w));
          if (videoPath) {
            await progress(40, 'Video downloaded, extracting frames...');

            if (metadata.duration === 0) {
              const duration = await probeVideoDuration(videoPath).catch(() => 0);
              metadata.duration = duration;
              metadata.durationFormatted = formatTimestamp(Math.floor(duration));
            }

            const extraction =
              frameSelection === 'smart' && !dense
                ? await selectKeyFrames(videoPath, tempDir, {
                    threshold,
                    maxFrames,
                    // This tool has never run OCR and is documented as the fast
                    // one; adding a Tesseract pass per candidate would change
                    // its performance character. Sharpness + diversity still fix
                    // the blur and near-duplicate problems scene detection has.
                    useOcr: false,
                  })
                : await extractKeyFrames(videoPath, tempDir, {
                    threshold,
                    maxFrames,
                    dense,
                  });
            const rawFrames = extraction.frames;
            warnings.push(...extraction.warnings);

            if (rawFrames.length > 0) {
              // A failed optimization degrades to the raw frames, but says so —
              // the analyze tools already warn here, and a systemic sharp/disk
              // failure that only some tools report is worse than either rule.
              const optimized = await optimizeFramesKeepingOriginals(rawFrames, tempDir, {
                maxWidth: options?.maxWidth,
                onWarning: (w) => warnings.push(w),
              });
              frames = optimized.frames;
            }
          }
        }

        // Strategy 2: Browser fallback — skipped for local files since
        // puppeteer.goto() can't load fs paths reliably.
        const isLocal = toLocalPath(url) !== null;
        if (frames.length === 0 && !isLocal && metadata.duration > 0) {
          await progress(40, 'Extracting frames via browser fallback...');
          const timestamps = generateTimestamps(metadata.duration, maxFrames);
          frames = await extractBrowserFrames(url, tempDir, { timestamps }).catch((e: unknown) => {
            warnings.push(`Browser extraction failed: ${e instanceof Error ? e.name : 'error'}`);
            return [];
          });
        }

        // Whether extraction produced anything before filtering — distinguishes
        // "all frames filtered as black" from "nothing decodable" in the reason.
        const extractedCount = frames.length;

        // Filter black/blank frames
        await progress(80, 'Filtering and deduplicating frames...');
        if (frames.length > 0) {
          const blackResult = await filterBlackFrames(frames).catch(() => ({
            frames,
            removedCount: 0,
          }));
          if (blackResult.removedCount > 0) {
            warnings.push(
              `Removed ${blackResult.removedCount} black/blank frame(s) — video may be DRM-protected`,
            );
          }
          frames = blackResult.frames;
        }

        // Dedup — skipped after smart selection, which already enforced
        // pairwise distinctness across the whole candidate pool with a stricter
        // rule. This step compares adjacent frames at a Hamming threshold far
        // above the range dHash actually spans, so it would undo the selection.
        if (frames.length > 0 && !(frameSelection === 'smart' && !dense)) {
          const before = frames.length;
          frames = await deduplicateFrames(frames).catch(() => frames);
          if (frames.length < before) {
            warnings.push(`Removed ${before - frames.length} duplicate frames`);
          }
        }

        // Degrade like analyze_video rather than throwing: a zero-frame result
        // (extraction failure, or every extracted frame filtered out as black)
        // returns frameCount: 0 with the accumulated warnings — which carry the
        // real, actionable reason. The old throw discarded that whole `warnings`
        // array and emitted a generic message (issue #26). Dedup can't empty a
        // non-empty set (it always keeps frame[0]), so a filtered-to-zero result
        // is always the black-frame filter, not dedup.
        //
        // This runs INSIDE the attempt, not after it: "could not extract any
        // frames" is the very signal `localFallbackPath` exists to act on, and
        // a reason appended after the runner had already returned would arrive
        // too late to trigger the retry.
        if (frames.length === 0) {
          warnings.push(
            extractedCount > 0
              ? 'Extracted frames were all filtered out as black/blank — the video may be DRM-protected or a blank screen.'
              : isLocal
                ? 'Could not extract any frames from this local file — ffmpeg produced no frames (the file may be unreadable, zero-length, or have no decodable video stream).'
                : 'Could not extract any frames. Install yt-dlp or Chrome/Chromium for frame extraction.',
          );
        }

        return { frames, warnings, tempDir };
      };

      const outcome = await runWithLocalFallback(source, extractFrom, {
        remoteFailureIn: (result) => remoteFailureInWarnings(result.warnings),
        // The superseded attempt's frames are never emitted, so its temp dir has
        // nothing left to hold open.
        dispose: (result) => cleanupTempDir(result.tempDir),
      });
      const { frames, warnings } = outcome.value;
      if (outcome.warning) warnings.push(outcome.warning);

      await progress(100, 'Frames extracted');

      const content: ({ type: 'text'; text: string } | Awaited<ReturnType<typeof imageContent>>)[] =
        [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                frameCount: frames.length,
                mode: dense ? 'dense' : frameSelection === 'smart' ? 'smart' : 'scene',
                warnings,
              },
              null,
              2,
            ),
          },
        ];

      for (const frame of frames) {
        content.push(await imageContent({ path: frame.filePath }));
      }

      return { content };
    },
  });
}
