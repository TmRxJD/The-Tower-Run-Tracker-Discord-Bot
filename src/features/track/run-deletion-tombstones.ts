import { getTrackerKv, setTrackerKv } from '../../services/idb';

const TOMBSTONE_KV_PREFIX = 'tracker:permanent-deleted-run-ids:v1:';

function buildKey(userId: string): string {
  return `${TOMBSTONE_KV_PREFIX}${userId.trim()}`;
}

export async function getPermanentlyDeletedRunIds(userId: string): Promise<Set<string>> {
  const stored = await getTrackerKv<string[]>(buildKey(userId)).catch(() => null);
  if (!Array.isArray(stored)) {
    return new Set();
  }
  return new Set(stored.map(id => String(id).trim()).filter(Boolean));
}

export async function markRunPermanentlyDeleted(userId: string, runId: string): Promise<void> {
  const normalized = runId.trim();
  if (!normalized) {
    return;
  }
  const existing = await getPermanentlyDeletedRunIds(userId);
  if (existing.has(normalized)) {
    return;
  }
  existing.add(normalized);
  await setTrackerKv(buildKey(userId), Array.from(existing)).catch(() => {});
}

export function filterOutTombstonedRunIds(runIds: string[], tombstones: Set<string>): string[] {
  if (tombstones.size === 0) {
    return runIds;
  }
  return runIds.filter(id => !tombstones.has(id.trim()));
}

export function filterOutTombstonedRuns<T extends Record<string, unknown>>(
  runs: T[],
  tombstones: Set<string>,
): T[] {
  if (tombstones.size === 0) {
    return runs;
  }
  return runs.filter((run) => {
    const runId = String(run.runId ?? run.id ?? run.$id ?? '').trim();
    return !runId || !tombstones.has(runId);
  });
}
