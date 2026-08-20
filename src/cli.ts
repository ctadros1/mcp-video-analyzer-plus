import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { registerAllAdapters } from './adapters/register.js';
import {
  AnalyzeOptionsSchema,
  assembleResultDoc,
  getAnalysis,
  resolveAnalyzeParams,
} from './tools/analyze-core.js';
import type { AnalyzeOptions, ProgressReporter } from './tools/analyze-core.js';
import type { IFrameResult } from './types.js';
import {
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
} from './utils/source-fallback.js';
import type { ResolvedVideoSource } from './utils/source-fallback.js';
import { persistentCacheDir } from './utils/temp-files.js';
import { isVideoSource } from './utils/url-detector.js';
import { BUNDLE_FRAME_DEFAULTS, writeVideoBundle } from './utils/video-bundle.js';
import { warningReason } from './utils/warnings.js';

const CLI_USAGE = `Usage: mcp-video-analyzer analyze <url-or-path> [options]

One-shot video analysis. Prints a single JSON document to stdout (progress and
errors go to stderr). Frame images are copied to --out and referenced by
absolute path in the JSON. Partial failures degrade into the "warnings" array
(exit 0); only a hard failure exits 1.

Options:
  --detail <level>        brief | standard | detailed (default: standard)
  --max-frames <n>        Max key frames to extract (1-60; default adapts to duration)
  --max-width <px>        Width cap for emitted frames (default: 800, or
                          MCP_FRAME_MAX_WIDTH). 0 keeps the source resolution —
                          use it for screen recordings whose meaning lives in
                          small text (terminals, dashboards, IDEs)
  --fields <list>         Output filter — comma-separated subset of: metadata,
                          transcript,frames,comments,chapters,ocrResults,
                          timeline,aiSummary. Filters the emitted JSON only;
                          use --detail brief to actually skip frame extraction.
  --force-refresh         Bypass cache and re-analyze
  --frame-selection <m>   smart | sceneChange (default: smart). "smart"
                          over-samples candidate frames, scores them on
                          sharpness and on-screen-text density, and keeps a
                          visually diverse subset; "sceneChange" is the legacy
                          scene-detector-only path
  --frame-candidates <n>  Candidates per requested frame in smart mode
                          (1-6, default: 3; capped at 90 candidates total)
  --frame-ocr-weight <w>  Share of the smart score carried by on-screen text,
                          the rest by sharpness (0-1, default: 0.4). Raise for
                          screen recordings, lower for b-roll
  --local-fallback <path> Local copy of the video, used automatically if the
                          remote source is blocked or unreachable. The fallback
                          and the original remote error are reported in
                          "warnings". Works with no positional URL too, which
                          is the same as passing the path directly
  --frame-quality <n>     JPEG quality of emitted frames, 1-100 (default: 70,
                          or MCP_FRAME_JPEG_QUALITY). Raise it for screen
                          recordings; re-encoding costs the same either way,
                          only the file size changes
  --ocr-language <codes>  Tesseract OCR languages (default: eng+por)
  --model <name>          Whisper model override (e.g. small, medium)
  --language <code>       Forced transcription language (e.g. pt)
  --zip <path>            Also package the result as a .zip at <path> (a
                          directory puts it inside under the video's title):
                          frames/ plus transcript.md. Written in addition to
                          --out, not instead of it
  --out <dir>             Where to copy frame images (default: the per-user
                          cache dir — %LOCALAPPDATA% / ~/Library/Caches /
                          $XDG_CACHE_HOME — under mcp-video-analyzer/<url-hash>;
                          override the root with MCP_CACHE_DIR). Frames there
                          persist until deleted; nothing reaps this location.
  -h, --help              Show this help

Sources: Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch,
Dailymotion, Facebook (yt-dlp required), direct .mp4/.webm/.mov URLs, and
local paths / file:// URIs.
`;

export interface CliInvocation {
  url: string | undefined;
  options: AnalyzeOptions;
  outDir: string | undefined;
  /** `--local-fallback`: local copy to use if the remote source fails. */
  localFallbackPath: string | undefined;
  /** `--zip`: also write a frames+transcript archive here. */
  zipPath: string | undefined;
  help: boolean;
}

/** Parse `analyze` argv. Throws on unknown flags (parseArgs) or invalid option values (zod). */
export function parseCliArgs(argv: string[]): CliInvocation {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      detail: { type: 'string' },
      'max-frames': { type: 'string' },
      'max-width': { type: 'string' },
      fields: { type: 'string' },
      'force-refresh': { type: 'boolean' },
      'frame-selection': { type: 'string' },
      'frame-candidates': { type: 'string' },
      'frame-ocr-weight': { type: 'string' },
      'frame-quality': { type: 'string' },
      'local-fallback': { type: 'string' },
      zip: { type: 'string' },
      'ocr-language': { type: 'string' },
      model: { type: 'string' },
      language: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const raw: Record<string, unknown> = {};
  if (values.detail !== undefined) raw.detail = values.detail;
  if (values['max-frames'] !== undefined) raw.maxFrames = Number(values['max-frames']);
  if (values['max-width'] !== undefined) raw.maxWidth = Number(values['max-width']);
  if (values.fields !== undefined) {
    raw.fields = values.fields
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  if (values['force-refresh']) raw.forceRefresh = true;
  if (values['frame-selection'] !== undefined) raw.frameSelection = values['frame-selection'];
  if (values['frame-candidates'] !== undefined) {
    raw.frameCandidateMultiplier = Number(values['frame-candidates']);
  }
  if (values['frame-ocr-weight'] !== undefined) {
    raw.frameOcrWeight = Number(values['frame-ocr-weight']);
  }
  if (values['frame-quality'] !== undefined) raw.frameQuality = Number(values['frame-quality']);
  if (values['ocr-language'] !== undefined) raw.ocrLanguage = values['ocr-language'];
  if (values.model !== undefined) raw.model = values.model;
  if (values.language !== undefined) raw.language = values.language;

  // Validation (enum/range) comes from the shared MCP tool schema.
  const options = AnalyzeOptionsSchema.parse(Object.keys(raw).length > 0 ? raw : undefined);

  return {
    url: positionals[0],
    options,
    outDir: values.out,
    localFallbackPath: values['local-fallback'],
    zipPath: values.zip,
    help: values.help ?? false,
  };
}

/** Stable per-source frames dir so repeat runs reuse the same folder. */
export function defaultOutDir(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return persistentCacheDir(hash);
}

/**
 * Copy frame images out of the per-call temp dir (about to be cleaned up) into
 * `outDir`, rewriting each `filePath`. Keeps the temp basenames — never derive
 * names from `time` values, which contain `:` (illegal on Windows).
 *
 * ENOENT on the source (frame already cleaned up after a cache hit) is the
 * benign case, counted in `missing`. Any other failure (EACCES/ENOSPC/EROFS on
 * the destination) is a real write problem — reported per-frame in `errors`
 * with the actual errno message, never disguised as a cache race.
 */
export async function copyFrames(
  frames: IFrameResult[],
  outDir: string,
): Promise<{ frames: IFrameResult[]; missing: number; errors: string[] }> {
  // 0700: the default out dir accumulates frames of every analyzed video and
  // nothing reaps it, so keep the pile unreadable to other local users. Applies
  // only to directories this call creates; a no-op on Windows.
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const copied: IFrameResult[] = [];
  let missing = 0;
  const errors: string[] = [];
  for (const frame of frames) {
    const dest = join(outDir, basename(frame.filePath));
    try {
      await copyFile(frame.filePath, dest);
      copied.push({ ...frame, filePath: dest });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        missing++;
      } else {
        // Reaches the public warnings[] via assembleResultDoc, so it owes the
        // same contract: one clean line, no absolute paths, no raw errno text.
        errors.push(`Frame copy failed for ${basename(dest)}: ${warningReason(err)}`);
      }
    }
  }
  return { frames: copied, missing, errors };
}

function formatError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => `Invalid option "${String(issue.path[0] ?? '')}": ${issue.message}`)
      .join('\n');
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * `mcp-video-analyzer analyze` entry point. stdout is reserved for the single
 * JSON result document — everything else (progress, errors) goes to stderr.
 */
export async function runCli(argv: string[]): Promise<number> {
  let invocation: CliInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n\n${CLI_USAGE}`);
    return 1;
  }

  if (invocation.help) {
    process.stdout.write(CLI_USAGE);
    return 0;
  }

  // A CLI runs from a known shell cwd, so resolve relative local paths before
  // the gate (the MCP server rejects them — its cwd is unpredictable).
  const absolutize = (value: string | undefined): string | undefined =>
    value && !isAbsolute(value) && !value.includes('://') && existsSync(value)
      ? resolve(value)
      : value;

  const url = absolutize(invocation.url);
  const localFallbackPath = absolutize(invocation.localFallbackPath);

  if (!url && !localFallbackPath) {
    process.stderr.write(
      'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or a path / file:// URI to a local video file\n',
    );
    return 1;
  }
  if (url && !isVideoSource(url)) {
    process.stderr.write(
      'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or a path / file:// URI to a local video file\n',
    );
    return 1;
  }

  let source: ResolvedVideoSource;
  try {
    source = resolveVideoSource({ url, localFallbackPath });
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`);
    return 1;
  }

  registerAllAdapters();

  const progress: ProgressReporter = async (percent, message) => {
    process.stderr.write(`[${Math.round(percent)}%] ${message ?? ''}\n`);
  };

  // `--zip` produces an archive, and archived frames are never inlined into a
  // model's context, so the token-cost defaults do not apply — the same
  // reasoning (and the same constants) as the export_video_bundle tool.
  const params = resolveAnalyzeParams(
    invocation.zipPath === undefined
      ? invocation.options
      : {
          ...invocation.options,
          maxWidth: invocation.options?.maxWidth ?? BUNDLE_FRAME_DEFAULTS.maxWidth,
          frameQuality: invocation.options?.frameQuality ?? BUNDLE_FRAME_DEFAULTS.frameQuality,
        },
  );

  let handle;
  let servedSource = source.primary;
  const fallbackWarnings: string[] = [];
  try {
    const outcome = await runWithLocalFallback(
      source,
      (input) => getAnalysis(input, params, progress),
      {
        remoteFailureIn: (analysis) => remoteFailureInWarnings(analysis.result.warnings),
        dispose: (analysis) => analysis.cleanup(),
      },
    );
    handle = outcome.value;
    if (outcome.usedFallback && source.fallback) servedSource = source.fallback;
    if (outcome.warning) fallbackWarnings.push(outcome.warning);
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`);
    return 1;
  }

  const { result } = handle;
  const fields = invocation.options?.fields;
  const wantFrames = !fields || fields.includes('frames');

  let frames: IFrameResult[] = [];
  let missing = 0;
  let zipPath: string | undefined;
  const copyWarnings: string[] = [];
  try {
    if (invocation.zipPath !== undefined) {
      // Before copyFrames and before cleanup(): the archive reads the frames
      // where the pipeline left them, which is the only window in which they
      // are guaranteed to exist.
      try {
        const archive = await writeVideoBundle(result, resolve(invocation.zipPath));
        zipPath = archive.path;
      } catch (err) {
        copyWarnings.push(`Bundle archive could not be written: ${warningReason(err)}`);
      }
    }

    if (wantFrames && result.frames.length > 0) {
      const copied = await copyFrames(
        result.frames,
        // Keyed on the source that actually SERVED the frames, so a run that
        // fell back to the local file writes beside the other runs of that
        // file rather than under the blocked URL's hash.
        invocation.outDir ?? defaultOutDir(servedSource),
      );
      frames = copied.frames;
      missing = copied.missing;
      copyWarnings.push(...copied.errors);
    }
  } catch (err) {
    // A failed mkdir/copy (bad --out, permissions) must not discard an
    // analysis that already succeeded — degrade into warnings[] and emit the
    // document without frame files (graceful-degradation convention).
    // The default out dir is now home-derived, so EACCES/EROFS/EDQUOT are
    // ordinary outcomes rather than only-if-you-passed-a-bad---out. Name the
    // way out, the way extractYtDlpError names the cookie env vars.
    copyWarnings.push(
      `Frame images could not be copied to the output dir: ${warningReason(err)}. ` +
        `Set --out or MCP_CACHE_DIR to a writable absolute path.`,
    );
  } finally {
    // Always reclaim the per-call temp dir, even when the copy failed.
    await handle.cleanup();
  }

  const doc = assembleResultDoc(result, fields, {
    missingFrames: missing,
    refreshHint: '--force-refresh',
    extraWarnings: [...fallbackWarnings, ...copyWarnings],
  });
  if (wantFrames) doc.frames = frames;
  if (zipPath) doc.zipPath = zipPath;

  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  return 0;
}
