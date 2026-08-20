import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscribeOptions } from '../processors/audio-transcriber.js';
import type { ITranscriptEntry } from '../types.js';
import { persistentCacheDir } from './temp-files.js';
import { toLocalPath } from './url-detector.js';

/**
 * A persistent cache for Whisper transcripts of LOCAL video files.
 *
 * Transcription is the one step in this pipeline whose cost is measured in
 * minutes rather than seconds — on a 6.5-minute 1080p talk the frame work takes
 * 9s and Whisper takes several minutes on CPU. That is long enough to exceed an
 * MCP client's timeout, and when the client gives up the server keeps going and
 * finishes anyway. Without somewhere to put the answer, every retry pays the
 * full cost again and times out again: a loop with no exit.
 *
 * This is deliberately NOT the `MCP_WRITE_SIDECARS` mechanism. That one is
 * opt-in because it writes `<stem>.vtt` next to the user's video, which is a
 * visible change to their folder; this writes into the per-user cache directory
 * where nothing of theirs is touched, so it can be on by default. The two are
 * complementary — sidecars are for sharing results with other tools, this is
 * purely so a repeat call is cheap.
 *
 * Keyed on the file's `mtime:size` as well as its path, so editing or replacing
 * the video invalidates the entry rather than serving a transcript of the file
 * that used to be there. The transcription options are in the key too: a run at
 * a different model or forced language is a different transcript.
 */

/** Bumped when the stored shape changes, retiring older entries. */
const CACHE_VERSION = 1;

interface CachedTranscript {
  version: number;
  /** `mtime:size` of the source video when written — invalidates on edit. */
  stamp: string;
  entries: ITranscriptEntry[];
}

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/**
 * Cache file for a source, or null when it is not a local file.
 *
 * Remote sources are excluded on purpose: their content can change under the
 * same URL with nothing local to stamp against, so there is no safe
 * invalidation signal — and their transcripts usually come from native
 * captions, which are cheap to refetch anyway.
 */
function cacheFile(source: string, options: TranscribeOptions): string | null {
  const path = toLocalPath(source);
  if (path === null) return null;

  const key = createHash('sha256')
    .update(
      JSON.stringify({
        path,
        model: options.model ?? '',
        language: options.language ?? '',
        initialPrompt: options.initialPrompt ?? '',
        // The env-configured backend settings are part of the result too, so a
        // cached transcript must not survive the operator changing them.
        envModel: process.env.WHISPER_MODEL ?? '',
        envLanguage: process.env.WHISPER_LANGUAGE ?? '',
        envPrompt: process.env.WHISPER_PROMPT ?? '',
        envBin: process.env.WHISPER_BIN ?? '',
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return join(persistentCacheDir('transcripts'), `${key}.json`);
}

/** A previously cached transcript for this exact file and options, or null. */
export async function readCachedTranscript(
  source: string,
  options: TranscribeOptions,
): Promise<ITranscriptEntry[] | null> {
  const file = cacheFile(source, options);
  const path = toLocalPath(source);
  if (!file || !path) return null;

  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as CachedTranscript;
    if (parsed.version !== CACHE_VERSION) return null;
    if (parsed.stamp !== fileStamp(path)) return null;
    return Array.isArray(parsed.entries) && parsed.entries.length > 0 ? parsed.entries : null;
  } catch {
    return null;
  }
}

/**
 * Store a transcript for reuse. Best-effort: a cache that cannot be written is
 * a slow next run, never a failed one, so every error is swallowed.
 */
export async function writeCachedTranscript(
  source: string,
  options: TranscribeOptions,
  entries: ITranscriptEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const file = cacheFile(source, options);
  const path = toLocalPath(source);
  if (!file || !path) return;

  const stamp = fileStamp(path);
  if (!stamp) return;

  const payload: CachedTranscript = { version: CACHE_VERSION, stamp, entries };
  try {
    await mkdir(persistentCacheDir('transcripts'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  } catch {
    // Best-effort by design.
  }
}
