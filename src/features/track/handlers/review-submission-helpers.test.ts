import { describe, expect, it } from 'vitest';
import { buildCanonicalRunData, buildCoverageSource, buildRunTypeCounts, buildShareableRunPayload, buildSubmissionDispatchPlan, buildSubmissionPresentationState, buildSubmitRunData, resolveDuplicateRunInfo, resolveScreenshotUrl, resolveSubmissionIds } from './review-submission-helpers';

describe('review-submission-helpers', () => {
  it('builds submit and canonical run data with screenshot preference', () => {
    const pending = {
      runData: { wave: '10', Wave: '999', screenshotUrl: 'old-url', killedBy: 'Fast', 'Killed By': 'Apathy' },
      canonicalRunData: { tier: '5' },
      screenshot: { url: 'new-url' },
    } as const;

    const submitRunData = buildSubmitRunData(pending as never, { totalCoins: '100' });
    const canonicalRunData = buildCanonicalRunData(pending as never, submitRunData);

    expect(submitRunData).toMatchObject({ tier: '5', wave: '10', totalCoins: '100', screenshotUrl: 'new-url', killedBy: 'Fast' });
    expect(canonicalRunData).toMatchObject({ tier: '5', wave: '10', totalCoins: '100', screenshotUrl: 'new-url', killedBy: 'Fast' });
    expect(submitRunData).not.toHaveProperty('Wave')
    expect(submitRunData).not.toHaveProperty('Killed By')
  });

  it('promotes nested parsed values into the submission payload', () => {
    const pending = {
      runData: { wave: '10' },
      canonicalRunData: {
        values: {
          highestCoinsPerMinute: '11.40q',
          coinsPerKill: '4.20T',
        },
      },
      screenshot: null,
    } as const;

    const submitRunData = buildSubmitRunData(pending as never, {});
    const canonicalRunData = buildCanonicalRunData(pending as never, submitRunData);

    expect(submitRunData).toMatchObject({
      wave: '10',
      highestCoinsPerMinute: '11.40q',
      coinsPerKill: '4.20T',
    });
    expect(canonicalRunData).toMatchObject({
      wave: '10',
      highestCoinsPerMinute: '11.40q',
      coinsPerKill: '4.20T',
    });
    expect(submitRunData).not.toHaveProperty('values');
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

  it('uses the same fallback run reference policy for review submission ids', () => {
    const duplicateInfo = resolveDuplicateRunInfo({
      isDuplicate: false,
      runData: { localId: ' pending-local ' },
    } as never, { id: ' draft-run-id ' });

    const resolvedIds = resolveSubmissionIds({
      syncResult: null,
      duplicateRunId: duplicateInfo.duplicateRunId,
      duplicateLocalId: duplicateInfo.duplicateLocalId,
      submitRunData: { id: ' draft-run-id ' },
    });

    expect(duplicateInfo).toMatchObject({
      duplicateRunId: null,
      duplicateLocalId: 'pending-local',
      shouldUpdateExistingRun: true,
    });
    expect(resolvedIds).toMatchObject({ resolvedRunId: null, resolvedLocalId: 'pending-local' });
  });

  it('builds the review submission dispatch plan from the shared duplicate reference policy', () => {
    expect(buildSubmissionDispatchPlan({
      submitRunData: { wave: '100', localId: ' draft-local ' },
      duplicateRunId: ' duplicate-run ',
      duplicateLocalId: ' duplicate-local ',
      shouldUpdateExistingRun: true,
    })).toMatchObject({
      operation: 'edit',
      runData: { wave: '100', localId: ' draft-local ', runId: 'duplicate-run' },
    });

    expect(buildSubmissionDispatchPlan({
      submitRunData: { wave: '200' },
      duplicateRunId: null,
      duplicateLocalId: ' duplicate-local ',
      shouldUpdateExistingRun: true,
    })).toMatchObject({
      operation: 'log',
      runData: { wave: '200', localId: 'duplicate-local' },
    });

    expect(buildSubmissionDispatchPlan({
      submitRunData: { wave: '300' },
      duplicateRunId: null,
      duplicateLocalId: null,
      shouldUpdateExistingRun: false,
    })).toMatchObject({
      operation: 'log',
      runData: { wave: '300' },
    });
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

  it('builds the post-sync presentation state from shared review helpers', () => {
    expect(buildSubmissionPresentationState({
      localSummaryBefore: { totalRuns: 2, runTypeCounts: { Farming: 2 } },
      localSummaryAfter: { totalRuns: 2, runTypeCounts: { Farming: 2 } },
      canonicalRunData: { tier: '10', type: 'Farming' },
      submitRunData: { screenshotUrl: 'image-url' },
      shouldUpdateExistingRun: false,
      syncResult: { runId: 'server-run', localId: 'server-local' },
      duplicateRunId: null,
      duplicateLocalId: null,
    })).toMatchObject({
      runTypeCounts: { Farming: 3 },
      screenshotUrl: 'image-url',
      resolvedRunId: 'server-run',
      resolvedLocalId: 'server-local',
      coverageSource: { tier: '10', type: 'Farming', runId: 'server-run', localId: 'server-local' },
      shareableRun: { tier: '10', type: 'Farming', runId: 'server-run', localId: 'server-local', screenshotUrl: 'image-url' },
    });
  });
});