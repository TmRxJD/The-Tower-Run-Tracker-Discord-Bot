import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePublishedUpdates, fetchPublishedUpdates } from './source';
import { buildUpdateMessages } from './messages';

const fixture = `<!-- markdownlint-disable -->
# **Minor Update v2.3.1**
**September 15, 2026**

New content with [relative link](/tools).

---
## Fixes
- One fix.
-----------------------------------------------------------------------------------------------------------------------
# **Major Tools Update**
- **Oct 31, 2025**

Older tools.
# **Major Tools Update**
- **Oct 31, 2025**

Older duplicate.
`;
afterEach(() => vi.unstubAllGlobals());
describe('published website Updates parser', () => {
  it('uses H1 releases, accepts legacy dates and deduplicates legacy copies', () => {
    const releases = parsePublishedUpdates(fixture.replace(/\n/g, '\r\n'));
    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({ title: 'Minor Update v2.3.1', date: '2026-09-15' });
    expect(releases[0].markdown).toContain('## Fixes');
    expect(releases[0].markdown).not.toContain('----------');
    expect(releases[1].markdown).toBe('Older tools.');
  });
  it('skips unpublished sections and ignores headings in fenced code', () => {
    const releases = parsePublishedUpdates('# Unreleased\nComing soon\n' + fixture + '\n```md\n# example\n```');
    expect(releases).toHaveLength(2);
    expect(releases[1].markdown).not.toContain('duplicate');
  });
  it('keeps identity through edits to versioned release wording and detects changed content', () => {
    const [a] = parsePublishedUpdates(fixture);
    const [b] = parsePublishedUpdates(fixture.replace('Minor Update v2.3.1', 'Patch Update v2.3.1').replace('One fix', 'Two fixes'));
    expect(a.id).toBe(b.id);
    expect(a.hash).not.toBe(b.hash);
  });
  it.each(['<html>maintenance</html>', '# Release\nNo date', '# Release\n**February 31, 2026**\nBody', '# Draft\nUnpublished', '# Release\n**October 15, 2026**\n', fixture + '\n```'])('rejects invalid/incomplete documents: %s', input => {
    expect(() => parsePublishedUpdates(input)).toThrow();
  });
  it('retains full long content within Discord limits and resolves relative links', () => {
    const release = parsePublishedUpdates(fixture)[0];
    release.markdown = 'Line with emoji 🏰\n'.repeat(1600) + '[tools](/tools) @everyone <@123456789012345678>';
    const parts = buildUpdateMessages(release);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every(part => part.description.length <= 3800 && part.title.length <= 256)).toBe(true);
    expect(parts.map(part => part.description).join('')).toBe(release.markdown.replace('](/tools)', '](https://the-tower-run-tracker.com/tools)'));
    expect(parts.every(part => !/[\uD800-\uDBFF]$/.test(part.description))).toBe(true);
  });
  it('fetches only the deployed public feed with a timeout and no credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(fixture));
    vi.stubGlobal('fetch', fetcher);
    expect(await fetchPublishedUpdates()).toHaveLength(2);
    expect(fetcher.mock.calls[0][0]).toBe('https://the-tower-run-tracker.com/changelog.md');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) });
  });
  it('does not exceed the chunk limit when a newline falls exactly on its boundary', () => {
    const release = parsePublishedUpdates(fixture)[0];
    release.markdown = 'x'.repeat(3800) + '\n' + 'y'.repeat(3800);
    const parts = buildUpdateMessages(release);
    expect(parts.every(part => part.description.length <= 3800)).toBe(true);
    expect(parts.map(part => part.description).join('')).toBe(release.markdown);
  });
  it('rejects source HTTP errors and oversized responses without a partial result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
    await expect(fetchPublishedUpdates()).rejects.toThrow('503');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1))));
    await expect(fetchPublishedUpdates()).rejects.toThrow('size limit');
  });
});
