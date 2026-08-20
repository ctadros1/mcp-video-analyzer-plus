import { describe, expect, it } from 'vitest';
import { revealCommand } from './video-bundle.js';

describe('revealCommand', () => {
  const archive = '/Users/someone/Library/Caches/mcp-video-analyzer/bundles/My talk.zip';

  it('quotes the path so a space cannot split the command', () => {
    // The default location is a cache directory and titles routinely contain
    // spaces; an unquoted path would silently reveal the wrong thing.
    const command = revealCommand(archive);
    expect(command).toContain(`"${archive}"`);
  });

  it('names a real file-manager command for this platform', () => {
    expect(revealCommand(archive)).toMatch(/^(open -R|explorer \/select,|xdg-open)/);
  });

  it('escapes a quote in the path rather than ending the argument early', () => {
    expect(revealCommand('/tmp/we"ird.zip')).toContain('\\"');
  });
});
