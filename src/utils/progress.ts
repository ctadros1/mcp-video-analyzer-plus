/**
 * Progress reporting utility with descriptive messages.
 *
 * The MCP spec supports an optional `message` field in progress notifications.
 * FastMCP's TypeScript type omits it, but the runtime passes it through via spread.
 */

type ReportProgressFn = (progress: { progress: number; total?: number }) => Promise<void>;

export function createProgressReporter(reportProgress: ReportProgressFn, total = 100) {
  return async (progress: number, message?: string): Promise<void> => {
    const payload: { progress: number; total: number; message?: string } = { progress, total };
    if (message) {
      payload.message = message;
    }
    await reportProgress(payload as { progress: number; total?: number });
  };
}

/** A reporter produced by {@link createProgressReporter}. */
export type ProgressFn = (progress: number, message?: string) => Promise<void>;

/** How often a long step reports that it is still alive. */
const HEARTBEAT_MS = 10_000;

/**
 * Run `work`, reporting progress on a timer for as long as it takes.
 *
 * Exists because of a real timeout. Transcription is a single multi-minute
 * await between two progress calls, so the client saw a jump from 95% straight
 * to silence — and the MCP spec has clients reset their request timeout when a
 * progress notification arrives, which means silence is exactly the thing that
 * kills a long call. The work was fine; nothing was saying so.
 *
 * The percentage deliberately does not advance. There is no honest way to know
 * how far through a Whisper run we are, and a fabricated bar that creeps toward
 * 99% is worse than an accurate elapsed count — it invites the caller to
 * predict a finish that is not knowable. The message carries elapsed time and
 * an estimate instead.
 */
export async function withProgressHeartbeat<T>(
  progress: ProgressFn,
  percent: number,
  message: (elapsedSeconds: number) => string,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const beat = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    // Fire and forget: a failed progress notification must never take down the
    // work it is reporting on.
    void progress(percent, message(elapsed)).catch(() => undefined);
  }, HEARTBEAT_MS);

  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}
