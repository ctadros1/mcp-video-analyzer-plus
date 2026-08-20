import { UserError } from 'fastmcp';
import { z } from 'zod';
import { detectPlatform, isVideoSource } from './url-detector.js';
import { warningReason } from './warnings.js';

const SOURCE_DESCRIPTION =
  'Video source: Loom share link, platform video URL (YouTube, Vimeo, TikTok, Instagram, X, Twitch, Dailymotion, Facebook), direct .mp4/.webm/.mov URL, or absolute path to a local video file';

const SOURCE_MESSAGE =
  'Must be a supported video URL (Loom, YouTube, Vimeo, TikTok, Instagram, X/Twitter, Twitch, Dailymotion, Facebook), a direct .mp4/.webm/.mov URL, or an absolute path / file:// URI to a local video file';

/**
 * The `url` parameter, now optional.
 *
 * Optional rather than removed-or-required: every existing call passes it and
 * behaves exactly as before, while a call that has only a local copy of the
 * video can omit it. `localFallbackPath` covers the other half, and
 * {@link resolveVideoSource} rejects a call that supplies neither.
 */
export const videoUrlParam = z
  .string()
  .refine(isVideoSource, { message: SOURCE_MESSAGE })
  .optional()
  .describe(
    `${SOURCE_DESCRIPTION}. Optional only when localFallbackPath is provided — supply at least one of the two.`,
  );

/** True for an absolute path / `file://` URI naming a supported video file. */
export function isLocalVideoFile(input: string): boolean {
  return detectPlatform(input) === 'local';
}

export const localFallbackPathParam = z
  .string()
  .refine(isLocalVideoFile, {
    message:
      'Must be an absolute path or file:// URI to a local video file (.mp4, .webm, .mov, .mkv, …)',
  })
  .optional()
  .describe(
    'Absolute path to a local copy of the same video, used automatically if the remote source ' +
      'cannot be reached or downloaded (YouTube anti-bot blocks, missing yt-dlp, network errors). ' +
      'When the fallback is used it is reported in warnings[] along with the original remote error. ' +
      'Supply this alone to read the local file directly and skip the remote attempt entirely.',
  );

/** Which source a call should try, and what it may fall back to. */
export interface ResolvedVideoSource {
  /** The source to attempt first. */
  primary: string;
  /** Local file to retry against, or null when there is nothing to fall back to. */
  fallback: string | null;
}

/**
 * Decide what a call will read, from the `url` / `localFallbackPath` pair.
 *
 * With only `localFallbackPath` there is no remote attempt to make, so the local
 * file becomes the primary source and the result is indistinguishable from
 * passing that path as `url` — which is what the local-file support already did
 * before this parameter existed.
 *
 * Throws (rather than degrading) on a call that names no source at all: that is
 * caller input, and the project's rule is that input validation throws a
 * `UserError` while only outcomes degrade into `warnings[]`.
 */
export function resolveVideoSource(args: {
  url?: string;
  localFallbackPath?: string;
}): ResolvedVideoSource {
  const { url, localFallbackPath } = args;

  if (localFallbackPath !== undefined && !isLocalVideoFile(localFallbackPath)) {
    throw new UserError(
      `localFallbackPath must be an absolute path or file:// URI to a local video file: "${localFallbackPath}"`,
    );
  }

  if (url) return { primary: url, fallback: localFallbackPath ?? null };
  if (localFallbackPath) return { primary: localFallbackPath, fallback: null };

  throw new UserError('Provide "url", "localFallbackPath", or both — a video source is required.');
}

/**
 * Failures that mean "the remote source could not be delivered", and so justify
 * reading the local copy instead.
 *
 * Kept to concrete markers this codebase actually emits — `downloadViaYtDlp`'s
 * "Video download failed:", the yt-dlp install hint, the browser fallback's
 * message, the adapter fetch failures — plus the transport-level errors that
 * reach us verbatim from Node and yt-dlp. A vaguer rule (anything containing
 * "failed") would fire on outcomes a local file cannot fix.
 */
const REMOTE_FAILURE = [
  /\b(?:video )?download failed\b/i,
  /\bfailed to download\b/i,
  /\byt-dlp is not installed\b/i,
  /\bcookie source unusable\b/i,
  /\bframe extraction not available\b/i,
  /\bcould not extract any frames\b/i,
  /\bfailed to extract frames?\b/i,
  /\bbrowser (?:frame )?extraction failed\b/i,
  /\bfailed to fetch (?:[\w-]+ )?(?:metadata|transcript|video)\b/i,
  /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_NETWORK)\b/,
  /\bHTTP Error [45]\d\d\b/i,
  /\b(?:network error|timed out|request timeout)\b/i,
  /\bsign in to confirm\b/i,
  /\bunable to (?:download|extract|fetch)\b/i,
  /\bvideo unavailable\b/i,
];

/**
 * Failures that a local file cannot fix, checked first.
 *
 * A malformed timestamp or an unroutable URL is a mistake in the call, not an
 * unreachable remote — retrying it against the local copy would bury the real
 * error under a second, identical one.
 */
const NOT_A_REMOTE_FAILURE = [
  // Comments specifically, and BEFORE the transport patterns below, which would
  // otherwise catch the "HTTP Error 404" a comments fetch fails with. A local
  // file has no comments either, so this is not something the fallback can
  // improve — and retrying would throw away remote metadata that did arrive.
  /\bfailed to fetch (?:[\w-]+ )?comments\b/i,
  /\binvalid timestamp\b/i,
  /\bmust be (?:before|after)\b/i,
  /\bunsupported video source\b/i,
  /\bnot a local video path\b/i,
  /\blocalFallbackPath must be\b/i,
  /\ba video source is required\b/i,
];

/** True when `message` describes a remote source that could not be delivered. */
export function isRemoteFailureMessage(message: string): boolean {
  if (NOT_A_REMOTE_FAILURE.some((p) => p.test(message))) return false;
  return REMOTE_FAILURE.some((p) => p.test(message));
}

/** True when a thrown error means the remote source could not be delivered. */
export function isRemoteFailure(error: unknown): boolean {
  return isRemoteFailureMessage(warningReason(error));
}

/**
 * The first warning that reports an unreachable remote source, or null.
 *
 * Most of this pipeline never throws on a failed download — it degrades and
 * says why in `warnings[]` — so a fallback that only watched for exceptions
 * would never fire on the case it exists for.
 */
export function remoteFailureInWarnings(warnings: readonly string[]): string | null {
  return warnings.find(isRemoteFailureMessage) ?? null;
}

export interface FallbackOutcome<T> {
  value: T;
  usedFallback: boolean;
  /** Warning to surface when the fallback served the result; null otherwise. */
  warning: string | null;
}

export interface FallbackOptions<T> {
  /**
   * Inspect a *successful* result for a remote failure it degraded around,
   * returning the reason (or null when the remote attempt genuinely worked).
   */
  remoteFailureIn?: (value: T) => string | null;
  /** Release resources held by the discarded remote result before retrying. */
  dispose?: (value: T) => Promise<void>;
}

/**
 * Run `attempt` against the resolved source, retrying on the local file when
 * the remote source could not be delivered.
 *
 * The retry is deliberately narrow. It fires only when there IS a local file to
 * fall back to and the failure is classified as remote — so a corrupt video, a
 * bad timestamp or an empty transcript still surfaces as itself rather than
 * being silently re-run against a different file. When it does fire, the caller
 * gets a warning naming the original remote error, because a result quietly
 * served from a different source than the one requested is worse than a slow one.
 */
export async function runWithLocalFallback<T>(
  source: ResolvedVideoSource,
  attempt: (input: string) => Promise<T>,
  options: FallbackOptions<T> = {},
): Promise<FallbackOutcome<T>> {
  const { fallback } = source;

  let value: T;
  try {
    value = await attempt(source.primary);
  } catch (error: unknown) {
    if (!fallback || !isRemoteFailure(error)) throw error;
    return {
      value: await attempt(fallback),
      usedFallback: true,
      warning: fallbackWarning(warningReason(error)),
    };
  }

  const degraded = fallback ? (options.remoteFailureIn?.(value) ?? null) : null;
  if (!fallback || degraded === null) return { value, usedFallback: false, warning: null };

  await options.dispose?.(value).catch(() => undefined);
  return {
    value: await attempt(fallback),
    usedFallback: true,
    warning: fallbackWarning(degraded),
  };
}

function fallbackWarning(reason: string): string {
  return `Remote extraction failed (${reason}) — served this result from localFallbackPath instead.`;
}
