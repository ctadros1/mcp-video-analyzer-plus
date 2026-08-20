import { describe, expect, it } from 'vitest';
import type { IAnalysisResult } from '../types.js';
import { buildTranscriptMarkdown, bundleFileName, frameEntryName } from './bundle-document.js';

function analysis(overrides: Partial<IAnalysisResult> = {}): IAnalysisResult {
  return {
    metadata: {
      platform: 'ytdlp',
      title: 'Deploy walkthrough',
      duration: 125,
      durationFormatted: '2:05',
      url: 'https://www.youtube.com/watch?v=abc123',
      uploader: 'Example Channel',
      width: 1920,
      height: 1080,
    },
    transcript: [
      { time: '0:00', text: 'Welcome back.' },
      { time: '0:07', speaker: 'Ana', text: 'Here is the deploy step.' },
    ],
    frames: [
      { time: '0:04', filePath: '/tmp/x/opt_scene_001.jpg', mimeType: 'image/jpeg' },
      { time: '1:02:03', filePath: '/tmp/x/opt_scene_002.jpg', mimeType: 'image/jpeg' },
    ],
    comments: [],
    chapters: [],
    ocrResults: [],
    timeline: [],
    warnings: [],
    ...overrides,
  };
}

describe('frameEntryName', () => {
  it('puts the ordinal first so the folder lists chronologically', () => {
    // Timestamp-first would sort "10:05" before "9:30" as a string and shuffle
    // the folder — the ordinal is what keeps a plain file listing in order.
    const names = ['9:30', '10:05'].map((time, i) =>
      frameEntryName({ time, filePath: '/tmp/f.jpg', mimeType: 'image/jpeg' }, i),
    );
    expect([...names].sort()).toEqual(names);
  });

  it('keeps the timestamp in the name without characters Windows rejects', () => {
    const name = frameEntryName(analysis().frames[1], 1);
    expect(name).toBe('frames/002_1-02-03.jpg');
    expect(name).not.toContain(':');
  });

  it('preserves the source extension', () => {
    const name = frameEntryName(
      { time: '0:01', filePath: '/tmp/frame.png', mimeType: 'image/png' },
      0,
    );
    expect(name).toBe('frames/001_0-01.png');
  });
});

describe('buildTranscriptMarkdown', () => {
  it('renders the header, the transcript, and speaker attribution', () => {
    const md = buildTranscriptMarkdown(analysis());

    expect(md).toMatch(/^# Deploy walkthrough\n/);
    expect(md).toContain('- **Source:** https://www.youtube.com/watch?v=abc123');
    expect(md).toContain('- **Duration:** 2:05');
    expect(md).toContain('- **Uploader:** Example Channel');
    expect(md).toContain('- **Resolution:** 1920x1080');
    expect(md).toContain('**[0:00]** Welcome back.');
    expect(md).toContain('**[0:07]** **Ana:** Here is the deploy step.');
    expect(md.endsWith('\n')).toBe(true);
  });

  /**
   * A silent clip is content, not a failure — the project's rule. The document
   * must still exist and must carry the reason, or the export reads as broken.
   */
  it('still produces a document for a silent video, and says why it is empty', () => {
    const md = buildTranscriptMarkdown(
      analysis({
        transcript: [],
        warnings: ['No audio track in this clip — nothing to transcribe.'],
      }),
    );

    expect(md).toContain('_No transcript available for this video._');
    expect(md).toContain('> No audio track in this clip — nothing to transcribe.');
  });

  it('includes on-screen text when OCR found any', () => {
    const md = buildTranscriptMarkdown(
      analysis({ ocrResults: [{ time: '0:04', text: 'npm run deploy', confidence: 91 }] }),
    );
    expect(md).toContain('## On-screen text');
    expect(md).toContain('npm run deploy');
  });

  it('omits the on-screen-text section entirely when OCR found nothing', () => {
    expect(buildTranscriptMarkdown(analysis())).not.toContain('## On-screen text');
  });

  it('carries the pipeline warnings into a notes section', () => {
    const md = buildTranscriptMarkdown(analysis({ warnings: ['Removed 2 black frames'] }));
    expect(md).toContain('## Notes');
    expect(md).toContain('- Removed 2 black frames');
  });

  it('survives a video with no title', () => {
    const result = analysis();
    result.metadata.title = '';
    expect(buildTranscriptMarkdown(result)).toMatch(/^# Untitled video\n/);
  });
});

describe('bundleFileName', () => {
  it('derives the archive name from the title', () => {
    expect(bundleFileName(analysis())).toBe('Deploy-walkthrough');
  });

  it('drops a video extension so the archive is not talk.mp4.zip', () => {
    const result = analysis();
    result.metadata.title = 'team-standup.mp4';
    expect(bundleFileName(result)).toBe('team-standup');
  });

  it('keeps an extension-like ending that is not a video container', () => {
    const result = analysis();
    result.metadata.title = 'Release notes v1.2';
    expect(bundleFileName(result)).toBe('Release-notes-v1.2');
  });

  it('falls back to the platform when the title is unusable', () => {
    const result = analysis();
    result.metadata.title = '///';
    expect(bundleFileName(result)).toBe('ytdlp-video');
  });
});
