import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IAnalysisResult } from '../types.js';
import { buildTranscriptMarkdown, bundleFileName, frameEntryName } from './bundle-document.js';
import { persistentCacheDir } from './temp-files.js';
import { writeZipArchive } from './zip.js';
import type { ZipEntry } from './zip.js';

/** The transcript document at the archive root. */
const TRANSCRIPT_FILE = 'transcript.md';

/**
 * Frame settings for an ARCHIVED bundle, as distinct from an inlined one.
 *
 * The 800px / quality-70 defaults elsewhere exist to bound how much of the
 * model's context a frame consumes. An archive is written to disk and read by a
 * person, so that cost does not exist — and it was never a speed trade either:
 * measured on a 1080p capture, 45 frames encode in 0.5s at 800px/q70 and 0.5s
 * at source/q90, because the expensive part is decoding the frame rather than
 * writing it. All the downscale bought was a smaller zip.
 *
 * Shared by the `export_video_bundle` tool and the CLI's `--zip`, because the
 * CLI shipped 800px archives for a release while only the tool had been raised.
 * An explicit caller value still wins in both.
 */
export const BUNDLE_FRAME_DEFAULTS = { maxWidth: 0, frameQuality: 90 } as const;

/**
 * Package an analysis as a `.zip`: the key frames under `frames/`, everything
 * that was said in `transcript.md`.
 *
 * ONE implementation, shared by the `export_video_bundle` MCP tool and the
 * CLI's `--zip`. The repo has already paid for the alternative once — issue #24
 * was a second, divergent copy of the yt-dlp download path — so the two entry
 * points call this rather than each assembling their own archive.
 *
 * Must be called BEFORE the analysis handle's `cleanup()`: the frame JPEGs live
 * in a per-call temp dir until then.
 */
export interface VideoBundle {
  path: string;
  bytes: number;
  /** Entry names written, in archive order. */
  names: string[];
  /** Frames whose image files were already gone (cache hits) and were skipped. */
  missingFrames: number;
}

/**
 * A shell command that reveals the archive in the OS file manager.
 *
 * An MCP server cannot hand a binary file to its client — the protocol carries
 * text, images, audio and resources, and a client will not turn an opaque
 * `application/zip` blob into a download, quite apart from what base64-ing a
 * multi-megabyte archive would do to the context. So the deliverable is a path,
 * and a path buried in a per-user cache directory is not somewhere anyone can
 * be expected to navigate to by hand. This closes that gap: one command the
 * user can run to open the folder with the file already selected.
 */
export function revealCommand(archivePath: string): string {
  const quoted = JSON.stringify(archivePath);
  if (process.platform === 'darwin') return `open -R ${quoted}`;
  if (process.platform === 'win32') return `explorer /select,${quoted}`;
  // No universal "select the file" on Linux; opening the containing folder is
  // the portable equivalent and every desktop environment handles it.
  return `xdg-open ${JSON.stringify(dirname(archivePath))}`;
}

export async function writeVideoBundle(
  result: IAnalysisResult,
  outputPath?: string,
): Promise<VideoBundle> {
  const target = await resolveArchivePath(outputPath, result);
  const { entries, missing } = frameEntries(result);
  entries.push({ name: TRANSCRIPT_FILE, data: buildTranscriptMarkdown(result) });

  const written = await writeArchiveAtomically(target, entries);
  return { ...written, missingFrames: missing };
}

/** Frame entries that still exist on disk, plus a count of those that don't. */
function frameEntries(result: IAnalysisResult): { entries: ZipEntry[]; missing: number } {
  const entries: ZipEntry[] = [];
  let missing = 0;

  result.frames.forEach((frame, index) => {
    // A cache or sidecar hit can carry frame records whose temp files were
    // already reclaimed. Skipping them keeps the archive honest; the caller is
    // told how many went missing rather than shipping a zip of empty entries.
    if (!existsSync(frame.filePath)) {
      missing++;
      return;
    }
    entries.push({ name: frameEntryName(frame, index), sourcePath: frame.filePath });
  });

  return { entries, missing };
}

/**
 * Where the archive goes: an explicit file path, inside an explicit directory,
 * or the per-user cache dir. Never a fixed name under `os.tmpdir()` — see
 * `persistentCacheDir`.
 */
async function resolveArchivePath(
  outputPath: string | undefined,
  result: IAnalysisResult,
): Promise<string> {
  const name = `${bundleFileName(result)}.zip`;

  if (outputPath === undefined) {
    const dir = persistentCacheDir('bundles');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return join(dir, name);
  }

  // A directory argument is the likely intent when one is given, and treating
  // it as a file would fail with an opaque EISDIR from the writer instead.
  const existing = await stat(outputPath).catch(() => null);
  if (existing?.isDirectory()) return join(outputPath, name);

  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  return outputPath.toLowerCase().endsWith('.zip') ? outputPath : `${outputPath}.zip`;
}

/**
 * Write to a sibling scratch file and rename into place.
 *
 * A rename is atomic, so a reader never observes a half-written archive and a
 * failure part-way through leaves any previous bundle intact instead of
 * replacing it with a truncated one. Writing straight to the destination would
 * turn every interrupted export into a corrupt `.zip`.
 */
async function writeArchiveAtomically(
  target: string,
  entries: ZipEntry[],
): Promise<{ path: string; bytes: number; names: string[] }> {
  const scratch = `${target}.${process.pid}.partial`;
  try {
    const written = await writeZipArchive(scratch, entries);
    await rename(scratch, target);
    return { path: target, bytes: written.bytes, names: written.names };
  } catch (error: unknown) {
    await rm(scratch, { force: true }).catch(() => undefined);
    throw error;
  }
}
