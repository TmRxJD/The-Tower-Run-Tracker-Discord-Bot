import { canonicalizeTrackerRunData } from '@tmrxjd/platform/tools';
import type { PendingRecordLike } from '../shared/track-review-records';

export type SubmissionSyncResult = {
  queuedForCloud?: boolean;
  cloudUnavailable?: boolean;
  localImageCapacityReached?: boolean;
  runId?: string | null;
  localId?: string | null;
};

export type LocalRunSummary = {
  totalRuns: number;
  runTypeCounts: Record<string, number>;
};

export function buildSubmitRunData(pending: PendingRecordLike, payloadRunData: Record<string, unknown>) {
  return canonicalizeTrackerRunData({
    ...(pending.canonicalRunData ?? {}),
    ...pending.runData,
    ...payloadRunData,
    screenshotUrl: pending.screenshot?.url ?? pending.runData?.screenshotUrl ?? undefined,
  });
}

export function buildCanonicalRunData(pending: PendingRecordLike, submitRunData: Record<string, unknown>) {
  return canonicalizeTrackerRunData({
    ...(pending.canonicalRunData ?? {}),
    ...submitRunData,
  });
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveDuplicateRunInfo(pending: PendingRecordLike, submitRunData: Record<string, unknown>) {
  const duplicateRunId = readTrimmedString(submitRunData.runId) ?? readTrimmedString(pending.runData?.runId);
  const duplicateLocalId = readTrimmedString(submitRunData.localId) ?? readTrimmedString(pending.runData?.localId);
  const shouldUpdateExistingRun = Boolean(duplicateRunId || duplicateLocalId || pending.isDuplicate || pending.runData?.runId || pending.runData?.localId);

  return { duplicateRunId, duplicateLocalId, shouldUpdateExistingRun };
}

export function buildRunTypeCounts(params: {
  localSummaryBefore: LocalRunSummary;
  localSummaryAfter: LocalRunSummary;
  canonicalRunData: Record<string, unknown>;
  submitRunData: Record<string, unknown>;
  shouldUpdateExistingRun: boolean;
}) {
  const runType = String((params.canonicalRunData.type ?? params.submitRunData.type ?? 'Farming') || 'Farming');
  const formattedRunType = runType.charAt(0).toUpperCase() + runType.slice(1);
  const runTypeCounts = { ...(params.localSummaryAfter.runTypeCounts ?? {}) };

  if (!params.shouldUpdateExistingRun) {
    const minimumTotalRuns = params.localSummaryBefore.totalRuns + 1;
    const currentTotalRuns = Object.values(runTypeCounts).reduce((sum, count) => sum + (Number(count) || 0), 0);
    if (currentTotalRuns < minimumTotalRuns) {
      const typeKey = runTypeCounts[runType] !== undefined
        ? runType
        : (runTypeCounts[formattedRunType] !== undefined ? formattedRunType : formattedRunType);
      runTypeCounts[typeKey] = (runTypeCounts[typeKey] ?? 0) + (minimumTotalRuns - currentTotalRuns);
    }
  }

  return runTypeCounts;
}

export function resolveSubmissionIds(params: {
  syncResult: SubmissionSyncResult | null;
  duplicateRunId: string | null;
  duplicateLocalId: string | null;
  submitRunData: Record<string, unknown>;
}) {
  const resolvedRunId = readTrimmedString(params.syncResult?.runId)
    ?? params.duplicateRunId
    ?? readTrimmedString(params.submitRunData.runId)
    ?? null;
  const resolvedLocalId = readTrimmedString(params.syncResult?.localId)
    ?? params.duplicateLocalId
    ?? readTrimmedString(params.submitRunData.localId)
    ?? null;

  return { resolvedRunId, resolvedLocalId };
}

export function buildCoverageSource(canonicalRunData: Record<string, unknown>, resolvedRunId: string | null, resolvedLocalId: string | null) {
  return canonicalizeTrackerRunData({
    ...canonicalRunData,
    ...(resolvedRunId ? { runId: resolvedRunId } : {}),
    ...(resolvedLocalId ? { localId: resolvedLocalId } : {}),
  });
}

export function resolveScreenshotUrl(submitRunData: Record<string, unknown>) {
  return typeof submitRunData.screenshotUrl === 'string' && submitRunData.screenshotUrl.trim().length
    ? submitRunData.screenshotUrl
    : null;
}

export function buildShareableRunPayload(coverageSource: Record<string, unknown>, screenshotUrl: string | null) {
  return {
    ...coverageSource,
    screenshotUrl: screenshotUrl ?? undefined,
  };
}