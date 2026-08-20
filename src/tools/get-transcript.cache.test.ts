import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureToolExecute, noProgress } from '../../test/helpers/index.js';
import { clearAdapters, registerAdapter } from '../adapters/adapter.interface.js';
import { LocalFileAdapter } from '../adapters/local-file.adapter.js';
import { cleanupTempDir, createTempDir } from '../utils/temp-files.js';

/**
 * Transcription is the only step in this pipeline measured in minutes, and it
 * is what exceeds an MCP client's timeout on a long video. The cache is what
 * makes the documented recovery work — run get_transcript first to absorb the
 * slow part, then export, which reuses it. That only holds if BOTH tools share
 * the cache; for a while only the analysis pipeline did, so the transcript-only
 * call paid the cost and threw the result away.
 */
const state = vi.hoisted(() => ({ transcribeCalls: 0 }));

vi.mock('../processors/audio-transcriber.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    extractAudioTrack: async () => '/tmp/fake-audio.wav',
    transcribeAudio: async () => {
      state.transcribeCalls++;
      return [{ time: '0:00', text: 'the quick brown fox' }];
    },
  };
});

const { registerGetTranscript } = await import('./get-transcript.js');
const { readCachedTranscript } = await import('../utils/transcript-cache.js');

let dir: string;
let video: string;

beforeEach(async () => {
  state.transcribeCalls = 0;
  dir = await createTempDir();
  video = join(dir, 'talk.mp4');
  writeFileSync(video, 'stand-in bytes; only mtime and size are read');
  vi.stubEnv('MCP_CACHE_DIR', join(dir, 'cache'));
  clearAdapters();
  registerAdapter(new LocalFileAdapter());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  clearAdapters();
  await cleanupTempDir(dir);
});

async function getTranscript(): Promise<{ transcript: unknown[]; warnings: string[] }> {
  const result = await captureToolExecute(registerGetTranscript)({ url: video }, noProgress);
  return JSON.parse(result.content[0].text ?? '{}');
}

describe('get_transcript transcript cache', () => {
  it('stores the Whisper transcript it produced', async () => {
    const first = await getTranscript();

    expect(state.transcribeCalls).toBe(1);
    expect(first.transcript).toHaveLength(1);
    // Written under the shared key, so analyze_video and export_video_bundle
    // find it too — the whole point of doing the slow call first.
    expect(await readCachedTranscript(video, {})).toHaveLength(1);
  });

  it('reuses it instead of transcribing again', async () => {
    await getTranscript();
    const second = await getTranscript();

    expect(state.transcribeCalls).toBe(1);
    expect(second.transcript).toHaveLength(1);
    expect(second.warnings.some((w) => w.includes('reused from a previous Whisper run'))).toBe(
      true,
    );
  });

  it('transcribes again when the video changes', async () => {
    await getTranscript();
    writeFileSync(video, 'different bytes entirely, so a different size and mtime');

    await getTranscript();
    expect(state.transcribeCalls).toBe(2);
  });
});
