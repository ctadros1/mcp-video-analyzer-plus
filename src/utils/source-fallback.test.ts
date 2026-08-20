import { UserError } from 'fastmcp';
import { describe, expect, it, vi } from 'vitest';
import {
  isLocalVideoFile,
  isRemoteFailure,
  isRemoteFailureMessage,
  remoteFailureInWarnings,
  resolveVideoSource,
  runWithLocalFallback,
} from './source-fallback.js';

const LOCAL = '/videos/demo.mp4';
const URL = 'https://www.youtube.com/watch?v=abc123';

describe('isLocalVideoFile', () => {
  it('accepts an absolute path to a supported container', () => {
    expect(isLocalVideoFile(LOCAL)).toBe(true);
    expect(isLocalVideoFile('/videos/demo.mkv')).toBe(true);
  });

  it('accepts a file:// URI', () => {
    expect(isLocalVideoFile('file:///videos/demo.mp4')).toBe(true);
  });

  it('rejects a relative path — the server cwd is unpredictable from the client', () => {
    expect(isLocalVideoFile('demo.mp4')).toBe(false);
    expect(isLocalVideoFile('./demo.mp4')).toBe(false);
  });

  it('rejects a remote URL and a non-video file', () => {
    expect(isLocalVideoFile(URL)).toBe(false);
    expect(isLocalVideoFile('/videos/notes.txt')).toBe(false);
  });
});

describe('resolveVideoSource', () => {
  it('tries the url first and keeps the local file in reserve when both are given', () => {
    expect(resolveVideoSource({ url: URL, localFallbackPath: LOCAL })).toEqual({
      primary: URL,
      fallback: LOCAL,
    });
  });

  it('has nothing to fall back to when only a url is given', () => {
    expect(resolveVideoSource({ url: URL })).toEqual({ primary: URL, fallback: null });
  });

  /**
   * The "identical to today's local-file support" clause: with no url there is
   * no remote attempt to make, so the local file IS the primary source and no
   * fallback machinery runs.
   */
  it('reads the local file directly when only localFallbackPath is given', () => {
    expect(resolveVideoSource({ localFallbackPath: LOCAL })).toEqual({
      primary: LOCAL,
      fallback: null,
    });
  });

  it('throws a UserError when neither is given', () => {
    expect(() => resolveVideoSource({})).toThrow(UserError);
    expect(() => resolveVideoSource({})).toThrow(/a video source is required/i);
  });

  it('throws a UserError for a localFallbackPath that is not a local video file', () => {
    expect(() => resolveVideoSource({ url: URL, localFallbackPath: 'demo.mp4' })).toThrow(
      /must be an absolute path/i,
    );
  });
});

describe('isRemoteFailureMessage', () => {
  it.each([
    'Video download failed: ERROR: [youtube] abc123: Sign in to confirm you are not a bot',
    'yt-dlp is not installed — install it ("pip install yt-dlp") to analyze YouTube URLs.',
    'Failed to fetch metadata: HTTP Error 403: Forbidden',
    'Failed to fetch native transcript: ETIMEDOUT',
    'Browser frame extraction failed: TimeoutError',
    'Could not extract any frames. Install yt-dlp or Chrome/Chromium for frame extraction.',
    'Frame extraction not available — returning transcript and metadata only.',
    'Failed to download video for moment analysis.',
    'Cookie source unusable (could not find edge cookies database)',
    'getaddrinfo ENOTFOUND www.youtube.com',
    'ERROR: [youtube] abc123: Video unavailable',
  ])('treats %s as a remote failure', (message) => {
    expect(isRemoteFailureMessage(message)).toBe(true);
  });

  /**
   * The other half of the contract, and the one that matters more: a mistake in
   * the CALL must never be retried against a different file. Doing so would
   * bury the real error under a second identical one.
   */
  it.each([
    'Invalid timestamp "banana" — use a form like "1:23", "0:05", or "01:23:45".',
    '"from" timestamp (0:30) must be before "to" timestamp (0:10).',
    'Unsupported video source: "gopher://nope". Supported: Loom ...',
    'localFallbackPath must be an absolute path or file:// URI to a local video file',
    'Provide "url", "localFallbackPath", or both — a video source is required.',
    'No transcript available for this video.',
    'No audio track in this clip — nothing to transcribe.',
    'Removed 3 near-duplicate frame(s) (12 → 9)',
    'Failed to fetch comments: HTTP Error 404',
    'Extracted frames were all filtered out as black/blank — the video may be DRM-protected.',
  ])('does not treat %s as a remote failure', (message) => {
    expect(isRemoteFailureMessage(message)).toBe(false);
  });

  it('reads the message off a thrown Error', () => {
    expect(isRemoteFailure(new Error('Video download failed: ERROR: Video unavailable'))).toBe(
      true,
    );
    expect(isRemoteFailure(new Error('Invalid timestamp "x"'))).toBe(false);
  });
});

describe('remoteFailureInWarnings', () => {
  it('returns the first warning that reports an unreachable remote source', () => {
    expect(
      remoteFailureInWarnings([
        'Removed 2 black/blank frame(s) — video may be DRM-protected',
        'Video download failed: ERROR: Sign in to confirm you are not a bot',
        'No transcript available for this video.',
      ]),
    ).toMatch(/Video download failed/);
  });

  it('returns null when nothing in the warnings blames the remote source', () => {
    expect(remoteFailureInWarnings(['No transcript available for this video.'])).toBeNull();
    expect(remoteFailureInWarnings([])).toBeNull();
  });
});

describe('runWithLocalFallback', () => {
  it('returns the remote result untouched when it succeeds', async () => {
    const attempt = vi.fn(async (input: string) => ({ from: input, warnings: [] as string[] }));

    const outcome = await runWithLocalFallback({ primary: URL, fallback: LOCAL }, attempt, {
      remoteFailureIn: (v) => remoteFailureInWarnings(v.warnings),
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome.value.from).toBe(URL);
    expect(outcome.usedFallback).toBe(false);
    expect(outcome.warning).toBeNull();
  });

  it('retries against the local file when the remote attempt throws a remote failure', async () => {
    const attempt = vi.fn(async (input: string) => {
      if (input === URL) throw new Error('Video download failed: ERROR: Video unavailable');
      return { from: input };
    });

    const outcome = await runWithLocalFallback({ primary: URL, fallback: LOCAL }, attempt);

    expect(attempt).toHaveBeenNthCalledWith(2, LOCAL);
    expect(outcome.value.from).toBe(LOCAL);
    expect(outcome.usedFallback).toBe(true);
    expect(outcome.warning).toMatch(/Remote extraction failed \(.*Video unavailable/);
    expect(outcome.warning).toMatch(/localFallbackPath/);
  });

  /**
   * The pipeline degrades rather than throwing on a failed download, so a
   * fallback that only watched for exceptions would never fire on the very
   * case it exists for.
   */
  it('retries when the remote attempt succeeds but degraded around a download failure', async () => {
    const disposed: string[] = [];
    const attempt = vi.fn(async (input: string) => ({
      from: input,
      warnings:
        input === URL ? ['Video download failed: ERROR: Sign in to confirm you are not a bot'] : [],
    }));

    const outcome = await runWithLocalFallback({ primary: URL, fallback: LOCAL }, attempt, {
      remoteFailureIn: (v) => remoteFailureInWarnings(v.warnings),
      dispose: async (v) => {
        disposed.push(v.from);
      },
    });

    expect(outcome.value.from).toBe(LOCAL);
    expect(outcome.usedFallback).toBe(true);
    expect(disposed).toEqual([URL]);
  });

  it('rethrows an error that a different file cannot fix, without retrying', async () => {
    const attempt = vi.fn(async () => {
      throw new UserError('Invalid timestamp "banana"');
    });

    await expect(runWithLocalFallback({ primary: URL, fallback: LOCAL }, attempt)).rejects.toThrow(
      /Invalid timestamp/,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rethrows a remote failure when there is no local file to fall back to', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('Video download failed: ERROR: Video unavailable');
    });

    await expect(runWithLocalFallback({ primary: URL, fallback: null }, attempt)).rejects.toThrow(
      /Video download failed/,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('leaves a degraded result alone when there is nothing to fall back to', async () => {
    const remoteFailureIn = vi.fn(() => 'Video download failed: ERROR: nope');
    const outcome = await runWithLocalFallback(
      { primary: URL, fallback: null },
      async (input) => ({ from: input }),
      { remoteFailureIn },
    );

    expect(outcome.usedFallback).toBe(false);
    expect(outcome.warning).toBeNull();
    // Not even consulted: with no fallback there is no decision to make.
    expect(remoteFailureIn).not.toHaveBeenCalled();
  });

  it('makes exactly one local attempt when the local file is the primary source', async () => {
    const attempt = vi.fn(async (input: string) => ({ from: input, warnings: ['whatever'] }));

    const outcome = await runWithLocalFallback(
      resolveVideoSource({ localFallbackPath: LOCAL }),
      attempt,
      { remoteFailureIn: () => 'Video download failed: ERROR: nope' },
    );

    expect(attempt).toHaveBeenCalledExactlyOnceWith(LOCAL);
    expect(outcome.usedFallback).toBe(false);
  });

  it('surfaces a failure of the fallback itself rather than the remote error', async () => {
    const attempt = vi.fn(async (input: string) => {
      if (input === URL) throw new Error('Video download failed: ERROR: Video unavailable');
      throw new UserError('Local video file not found: /videos/demo.mp4');
    });

    await expect(runWithLocalFallback({ primary: URL, fallback: LOCAL }, attempt)).rejects.toThrow(
      /Local video file not found/,
    );
  });

  it('does not let a dispose failure block the fallback', async () => {
    const attempt = vi.fn(async (input: string) => ({
      from: input,
      warnings: input === URL ? ['Video download failed: ERROR: nope'] : [],
    }));

    const outcome = await runWithLocalFallback({ primary: URL, fallback: LOCAL }, attempt, {
      remoteFailureIn: (v) => remoteFailureInWarnings(v.warnings),
      dispose: async () => {
        throw new Error('temp dir already gone');
      },
    });

    expect(outcome.value.from).toBe(LOCAL);
    expect(outcome.usedFallback).toBe(true);
  });
});
