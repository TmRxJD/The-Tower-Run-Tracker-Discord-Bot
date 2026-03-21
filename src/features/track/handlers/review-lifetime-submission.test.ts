import { describe, expect, it } from 'vitest';
import { buildLifetimeEntryPayload, buildLifetimeSubmissionArtifacts } from './review-lifetime-submission';

describe('review-lifetime-submission', () => {
  it('builds lifetime entry payload with screenshot and date fallback', () => {
    const payload = buildLifetimeEntryPayload({
      runData: { wave: '10' },
      screenshot: { url: 'https://example.test/image.png' },
    } as never);

    expect(payload.screenshotUrl).toBe('https://example.test/image.png');
    expect(payload.entryData.wave).toBe('10');
    expect(typeof payload.entryData.date).toBe('string');
  });

  it('builds lifetime submission artifacts with screenshot attachment when available', () => {
    const artifacts = buildLifetimeSubmissionArtifacts({
      pending: { runData: { runId: 'r1', wave: '9' } } as never,
      lifetimeResult: { allEntries: [{ wave: '99' }] },
      screenshotUrl: 'https://example.test/image.png',
    });

    expect(artifacts.files).toEqual([{ attachment: 'https://example.test/image.png', name: 'screenshot.png' }]);
    expect(artifacts.embed).toBeTruthy();
  });
});