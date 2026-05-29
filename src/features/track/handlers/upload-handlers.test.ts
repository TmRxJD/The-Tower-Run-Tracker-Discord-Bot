import { describe, expect, it } from 'vitest';
import { applyDetectedDuplicateReference, buildUploadSummarySignature, pickLastAppwriteUploadedRun } from './upload-handlers';

describe('upload-handlers duplicate reference application', () => {
  it('applies duplicate ids using the shared resolved-run precedence', () => {
    expect(applyDetectedDuplicateReference(
      {
        runId: ' existing-run ',
        wave: '100',
      },
      {
        duplicateRunId: ' duplicate-run ',
        duplicateLocalId: ' duplicate-local ',
      },
    )).toMatchObject({
      runId: 'existing-run',
      localId: 'duplicate-local',
      wave: '100',
    });
  });

  it('fills missing ids from duplicate detection when the upload payload lacks them', () => {
    expect(applyDetectedDuplicateReference(
      {
        localId: '   ',
        tier: '11',
      },
      {
        duplicateRunId: ' duplicate-run ',
        duplicateLocalId: ' duplicate-local ',
      },
    )).toMatchObject({
      runId: 'duplicate-run',
      localId: 'duplicate-local',
      tier: '11',
    });
  });

  it('treats fallback id as a cloud run id when picking the last uploaded run', () => {
    expect(pickLastAppwriteUploadedRun([
      { id: ' fallback-run ', createdAt: 10, wave: '90' },
      { runId: ' explicit-run ', createdAt: 5, wave: '80' },
      { localId: 'local-only', createdAt: 20, wave: '100' },
    ])).toMatchObject({ id: ' fallback-run ', wave: '90' });
  });

  it('normalizes the last-run signature id through the shared run reference helper', () => {
    const signature = buildUploadSummarySignature({
      lastRun: {
        id: ' fallback-run ',
        updatedAt: 123,
        wave: '120',
      },
      allRuns: [{}, {}],
      runTypeCounts: { Farming: 2 },
    });

    expect(JSON.parse(signature)).toMatchObject({
      totalRuns: 2,
      runTypeCounts: { Farming: 2 },
      lastRunId: 'fallback-run',
      lastRunUpdatedAt: 123,
      lastRunWave: '120',
    });
  });
});