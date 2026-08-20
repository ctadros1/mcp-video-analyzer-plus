import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames } from '../processors/browser-frame-extractor.js';
import { extractFrameBurst, parseTimestamp } from '../processors/frame-extractor.js';
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
import { maxWidthParam } from './frame-options.js';

const GetFrameBurstSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
  from: z.string().describe('Start timestamp (e.g., "0:15")'),
  to: z.string().describe('End timestamp (e.g., "0:17")'),
  count: z
    .number()
    .min(2)
    .max(30)
    .default(5)
    .optional()
    .describe('Number of frames to extract (default: 5)'),
  returnBase64: z
    .boolean()
    .default(false)
    .optional()
    .describe('Return frames as base64 inline instead of file paths'),
  maxWidth: maxWidthParam,
});

export function registerGetFrameBurst(server: FastMCP): void {
  server.addTool({
    name: 'get_frame_burst',
    description: `Extract multiple frames evenly distributed across a time range.

Designed for motion and vibration analysis where scene-change detection fails because
the "scene" doesn't change — only the position/state of objects does.

Example: get_frame_burst(url, "0:15", "0:17", 10) → 10 frames in 2 seconds
- AI sees the object in different positions across frames → understands the vibration
- Works for: shaking, flickering, animations, fast scrolling, loading spinners

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Args:
  - url: Video source (URL or local path)
  - from: Start timestamp (e.g., "0:15")
  - to: End timestamp (e.g., "0:17")
  - count: Number of frames (default: 5, max: 30)
  - localFallbackPath: Optional local copy of the video, used automatically if the remote source is blocked or unreachable (reported in warnings[])

Returns: N images evenly distributed between the from and to timestamps.`,
    parameters: GetFrameBurstSchema,
    annotations: {
      title: 'Get Frame Burst',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { from, to, count, maxWidth } = args;
      const source = resolveVideoSource(args);
      const frameCount = count ?? 5;

      // Validate the range up front — malformed timestamps or a backwards range
      // are caller mistakes and THROW (matching analyze_moment and CLAUDE.md),
      // before the expensive download and before either strategy re-parses them
      // and throws a raw Error. Only the extraction outcome degrades.
      let fromSeconds: number;
      let toSeconds: number;
      try {
        fromSeconds = parseTimestamp(from);
        toSeconds = parseTimestamp(to);
      } catch {
        throw new UserError(
          `Invalid timestamp in "${from}"–"${to}" — use a form like "0:15", "1:23", "01:23:45".`,
        );
      }
      if (toSeconds <= fromSeconds) {
        throw new UserError(`"from" timestamp (${from}) must be before "to" timestamp (${to}).`);
      }

      await progress(0, `Starting burst extraction (${from} → ${to})...`);

      const extractFrom = async (url: string) => {
        const adapter = getAdapter(url);
        const tempDir = await createTempDir();
        const warnings: string[] = [];

        // Every exit shares one shape so the fallback runner — and the caller —
        // read a degraded attempt exactly like a successful one.
        const zeroFrames = (reason: string) => {
          warnings.push(reason);
          return { paths: [] as string[], warnings, tempDir };
        };

        // Strategy 1: Download video + ffmpeg burst extraction
        if (adapter.capabilities.videoDownload) {
          const videoPath = await adapter.downloadVideo(url, tempDir, (w) => warnings.push(w));

          if (videoPath) {
            await progress(40, 'Video downloaded, extracting burst frames...');

            // Wrap ONLY the extractor: it raises a raw ffmpeg Error (leaking the
            // command line) on an undecodable clip.
            let frames;
            try {
              frames = await extractFrameBurst(videoPath, tempDir, from, to, frameCount);
            } catch {
              return zeroFrames(
                `The video could not be decoded for this range — it may be corrupt, truncated, or in an unsupported format.`,
              );
            }

            if (frames.length === 0) {
              // ffmpeg ran but produced no files (e.g. the range is past the clip's end).
              return zeroFrames(`ffmpeg produced no frames between ${from} and ${to}.`);
            }

            await progress(70, `Extracted ${frames.length} frames, optimizing...`);
            // Degrade to the raw frames on a sharp/disk failure, but report it —
            // the analyze tools warn on the identical rejection, and a systemic
            // failure that only half the tools mention is worse than either rule.
            const optimized = await optimizeFramesKeepingOriginals(frames, tempDir, {
              maxWidth,
              onWarning: (w) => warnings.push(w),
            });

            return { paths: optimized.frames.map((f) => f.filePath), warnings, tempDir };
          }
        }

        // Strategy 2: Browser-based extraction (fallback) — not applicable to
        // local files (puppeteer.goto() can't load fs paths reliably).
        if (toLocalPath(url) !== null) {
          return zeroFrames(
            'Failed to extract frames from local video. Install ffmpeg or check that the file is a valid video.',
          );
        }

        await progress(30, 'Extracting frames via browser fallback...');
        const interval = (toSeconds - fromSeconds) / Math.max(frameCount - 1, 1);
        const timestamps = Array.from({ length: frameCount }, (_, i) =>
          Math.round(fromSeconds + i * interval),
        );

        const browserFrames = await extractBrowserFrames(url, tempDir, { timestamps }).catch(
          (e: unknown) => {
            warnings.push(`Browser extraction failed: ${e instanceof Error ? e.name : 'error'}`);
            return [];
          },
        );

        if (browserFrames.length > 0) {
          return { paths: browserFrames.map((f) => f.filePath), warnings, tempDir };
        }

        return zeroFrames(
          'Failed to extract frames. Install yt-dlp or Chrome/Chromium for frame extraction.',
        );
      };

      const outcome = await runWithLocalFallback(source, extractFrom, {
        remoteFailureIn: (result) => remoteFailureInWarnings(result.warnings),
        dispose: (result) => cleanupTempDir(result.tempDir),
      });
      const { paths, warnings } = outcome.value;
      if (outcome.warning) warnings.push(outcome.warning);

      // Uniform, parseable response: success and degraded (issue #26) paths emit
      // the same JSON text block, plus any image(s).
      const doc = (n: number) => ({
        type: 'text' as const,
        text: JSON.stringify({ frameCount: n, from, to, warnings }, null, 2),
      });

      if (paths.length > 0) await progress(100, 'Burst extraction complete');

      const content: ({ type: 'text'; text: string } | Awaited<ReturnType<typeof imageContent>>)[] =
        [doc(paths.length)];
      for (const path of paths) content.push(await imageContent({ path }));
      return { content };
    },
  });
}
