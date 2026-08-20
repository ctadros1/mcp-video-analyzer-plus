import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { createProgressReporter } from '../utils/progress.js';
import {
  localFallbackPathParam,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
  videoUrlParam,
} from '../utils/source-fallback.js';
import { warningReason } from '../utils/warnings.js';

const GetMetadataSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
});

export function registerGetMetadata(server: FastMCP): void {
  server.addTool({
    name: 'get_metadata',
    description: `Get video metadata, comments, chapters, and AI summary from a video URL.

Returns structured metadata without downloading the video or extracting frames.
Faster than analyze_video when you only need metadata.

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI).

Pass localFallbackPath alongside url to fall back to a local copy of the video when the remote source is blocked or unreachable; the fallback is reported in warnings[].`,
    parameters: GetMetadataSchema,
    annotations: {
      title: 'Get Metadata',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const source = resolveVideoSource(args);

      await progress(0, 'Fetching video metadata...');

      const fetchFrom = async (input: string) => {
        let adapter;
        try {
          adapter = getAdapter(input);
        } catch (error) {
          if (error instanceof UserError) throw error;
          throw new UserError(`Failed to detect video platform for URL: ${input}`);
        }

        const warnings: string[] = [];

        const [metadata, comments, chapters, aiSummary] = await Promise.all([
          adapter.getMetadata(input).catch((e: unknown) => {
            warnings.push(`Failed to fetch metadata: ${warningReason(e)}`);
            return {
              platform: adapter.name,
              title: 'Unknown',
              duration: 0,
              durationFormatted: '0:00',
              url: input,
            };
          }),
          adapter.getComments(input).catch((e: unknown) => {
            warnings.push(`Failed to fetch comments: ${warningReason(e)}`);
            return [];
          }),
          adapter.getChapters(input).catch(() => []),
          adapter.getAiSummary(input).catch((e: unknown) => {
            warnings.push(`Failed to fetch AI summary: ${warningReason(e)}`);
            return null;
          }),
        ]);

        return { metadata, comments, chapters, aiSummary, warnings };
      };

      const outcome = await runWithLocalFallback(source, fetchFrom, {
        remoteFailureIn: (result) => remoteFailureInWarnings(result.warnings),
      });
      const { metadata, comments, chapters, aiSummary, warnings } = outcome.value;
      if (outcome.warning) warnings.push(outcome.warning);

      await progress(100, 'Metadata fetched');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ metadata, comments, chapters, aiSummary, warnings }, null, 2),
          },
        ],
      };
    },
  });
}
