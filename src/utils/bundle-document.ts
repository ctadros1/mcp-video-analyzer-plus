import { extname } from 'node:path';
import type { IAnalysisResult, IFrameResult } from '../types.js';
import { safeFileName } from './zip.js';

/** The archive's frames folder — see `writeVideoBundle` for the full layout. */
const FRAMES_DIR = 'frames';

/**
 * Name a frame inside the archive: ordinal first, timestamp second.
 *
 * The ordinal leads so a plain alphabetical listing — which is what every file
 * browser shows — is also chronological order; `10:05` sorts before `9:30` as a
 * string, so a timestamp-first name would shuffle the folder. The timestamp is
 * still in the name because it is the only thing that lets a reader map an
 * image back to a moment in the video, and `:` is illegal in a Windows filename
 * (the same trap `copyFrames` documents), so it becomes `-`.
 */
export function frameEntryName(frame: IFrameResult, index: number): string {
  const ordinal = String(index + 1).padStart(3, '0');
  const stamp = safeFileName(frame.time, 'unknown');
  const extension = extname(frame.filePath) || '.jpg';
  return `${FRAMES_DIR}/${ordinal}_${stamp}${extension}`;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Render the analysis as a standalone Markdown document.
 *
 * Written to be readable on its own, away from the agent that produced it: the
 * header carries enough provenance to identify which video this was, and the
 * transcript keeps its timestamps so a line can be found again in the source.
 *
 * An empty transcript still produces a document, and says WHY it is empty using
 * the pipeline's own warnings. A silent clip is content, not a failure — the
 * project's rule — and a bundle whose `transcript.md` was simply absent would
 * read as a broken export instead.
 */
export function buildTranscriptMarkdown(result: IAnalysisResult): string {
  const { metadata, transcript, frames, warnings } = result;
  const lines: string[] = [];

  lines.push(`# ${metadata.title || 'Untitled video'}`, '');

  const facts: [string, string | undefined][] = [
    ['Source', metadata.url],
    ['Platform', metadata.platform],
    ['Duration', metadata.durationFormatted],
    ['Uploader', metadata.uploader],
    [
      'Resolution',
      metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : undefined,
    ],
    ['Key frames', frames.length > 0 ? `${frames.length} (in \`${FRAMES_DIR}/\`)` : '0'],
  ];
  for (const [label, value] of facts) {
    if (value) lines.push(`- **${label}:** ${escapeTableCell(String(value))}`);
  }
  lines.push('');

  lines.push('## Transcript', '');
  if (transcript.length === 0) {
    lines.push('_No transcript available for this video._', '');
    const reasons = warnings.filter((warning) => /transcript|audio|whisper|silent/i.test(warning));
    for (const reason of reasons) lines.push(`> ${reason}`, '');
  } else {
    for (const entry of transcript) {
      const speaker = entry.speaker ? `**${entry.speaker}:** ` : '';
      lines.push(`**[${entry.time}]** ${speaker}${entry.text.trim()}`, '');
    }
  }

  if (result.ocrResults.length > 0) {
    lines.push('## On-screen text', '');
    for (const entry of result.ocrResults) {
      const text = entry.text.trim().replace(/\n{2,}/g, '\n');
      if (text) lines.push(`**[${entry.time}]**`, '', '```', text, '```', '');
    }
  }

  if (warnings.length > 0) {
    lines.push('## Notes', '');
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Base filename for the archive, derived from the video's title and falling
 * back to its platform when the title is missing or sanitizes to nothing.
 */
export function bundleFileName(result: IAnalysisResult): string {
  return safeFileName(result.metadata.title, `${result.metadata.platform}-video`);
}
