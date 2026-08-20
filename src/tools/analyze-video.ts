import type { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { AnalysisField } from '../utils/field-filter.js';
import { createProgressReporter } from '../utils/progress.js';
import {
  localFallbackPathParam,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
  videoUrlParam,
} from '../utils/source-fallback.js';
import {
  AnalyzeOptionsSchema,
  buildAnalysisContent,
  getAnalysis,
  resolveAnalyzeParams,
} from './analyze-core.js';

const AnalyzeVideoSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
  options: AnalyzeOptionsSchema.describe('Analysis options'),
});

export function registerAnalyzeVideo(server: FastMCP): void {
  server.addTool({
    name: 'analyze_video',
    description: `Analyze a video URL to extract transcript, key frames, metadata, comments, OCR text, and annotated timeline.

Returns structured data about the video content:
- Transcript with timestamps and speakers
- Key frames selected from over-sampled candidates and scored for sharpness, on-screen text and visual diversity (deduplicated, as images). Static clips with no scene cuts (e.g. talking-head Reels/Stories where only on-screen text changes) are covered by the uniform-sampling candidate source.
- OCR text extracted from frames (code, error messages, UI text, prices/dates/CTAs visible on screen)
- Annotated timeline merging transcript + frames + OCR into a unified chronological view
- Metadata (title, duration, platform)
- Comments from viewers (if available)

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Detail levels:
- "brief": metadata + truncated transcript only (fast, no video download)
- "standard": full analysis with scene-change frames (default)
- "detailed": dense sampling (1 frame/sec), more frames, full OCR

Use options.fields to request only specific data (e.g., ["metadata", "transcript"]).
Use options.forceRefresh to bypass the cache.
Use options.model / options.language / options.initialPrompt to override Whisper transcription per call (e.g. a heavier model + a domain glossary for hard audio) without restarting the server.

Frame selection:
- options.frameSelection "smart" (default) over-samples candidate frames (relaxed scene cuts + uniform sampling), scores them on sharpness and on-screen-text density, and greedily keeps a visually diverse subset — so mid-transition blur is rejected, look-alikes far apart in time are not both kept, and passages that change gradually still produce frames.
- options.frameSelection "sceneChange" restores the legacy scene-detector-only behaviour (faster, no scoring).

Pass localFallbackPath alongside url to fall back to a local copy of the video when the remote source is blocked or unreachable (YouTube anti-bot, missing yt-dlp, network failure); the fallback and the original remote error are reported in warnings[].`,
    parameters: AnalyzeVideoSchema,
    annotations: {
      title: 'Analyze Video',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { options } = args;
      const source = resolveVideoSource(args);
      const params = resolveAnalyzeParams(options);
      const fields = options?.fields as AnalysisField[] | undefined;

      // Single-video path keeps the frame temp dir alive so a cache hit within
      // the TTL can still re-serve images; cleanup happens on process exit /
      // cache eviction. (The batch tool, which never inlines images, cleans up
      // per item.) A remote attempt that gets superseded by the local fallback
      // is the exception — its temp dir has no result left to serve, so
      // `dispose` reclaims it immediately.
      const outcome = await runWithLocalFallback(
        source,
        (input) => getAnalysis(input, params, progress),
        {
          remoteFailureIn: (handle) => remoteFailureInWarnings(handle.result.warnings),
          dispose: (handle) => handle.cleanup(),
        },
      );
      const { result } = outcome.value;

      return {
        content: await buildAnalysisContent(
          result,
          fields,
          outcome.warning ? [outcome.warning] : undefined,
        ),
      };
    },
  });
}
