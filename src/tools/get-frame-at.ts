import type { FastMCP } from 'fastmcp';
import { UserError, imageContent } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractBrowserFrames } from '../processors/browser-frame-extractor.js';
import { extractFrameAt, parseTimestamp } from '../processors/frame-extractor.js';
import { optimizeFrame } from '../processors/image-optimizer.js';
import { createProgressReporter } from '../utils/progress.js';
import {
  localFallbackPathParam,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
  videoUrlParam,
} from '../utils/source-fallback.js';
import { cleanupTempDir, createTempDir, getTempFilePath } from '../utils/temp-files.js';
import { toLocalPath } from '../utils/url-detector.js';
import { warningReason } from '../utils/warnings.js';
import { maxWidthParam } from './frame-options.js';

const GetFrameAtSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
  timestamp: z
    .string()
    .describe('Timestamp to extract frame at (e.g., "1:23", "0:05", "01:23:45")'),
  returnBase64: z
    .boolean()
    .default(false)
    .optional()
    .describe('Return frame as base64 inline instead of file path'),
  maxWidth: maxWidthParam,
});

export function registerGetFrameAt(server: FastMCP): void {
  server.addTool({
    name: 'get_frame_at',
    description: `Extract a single video frame at a specific timestamp.

Useful for inspecting what's on screen at a particular moment. The AI reads the transcript,
identifies a critical moment, and requests the exact frame at that timestamp.

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Args:
  - url: Video source (URL or local path)
  - timestamp: Time position (e.g., "1:23", "0:05", "01:23:45")
  - localFallbackPath: Optional local copy of the video, used automatically if the remote source is blocked or unreachable (reported in warnings[])

Returns: A single image of the video frame at the specified timestamp.`,
    parameters: GetFrameAtSchema,
    annotations: {
      title: 'Get Frame at Timestamp',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { timestamp, maxWidth } = args;
      const source = resolveVideoSource(args);

      // Validate the timestamp up front — an invalid timestamp is a caller
      // mistake, so it THROWS (matching analyze_moment and CLAUDE.md's rule),
      // and validating here means neither extraction strategy re-parses it and
      // throws a raw Error later. Only the extraction outcome degrades.
      let seconds: number;
      try {
        seconds = parseTimestamp(timestamp);
      } catch {
        throw new UserError(
          `Invalid timestamp "${timestamp}" — use a form like "1:23", "0:05", or "01:23:45".`,
        );
      }

      await progress(0, 'Starting frame extraction...');

      const extractFrom = async (url: string) => {
        const adapter = getAdapter(url);
        const tempDir = await createTempDir();
        const warnings: string[] = [];

        // Every exit shares one shape so the fallback runner — and the caller —
        // read a degraded attempt exactly like a successful one.
        const zeroFrame = (reason: string) => {
          warnings.push(reason);
          return { framePath: null as string | null, warnings, tempDir };
        };

        // Strategy 1: Download video + ffmpeg extraction
        if (adapter.capabilities.videoDownload) {
          const videoPath = await adapter.downloadVideo(url, tempDir, (w) => warnings.push(w));

          if (videoPath) {
            await progress(50, `Extracting frame at ${timestamp}...`);

            // Wrap ONLY the extractor: it raises a raw ffmpeg Error (leaking the
            // command line) on an undecodable clip. A fixed, path-free reason is
            // surfaced instead of that message.
            let frame;
            try {
              frame = await extractFrameAt(videoPath, tempDir, timestamp);
            } catch {
              return zeroFrame(
                `The video could not be decoded at ${timestamp} — it may be corrupt, truncated, or in an unsupported format.`,
              );
            }

            // An optimize failure must not discard a frame that WAS extracted —
            // fall back to the raw frame (matching get_frames).
            const optimizedPath = getTempFilePath(tempDir, `opt_frame_at.jpg`);
            const framePath = await optimizeFrame(frame.filePath, optimizedPath, { maxWidth })
              .then(() => optimizedPath)
              .catch((e: unknown) => {
                // Degraded but reported — a sharp/disk failure here means the
                // emitted frame ignores `maxWidth` and the caller should know.
                warnings.push(`Frame optimization failed: ${warningReason(e)}`);
                return frame.filePath;
              });

            return { framePath, warnings, tempDir };
          }
        }

        // Strategy 2: Browser-based extraction (fallback) — not applicable to
        // local files (puppeteer.goto() can't load fs paths reliably).
        if (toLocalPath(url) !== null) {
          return zeroFrame(
            'Failed to extract frame from local video. Install ffmpeg or check that the file is a valid video.',
          );
        }

        await progress(30, 'Extracting frame via browser fallback...');
        const browserFrames = await extractBrowserFrames(url, tempDir, {
          timestamps: [seconds],
        }).catch((e: unknown) => {
          warnings.push(`Browser extraction failed: ${e instanceof Error ? e.name : 'error'}`);
          return [];
        });

        if (browserFrames.length > 0) {
          return { framePath: browserFrames[0].filePath, warnings, tempDir };
        }

        return zeroFrame(
          'Failed to extract frame. Install yt-dlp or Chrome/Chromium for frame extraction.',
        );
      };

      const outcome = await runWithLocalFallback(source, extractFrom, {
        remoteFailureIn: (result) => remoteFailureInWarnings(result.warnings),
        dispose: (result) => cleanupTempDir(result.tempDir),
      });
      const { framePath, warnings } = outcome.value;
      if (outcome.warning) warnings.push(outcome.warning);

      // Uniform, parseable response: both the success and the degraded (issue
      // #26) paths emit the same JSON text block, plus any image(s).
      const doc = (frameCount: number) => ({
        type: 'text' as const,
        text: JSON.stringify({ frameCount, timestamp, warnings }, null, 2),
      });

      if (!framePath) return { content: [doc(0)] };

      await progress(100, 'Frame extracted');
      return { content: [doc(1), await imageContent({ path: framePath })] };
    },
  });
}
