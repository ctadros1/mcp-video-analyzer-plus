import { describe, expect, it, vi } from 'vitest';
import {
  approximateDuration,
  estimateTranscriptionSeconds,
} from '../processors/audio-transcriber.js';
import { withProgressHeartbeat } from './progress.js';

describe('estimateTranscriptionSeconds', () => {
  it('scales with the length of the audio', () => {
    expect(estimateTranscriptionSeconds(720)).toBeGreaterThan(estimateTranscriptionSeconds(300));
  });

  /**
   * Calibrated against a measured run: 391s of audio transcribed in ~112s.
   * The estimate must not come in UNDER what was actually observed — a caller
   * acts on it by deciding whether to keep waiting, so running short is the
   * harmful direction.
   */
  it('is not optimistic against the measured baseline', () => {
    expect(estimateTranscriptionSeconds(391)).toBeGreaterThanOrEqual(112);
  });

  it('never promises an instant result for a very short clip', () => {
    expect(estimateTranscriptionSeconds(1)).toBeGreaterThanOrEqual(15);
    expect(estimateTranscriptionSeconds(0)).toBeGreaterThanOrEqual(15);
  });
});

describe('approximateDuration', () => {
  it('reads as an approximation, not a precise figure', () => {
    expect(approximateDuration(42)).toBe('40s');
    expect(approximateDuration(250)).toBe('4 min');
    expect(approximateDuration(3600)).toBe('60 min');
  });
});

describe('withProgressHeartbeat', () => {
  it('reports repeatedly while the work is still running', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const progress = async (_p: number, message?: string) => {
        if (message) seen.push(message);
      };

      let finish: () => void = () => undefined;
      const work = new Promise<string>((resolve) => {
        finish = () => resolve('done');
      });

      const running = withProgressHeartbeat(
        progress,
        96,
        (s) => `elapsed ${s}s`,
        () => work,
      );

      await vi.advanceTimersByTimeAsync(35_000);
      // The client resets its request timeout on each notification; without
      // these a multi-minute step looks indistinguishable from a hang.
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen[0]).toMatch(/elapsed \d+s/);

      finish();
      expect(await running).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reporting once the work finishes', async () => {
    vi.useFakeTimers();
    try {
      let count = 0;
      const progress = async () => {
        count++;
      };

      await withProgressHeartbeat(
        progress,
        96,
        () => 'x',
        async () => 'quick',
      );
      const afterWork = count;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(count).toBe(afterWork);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reporting when the work throws, and propagates the error', async () => {
    vi.useFakeTimers();
    try {
      let count = 0;
      const progress = async () => {
        count++;
      };

      await expect(
        withProgressHeartbeat(
          progress,
          96,
          () => 'x',
          async () => {
            throw new Error('whisper died');
          },
        ),
      ).rejects.toThrow('whisper died');

      const afterWork = count;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(count).toBe(afterWork);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a failed notification take down the work it reports on', async () => {
    vi.useFakeTimers();
    try {
      const progress = async () => {
        throw new Error('client went away');
      };

      let finish: () => void = () => undefined;
      const work = new Promise<string>((resolve) => {
        finish = () => resolve('survived');
      });

      const running = withProgressHeartbeat(
        progress,
        96,
        () => 'x',
        () => work,
      );
      await vi.advanceTimersByTimeAsync(25_000);
      finish();

      expect(await running).toBe('survived');
    } finally {
      vi.useRealTimers();
    }
  });
});
