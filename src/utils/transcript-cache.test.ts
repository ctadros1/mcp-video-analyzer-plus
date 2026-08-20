import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITranscriptEntry } from '../types.js';
import { cleanupTempDir, createTempDir } from './temp-files.js';
import { readCachedTranscript, writeCachedTranscript } from './transcript-cache.js';

const ENTRIES: ITranscriptEntry[] = [
  { time: '0:00', text: 'Five mistakes that scream you vibe coded it.' },
  { time: '0:07', speaker: 'Kole', text: 'Number one: inconsistent spacing.' },
];

let dir: string;
let video: string;

beforeEach(async () => {
  dir = await createTempDir();
  video = join(dir, 'talk.mp4');
  writeFileSync(video, 'not really a video, but it has an mtime and a size');
  // Keep the cache out of the real per-user directory.
  vi.stubEnv('MCP_CACHE_DIR', join(dir, 'cache'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTempDir(dir);
});

describe('transcript cache', () => {
  it('round-trips a transcript for the same file and options', async () => {
    expect(await readCachedTranscript(video, {})).toBeNull();
    await writeCachedTranscript(video, {}, ENTRIES);
    expect(await readCachedTranscript(video, {})).toEqual(ENTRIES);
  });

  /**
   * The invalidation that matters: a cache keyed on path alone would serve the
   * transcript of whatever file used to have that name.
   */
  it('invalidates when the video is edited or replaced', async () => {
    await writeCachedTranscript(video, {}, ENTRIES);
    expect(await readCachedTranscript(video, {})).toEqual(ENTRIES);

    writeFileSync(video, 'a different video entirely, of a different size');
    expect(await readCachedTranscript(video, {})).toBeNull();
  });

  it('invalidates when only the mtime changes', async () => {
    await writeCachedTranscript(video, {}, ENTRIES);
    const later = new Date(Date.now() + 60_000);
    utimesSync(video, later, later);
    expect(await readCachedTranscript(video, {})).toBeNull();
  });

  it('keys on the transcription options, not just the file', async () => {
    await writeCachedTranscript(video, { model: 'small' }, ENTRIES);

    expect(await readCachedTranscript(video, { model: 'small' })).toEqual(ENTRIES);
    // A different model or forced language is a different transcript.
    expect(await readCachedTranscript(video, { model: 'medium' })).toBeNull();
    expect(await readCachedTranscript(video, { model: 'small', language: 'pt' })).toBeNull();
    expect(await readCachedTranscript(video, {})).toBeNull();
  });

  it('keys on the env-configured backend, so changing it invalidates', async () => {
    await writeCachedTranscript(video, {}, ENTRIES);
    expect(await readCachedTranscript(video, {})).toEqual(ENTRIES);

    vi.stubEnv('WHISPER_MODEL', 'medium');
    expect(await readCachedTranscript(video, {})).toBeNull();
  });

  /**
   * Remote sources have no local stamp to invalidate against — the content
   * behind a URL can change with nothing to detect it — and their transcripts
   * usually come from native captions, which are cheap to refetch.
   */
  it('does not cache remote sources', async () => {
    const url = 'https://www.youtube.com/watch?v=abc123';
    await writeCachedTranscript(url, {}, ENTRIES);
    expect(await readCachedTranscript(url, {})).toBeNull();
  });

  it('stores nothing for an empty transcript', async () => {
    await writeCachedTranscript(video, {}, []);
    expect(await readCachedTranscript(video, {})).toBeNull();
  });

  it('reports a miss rather than throwing when the video is gone', async () => {
    await writeCachedTranscript(join(dir, 'never-existed.mp4'), {}, ENTRIES);
    expect(await readCachedTranscript(join(dir, 'never-existed.mp4'), {})).toBeNull();
  });

  it('is a slow next run, never a failed one, when the cache cannot be written', async () => {
    // An unwritable cache root must degrade silently — it is an optimization.
    vi.stubEnv('MCP_CACHE_DIR', '/dev/null/not-a-directory');
    await expect(writeCachedTranscript(video, {}, ENTRIES)).resolves.toBeUndefined();
    await expect(readCachedTranscript(video, {})).resolves.toBeNull();
  });
});
