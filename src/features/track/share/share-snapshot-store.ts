import { canUseStoredTrackerRunCoverage, TRACKER_RUN_COVERAGE_PERCENTAGE_KEYS, type TrackerRunDeltaResult } from '@tmrxjd/platform/tools';
import { getTrackerKv, setTrackerKv } from '../../../services/idb';
import { logger } from '../../../core/logger';
import { SHARE_COVERAGE_VERSION } from './share-run-ref';

/**
 * Share buttons (Expand / Battle Report) must keep working indefinitely, including after the
 * sharer deletes the run or the bot restarts onto a fresh process. The live run store is the
 * preferred source, but we also persist a snapshot of the shared run keyed by its button ref
 * so the buttons never go dead. New references capture data/count versions; identical repeated shares reuse their snapshot.
 */

const SHARE_SNAPSHOT_KEY_PREFIX = 'share-snapshot:';

export type ShareSnapshot = {
  ref: string;
  userId: string;
  run: Record<string, unknown>;
  sharerName: string;
  updatedAt: number;
  historyVerified?: boolean;
  historyCapturedAt?: number;
  chartBase64?: string;
  deltaResult?: TrackerRunDeltaResult | null;
  coverageVersion?: typeof SHARE_COVERAGE_VERSION;
  runTypeCounts?: Record<string, number>;
};

function snapshotKey(ref: string): string {
  return `${SHARE_SNAPSHOT_KEY_PREFIX}${ref}`;
}

export async function saveShareSnapshot(params: { ref: string; userId: string; run: Record<string, unknown>; sharerName: string; runTypeCounts?: Record<string, number>; historyVerified?: boolean; historyCapturedAt?: number; chartBase64?: string; deltaResult?: TrackerRunDeltaResult | null }): Promise<boolean> {
  const snapshot: ShareSnapshot = {
    ref: params.ref,
    userId: params.userId,
    run: params.run,
    sharerName: params.sharerName,
    updatedAt: Date.now(),
    coverageVersion: SHARE_COVERAGE_VERSION,
    ...(params.historyCapturedAt !== undefined ? { historyCapturedAt: params.historyCapturedAt } : {}),
    ...(params.chartBase64 !== undefined ? { chartBase64: params.chartBase64 } : {}),
    ...(params.deltaResult !== undefined ? { deltaResult: params.deltaResult } : {}),
    ...(params.historyVerified === false ? { historyVerified: false } : {}),
    ...(params.runTypeCounts ? { runTypeCounts: params.runTypeCounts } : {}),
  };
  try {
    await setTrackerKv(snapshotKey(params.ref), snapshot, { requirePersistent: true });
    return true;
  } catch (error) {
    // The caller omits version buttons on failure; never silently substitute live data.
    logger.warn('[share-snapshot] failed to persist share snapshot', { ref: params.ref, error });
    return false;
  }
}

export async function readShareSnapshot(ref: string): Promise<ShareSnapshot | null> {
  try {
    const snapshot = await getTrackerKv<ShareSnapshot>(snapshotKey(ref));
    if (!snapshot || typeof snapshot.run !== 'object' || snapshot.run === null) return null;
    if (snapshot.coverageVersion === SHARE_COVERAGE_VERSION || !snapshot.deltaResult) return snapshot;
    // Older baselines may have used the superseded hit-based coverage fields.
    // Leave proven or unrelated comparison fields and the original snapshot intact.
    const baseline = { ...snapshot.deltaResult.baseline };
    for (const key of TRACKER_RUN_COVERAGE_PERCENTAGE_KEYS) if (!canUseStoredTrackerRunCoverage(key)) delete baseline[key];
    return { ...snapshot, deltaResult: { ...snapshot.deltaResult, baseline } };
  } catch (error) {
    logger.warn('[share-snapshot] failed to read share snapshot', { ref, error });
    return null;
  }
}
