import { getTrackerKv, setTrackerKv } from '../../../services/idb';
import { logger } from '../../../core/logger';

/**
 * Share buttons (Expand / Battle Report) must keep working indefinitely, including after the
 * sharer deletes the run or the bot restarts onto a fresh process. The live run store is the
 * preferred source, but we also persist a snapshot of the shared run keyed by its button ref
 * so the buttons never go dead. One row per shared run (re-sharing overwrites in place).
 */

const SHARE_SNAPSHOT_KEY_PREFIX = 'share-snapshot:';

export type ShareSnapshot = {
  ref: string;
  userId: string;
  run: Record<string, unknown>;
  sharerName: string;
  updatedAt: number;
};

function snapshotKey(ref: string): string {
  return `${SHARE_SNAPSHOT_KEY_PREFIX}${ref}`;
}

export async function saveShareSnapshot(params: { ref: string; userId: string; run: Record<string, unknown>; sharerName: string }): Promise<void> {
  const snapshot: ShareSnapshot = {
    ref: params.ref,
    userId: params.userId,
    run: params.run,
    sharerName: params.sharerName,
    updatedAt: Date.now(),
  };
  try {
    await setTrackerKv(snapshotKey(params.ref), snapshot);
  } catch (error) {
    // A missing snapshot only costs us the live-store fallback; never fail the share over it.
    logger.warn('[share-snapshot] failed to persist share snapshot', { ref: params.ref, error });
  }
}

export async function readShareSnapshot(ref: string): Promise<ShareSnapshot | null> {
  try {
    const snapshot = await getTrackerKv<ShareSnapshot>(snapshotKey(ref));
    return snapshot && typeof snapshot.run === 'object' && snapshot.run !== null ? snapshot : null;
  } catch (error) {
    logger.warn('[share-snapshot] failed to read share snapshot', { ref, error });
    return null;
  }
}
