import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import { getAdapter } from '../adapters/adapter.interface.js';
import { extractAudioTrack, transcribeAudio } from '../processors/audio-transcriber.js';
import { createProgressReporter } from '../utils/progress.js';
import {
  localFallbackPathParam,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
  videoUrlParam,
} from '../utils/source-fallback.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';
import { warningReason } from '../utils/warnings.js';

const GetTranscriptSchema = z.object({
  url: videoUrlParam,
  localFallbackPath: localFallbackPathParam,
  options: z
    .object({
      model: z
        .string()
        .optional()
        .describe(
          'Whisper model for the transcription fallback (overrides WHISPER_MODEL for this call), e.g. "small", "medium".',
        ),
      language: z
        .string()
        .optional()
        .describe('Forced transcription language code (overrides WHISPER_LANGUAGE), e.g. "pt".'),
      initialPrompt: z
        .string()
        .optional()
        .describe(
          'Domain glossary fed to Whisper as --initial_prompt (overrides WHISPER_PROMPT). Fixes proper nouns in the transcript.',
        ),
    })
    .optional()
    .describe('Transcription overrides (apply only to the Whisper fallback)'),
});

export function registerGetTranscript(server: FastMCP): void {
  server.addTool({
    name: 'get_transcript',
    description: `Extract only the transcript from a video URL.

Returns timestamped transcript entries with speaker identification (when available).
Faster than analyze_video when you only need the transcript.

If the platform has no native transcript, attempts Whisper fallback transcription
(requires @huggingface/transformers, whisper CLI, or OPENAI_API_KEY).

Supports: Loom (loom.com/share/...), YouTube/Vimeo/TikTok/Instagram/X/Twitch/Dailymotion/Facebook (requires yt-dlp; native captions preferred), direct video URLs (.mp4, .webm, .mov), and local video files (absolute path or file:// URI). For local files a sidecar .vtt/.srt next to the file is used first, then an embedded subtitle track, and only then the Whisper fallback if neither exists.

Pass localFallbackPath alongside url to fall back to a local copy of the video when the remote source is blocked or unreachable; the fallback is reported in warnings[].`,
    parameters: GetTranscriptSchema,
    annotations: {
      title: 'Get Transcript',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress }) => {
      const progress = createProgressReporter(reportProgress);
      const { options } = args;
      const source = resolveVideoSource(args);
      const transcribeOpts = {
        model: options?.model,
        language: options?.language,
        initialPrompt: options?.initialPrompt,
      };

      await progress(0, 'Fetching transcript...');

      const transcribeFrom = async (input: string) => {
        let adapter;
        try {
          adapter = getAdapter(input);
        } catch (error) {
          if (error instanceof UserError) throw error;
          throw new UserError(`Failed to detect video platform for URL: ${input}`);
        }

        const warnings: string[] = [];

        // Try native transcript first
        let transcript = await adapter.getTranscript(input).catch((e: unknown) => {
          warnings.push(`Failed to fetch native transcript: ${warningReason(e)}`);
          return [];
        });

        await progress(40, 'Native transcript fetched');

        // Whisper fallback if no native transcript.
        if (transcript.length === 0 && adapter.capabilities.videoDownload) {
          // Skip the fallback if the source advertises no audio track —
          // a metadata probe is cheap; transcription is not.
          const hasAudio = await adapter
            .getMetadata(input)
            .then((m) => m.hasAudio)
            .catch(() => undefined);

          if (hasAudio === false) {
            warnings.push(
              'No audio track detected by the probe — skipped Whisper transcription. If the video does have audio, the probe may not have recognized the stream.',
            );
          } else {
            let tempDir: string | null = null;
            try {
              await progress(45, 'No native transcript, downloading video for Whisper...');
              tempDir = await createTempDir();
              const videoPath = await adapter.downloadVideo(input, tempDir, (w) =>
                warnings.push(w),
              );
              if (videoPath) {
                await progress(65, 'Transcribing audio with Whisper...');
                const audioPath = await extractAudioTrack(videoPath, tempDir);
                transcript = await transcribeAudio(audioPath, transcribeOpts, (w) =>
                  warnings.push(w),
                );
                if (transcript.length > 0) {
                  warnings.push(
                    'Transcript generated via Whisper fallback (no native transcript available).',
                  );
                }
              }
            } catch (e: unknown) {
              // Not critical — but silence here meant a caller with no transcript
              // and no idea why. Say it, translated like every other emitter.
              warnings.push(warningReason(e));
            } finally {
              if (tempDir) await cleanupTempDir(tempDir).catch(() => undefined);
            }
          }
        }

        return { transcript, warnings };
      };

      const outcome = await runWithLocalFallback(source, transcribeFrom, {
        remoteFailureIn: (result) => remoteFailureInWarnings(result.warnings),
      });
      const { transcript, warnings } = outcome.value;
      if (outcome.warning) warnings.push(outcome.warning);

      if (transcript.length === 0) {
        warnings.push('No transcript available for this video.');
      }

      await progress(100, 'Transcript complete');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ transcript, warnings }, null, 2),
          },
        ],
      };
    },
  });
}
