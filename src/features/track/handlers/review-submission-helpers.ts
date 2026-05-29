import { buildTrackerResolvedRunReference, canonicalizeTrackerRunData } from '@tmrxjd/platform/tools';
import type { PendingRecordLike } from '../shared/track-review-records';

export type SubmissionSyncResult = {
  queuedForCloud?: boolean;
  cloudUnavailable?: boolean;
  localImageCapacityReached?: boolean;
  cloudSyncDeferred?: boolean;
  runId?: string | null;
  localId?: string | null;
  backgroundSync?: Promise<Pick<SubmissionSyncResult, 'queuedForCloud' | 'cloudUnavailable'>>;
};

export type LocalRunSummary = {
  totalRuns: number;
  runTypeCounts: Record<string, number>;
};

export type SubmissionDispatchPlan = {
  operation: 'edit' | 'log';
  runData: Record<string, unknown>;
};

export type SubmissionPresentationState = {
  runTypeCounts: Record<string, number>;
  screenshotUrl: string | null;
  resolvedRunId: string | null;
  resolvedLocalId: string | null;
  coverageSource: Record<string, unknown>;
  shareableRun: Record<string, unknown>;
};

function flattenRunDataValues(source: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!source || typeof source !== 'object') return {};

  const nestedValues = source.values && typeof source.values === 'object' && !Array.isArray(source.values)
    ? source.values as Record<string, unknown>
    : null;

  const rest = { ...source };
  delete rest.values;
  return {
    ...(nestedValues ?? {}),
    ...rest,
  };
}

function canonicalizeSubmissionRunData(...sources: Array<Record<string, unknown> | null | undefined>) {
  return canonicalizeTrackerRunData(
    sources.reduce<Record<string, unknown>>((merged, source) => ({
      ...merged,
      ...flattenRunDataValues(source),
    }), {}),
  );
}

export function buildSubmitRunData(pending: PendingRecordLike, payloadRunData: Record<string, unknown>) {
  return canonicalizeSubmissionRunData(
    pending.canonicalRunData ?? {},
    pending.runData,
    {
      ...payloadRunData,
    screenshotUrl: pending.screenshot?.url ?? pending.runData?.screenshotUrl ?? undefined,
    },
  );
}

export function buildCanonicalRunData(pending: PendingRecordLike, submitRunData: Record<string, unknown>) {
  return canonicalizeSubmissionRunData(pending.canonicalRunData ?? {}, submitRunData);
}

export function resolveDuplicateRunInfo(pending: PendingRecordLike, submitRunData: Record<string, unknown>) {
  const duplicateReference = buildTrackerResolvedRunReference({
    localId: submitRunData.localId,
    fallbackLocalId: pending.runData?.localId,
    runId: submitRunData.runId,
    fallbackRunId: pending.runData?.runId,
  });
  const shouldUpdateExistingRun = Boolean(
    duplicateReference.runId
    || duplicateReference.localId
    || pending.isDuplicate,
  );

  return {
    duplicateRunId: duplicateReference.runId,
    duplicateLocalId: duplicateReference.localId,
    shouldUpdateExistingRun,
  };
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
  const resolvedReference = buildTrackerResolvedRunReference({
    localId: params.syncResult?.localId,
    fallbackLocalId: params.duplicateLocalId ?? params.submitRunData.localId,
    runId: params.syncResult?.runId,
    fallbackRunId: params.duplicateRunId ?? params.submitRunData.runId,
  });

  return {
    resolvedRunId: resolvedReference.runId,
    resolvedLocalId: resolvedReference.localId,
  };
}

export function buildSubmissionDispatchPlan(params: {
  submitRunData: Record<string, unknown>;
  duplicateRunId: string | null;
  duplicateLocalId: string | null;
  shouldUpdateExistingRun: boolean;
}): SubmissionDispatchPlan {
  if (!params.shouldUpdateExistingRun) {
    return {
      operation: 'log',
      runData: params.submitRunData,
    };
  }

  const duplicateReference = buildTrackerResolvedRunReference({
    runId: params.duplicateRunId,
    localId: params.duplicateLocalId,
    runData: params.submitRunData,
  });

  if (duplicateReference.runId) {
    return {
      operation: 'edit',
      runData: {
        ...params.submitRunData,
        runId: duplicateReference.runId,
      },
    };
  }

  return {
    operation: 'log',
    runData: duplicateReference.localId
      ? { ...params.submitRunData, localId: duplicateReference.localId }
      : params.submitRunData,
  };
}

export function buildCoverageSource(canonicalRunData: Record<string, unknown>, resolvedRunId: string | null, resolvedLocalId: string | null) {
  return canonicalizeSubmissionRunData(canonicalRunData, {
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

export function buildSubmissionPresentationState(params: {
  localSummaryBefore: LocalRunSummary;
  localSummaryAfter: LocalRunSummary;
  canonicalRunData: Record<string, unknown>;
  submitRunData: Record<string, unknown>;
  shouldUpdateExistingRun: boolean;
  syncResult: SubmissionSyncResult | null;
  duplicateRunId: string | null;
  duplicateLocalId: string | null;
}): SubmissionPresentationState {
  const runTypeCounts = buildRunTypeCounts({
    localSummaryBefore: params.localSummaryBefore,
    localSummaryAfter: params.localSummaryAfter,
    canonicalRunData: params.canonicalRunData,
    submitRunData: params.submitRunData,
    shouldUpdateExistingRun: params.shouldUpdateExistingRun,
  });
  const screenshotUrl = resolveScreenshotUrl(params.submitRunData);
  const { resolvedRunId, resolvedLocalId } = resolveSubmissionIds({
    syncResult: params.syncResult,
    duplicateRunId: params.duplicateRunId,
    duplicateLocalId: params.duplicateLocalId,
    submitRunData: params.submitRunData,
  });
  const coverageSource = buildCoverageSource(params.canonicalRunData, resolvedRunId, resolvedLocalId);
  const shareableRun = buildShareableRunPayload(coverageSource, screenshotUrl);

  return {
    runTypeCounts,
    screenshotUrl,
    resolvedRunId,
    resolvedLocalId,
    coverageSource,
    shareableRun,
  };
}