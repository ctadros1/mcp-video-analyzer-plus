import { dirname, isAbsolute } from 'node:path';
import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { createProgressReporter } from '../utils/progress.js';
import {
  localFallbackPathParam,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
  videoUrlParam,
} from '../utils/source-fallback.js';
import {
  BUNDLE_FRAME_DEFAULTS,
  BUNDLE_INCLUDE_OCR,
  revealCommand,
  writeVideoBundle,
} from '../utils/video-bundle.js';
import { warningReason } from '../utils/warnings.js';
import { AnalyzeOptionsSchema, getAnalysis, resolveAnalyzeParams } from './analyze-core.js';

const ExportVideoBundleSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
  outputPath: z
    .string()
    .optional()
    .describe(
      'Absolute path for the .zip to write (e.g. "/Users/you/Desktop/talk.zip"). A path to an ' +
        'existing directory puts the archive inside it under a name derived from the video title. ' +
        'Defaults to the per-user cache dir under mcp-video-analyzer/bundles/. Must be absolute — ' +
        "the server's working directory is not predictable from the client.",
    ),
  options: AnalyzeOptionsSchema.describe('Analysis options (same as analyze_video)'),
});

/**
 * Package one video's analysis as a `.zip` on disk.
 *
 * The archive, not the response, is the deliverable — an MCP server talks to
 * its client over stdio and cannot hand it a binary file, so the tool returns
 * the archive's path and a manifest of what went into it. Base64-ing a
 * multi-megabyte bundle into the response was the alternative; it would cost
 * more context than the analysis it packages and still leave the user without a
 * file on disk.
 *
 * Everything else is the ordinary pipeline: the same `getAnalysis` cache,
 * options and `localFallbackPath` behaviour the other tools have.
 */
export function registerExportVideoBundle(server: FastMCP): void {
  server.addTool({
    name: 'export_video_bundle',
    description: `Analyze a video and package the result as a .zip file on disk.

Use this when the user asks for the frames/transcript as FILES — "export", "download", "save", "zip", "give me the images", "put it in a folder". For answering questions about a video, use analyze_video instead: it returns the frames inline where you can actually see them, which this tool does not.

Frames are written at the video's SOURCE resolution and near-lossless quality by default, because archived frames never enter the model's context — the 800px/quality-70 defaults that keep analyze_video's token cost down have no purpose here and cost the same time either way. Pass options.maxWidth or options.frameQuality to get a smaller archive.

OCR is OFF by default here, unlike analyze_video. The frames in an archive are full-resolution images a person opens and reads, so recognizing their text adds a section to transcript.md for the dominant share of the run time (~60s of an 80s run on an 8-minute 1080p video). Pass options.includeOcr: true if the user wants the on-screen-text section and the OCR-annotated timeline in the bundle.

Archive layout:
- frames/001_0-04.jpg, 002_0-11.jpg, … — the extracted key frames, named ordinal-first so the folder lists in chronological order, with the timestamp in each name
- transcript.md — the transcript with timestamps, plus a header identifying the video and any on-screen (OCR) text

Returns zipPath (absolute), folder, revealCommand, size and a manifest.

DELIVERING THE RESULT — the file is on disk and MCP cannot put a binary in a chat response, so:
- Always show the user zipPath, and give them revealCommand as a runnable command. It opens their file manager with the archive already selected, which matters because the default location is a cache directory nobody navigates to by hand.
- Do NOT tell the user you "can't move the file" or that you "lack filesystem access". You choose where it goes: pass outputPath. If they want it somewhere convenient, pass an absolute path such as their Desktop (e.g. "/Users/<name>/Desktop") or a directory, and it is written there directly. Ask where they want it if it is not obvious.

Accepts the same options as analyze_video (detail, maxFrames, maxWidth, frameSelection, …) and the same localFallbackPath fallback for blocked remote sources.

TIMING — a video with no existing transcript must be transcribed, and that is the slow part (roughly 3x faster than realtime on CPU: ~4 minutes for a 12-minute video). Frame extraction is about 10s. Call get_metadata first on an unfamiliar video and tell the user the expected wait before you start. While it runs the tool reports progress every 10 seconds with elapsed time — if those are arriving, it is healthy, so wait. If the call times out, do NOT retry with lighter options: the server finishes anyway and caches the transcript, so waiting and retrying once completes in seconds, while an immediate retry discards the run and starts over.`,
    parameters: ExportVideoBundleSchema,
    annotations: {
      title: 'Export Video Bundle (.zip)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { options, outputPath } = args;
      const source = resolveVideoSource(args);

      // Frames in an archive never enter the model's context, so the defaults
      // that exist to bound token cost are pure loss here: they were shrinking
      // a 1920px screen recording to 800px and re-encoding it at quality 70 for
      // a file nobody was going to read in a chat. Measured on a 1080p UI
      // capture, 45 frames: 800px/q70 encodes in 0.5s, source/q90 in 0.5s —
      // the downscale never bought time, only a smaller zip. An explicit
      // caller value still wins, for anyone who does want a small archive.
      const params = resolveAnalyzeParams({
        ...options,
        maxWidth: options?.maxWidth ?? BUNDLE_FRAME_DEFAULTS.maxWidth,
        frameQuality: options?.frameQuality ?? BUNDLE_FRAME_DEFAULTS.frameQuality,
        includeOcr: options?.includeOcr ?? BUNDLE_INCLUDE_OCR,
      });

      if (outputPath !== undefined && !isAbsolute(outputPath)) {
        throw new UserError(
          `outputPath must be an absolute path (got "${outputPath}") — the server's working directory is not predictable from the client.`,
        );
      }

      const outcome = await runWithLocalFallback(
        source,
        (input) => getAnalysis(input, params, progress),
        {
          remoteFailureIn: (handle) => remoteFailureInWarnings(handle.result.warnings),
          dispose: (handle) => handle.cleanup(),
        },
      );

      const handle = outcome.value;
      const { result } = handle;
      const warnings = [...result.warnings];
      if (outcome.warning) warnings.push(outcome.warning);

      try {
        await progress(97, 'Writing the archive...');
        const archive = await writeVideoBundle(result, outputPath).catch((e: unknown) => {
          throw new UserError(`Could not write the bundle archive: ${warningReason(e)}`);
        });
        await progress(100, 'Bundle written');

        if (archive.missingFrames > 0) {
          warnings.push(
            `${archive.missingFrames} of ${result.frames.length} frame image(s) were unavailable (likely cleaned up after caching) — re-run with options.forceRefresh to regenerate them.`,
          );
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  zipPath: archive.path,
                  folder: dirname(archive.path),
                  revealCommand: revealCommand(archive.path),
                  bytes: archive.bytes,
                  frameCount: archive.names.length - 1,
                  transcriptEntries: result.transcript.length,
                  contents: archive.names,
                  warnings,
                },
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        // The archive owns the bytes now, so the per-call temp dir holding the
        // frame JPEGs has nothing left to serve. analyze_video deliberately
        // keeps its temp dir alive so a cache hit can re-inline the images;
        // this tool never inlines them, so holding it would only leak.
        await handle.cleanup();
      }
    },
  });
}
