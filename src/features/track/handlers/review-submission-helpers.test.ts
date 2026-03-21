import { describe, expect, it } from 'vitest';
import { buildCanonicalRunData, buildCoverageSource, buildRunTypeCounts, buildShareableRunPayload, buildSubmitRunData, resolveDuplicateRunInfo, resolveScreenshotUrl, resolveSubmissionIds } from './review-submission-helpers';

describe('review-submission-helpers', () => {
  it('builds submit and canonical run data with screenshot preference', () => {
    const pending = {
      runData: { wave: '10', screenshotUrl: 'old-url' },
      canonicalRunData: { tier: '5' },
      screenshot: { url: 'new-url' },
    } as const;

    const submitRunData = buildSubmitRunData(pending as never, { totalCoins: '100' });
    const canonicalRunData = buildCanonicalRunData(pending as never, submitRunData);

    expect(submitRunData).toMatchObject({ tier: '5', wave: '10', totalCoins: '100', screenshotUrl: 'new-url' });
    expect(canonicalRunData).toMatchObject({ tier: '5', wave: '10', totalCoins: '100', screenshotUrl: 'new-url' });
  });

  it('resolves duplicate ids and final submission ids', () => {
    const pending = {
      isDuplicate: false,
      runData: { runId: ' pending-run ', localId: '' },
    } as never;
    const duplicateInfo = resolveDuplicateRunInfo(pending, { localId: ' local-1 ' });
    const resolvedIds = resolveSubmissionIds({
      syncResult: { runId: ' server-run ', localId: null },
      duplicateRunId: duplicateInfo.duplicateRunId,
      duplicateLocalId: duplicateInfo.duplicateLocalId,
      submitRunData: { runId: 'draft-run' },
    });

    expect(duplicateInfo).toMatchObject({
      duplicateRunId: 'pending-run',
      duplicateLocalId: 'local-1',
      shouldUpdateExistingRun: true,
    });
    expect(resolvedIds).toMatchObject({ resolvedRunId: 'server-run', resolvedLocalId: 'local-1' });
  });

  it('repairs run type counts for new runs when local summary totals lag behind', () => {
    const runTypeCounts = buildRunTypeCounts({
      localSummaryBefore: { totalRuns: 4, runTypeCounts: { Farming: 4 } },
      localSummaryAfter: { totalRuns: 4, runTypeCounts: { Farming: 4 } },
      canonicalRunData: { type: 'Farming' },
      submitRunData: {},
      shouldUpdateExistingRun: false,
    });

    expect(runTypeCounts).toMatchObject({ Farming: 5 });
  });

  it('builds coverage and share payloads with resolved ids and optional screenshot', () => {
    const coverageSource = buildCoverageSource({ tier: '10' }, 'run-1', null);
    expect(coverageSource).toMatchObject({ tier: '10', runId: 'run-1' });
    expect(resolveScreenshotUrl({ screenshotUrl: '  image-url  ' })).toBe('  image-url  ');
    expect(buildShareableRunPayload(coverageSource, 'image-url')).toMatchObject({ tier: '10', runId: 'run-1', screenshotUrl: 'image-url' });
  });
});