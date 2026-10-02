import { hydrateTrackerCloudRun, buildTrackerResolvedRunReference } from '@tmrxjd/platform/tools';
import { loadLocalRunsFromBotRxDB, upsertMergedRunsIntoBotRxDB } from '../../rxdb/run-rxdb-store';
import { getLocalSettings, getQueueItems } from './local-run-store';
import { getPermanentlyDeletedRunIds } from './run-deletion-tombstones';
import { loadBotCompleteRunCloudDocuments } from './run-cloud-pair-client';

// Bot interaction coordination only; parsing, hydration and reference semantics remain shared.
const tails = new Map<string, Promise<void>>();
export async function withBotRunSubmissionLock<T>(userId: string, action: () => Promise<T>): Promise<T> {
  const previous = tails.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(userId, tail);
  try {
    await withBotHistoryDeadline(() => previous, 60_000, 'Another run is still being saved. Please retry shortly.');
    return await action();
  }
  finally {
    release();
    // A timed-out waiter must not remove the active predecessor's protection.
    void tail.then(() => { if (tails.get(userId) === tail) tails.delete(userId); });
  }
}

export async function withBotHistoryDeadline<T>(read: () => Promise<T>, timeoutMs = 45_000,
  message = 'Run history lookup timed out. Nothing was saved. Please retry.'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function reference(run: Record<string, unknown>) {
  return buildTrackerResolvedRunReference({ runId: run.runId, fallbackRunId: run.id ?? run.$id, localId: run.localId });
}

export async function prepareBotRunUploadHistory(userId: string) {
  const settings = await getLocalSettings(userId);
  if (settings.cloudSyncEnabled === false) {
    return { getRuns: () => loadLocalRunsFromBotRxDB(userId) };
  }
  // Never ingest partial results or normalize/write remote records on this read path.
  const cloudRuns = await withBotHistoryDeadline(() => loadBotCompleteRunCloudDocuments(userId));
  const tombstones = await getPermanentlyDeletedRunIds(userId);
  const active = cloudRuns.filter(run => !run.deletedAt && !tombstones.has(reference(run).runId ?? ''));
  const cloudIds = new Set(active.map(run => reference(run).runId).filter(Boolean));
  const queue = await getQueueItems(userId);
  const pendingRunIds = new Set(queue.filter(item => item.op === 'upsert').map(item => item.runId).filter(Boolean));
  const pendingLocalIds = new Set(queue.filter(item => item.op === 'upsert').map(item => item.localId).filter(Boolean));
  // Preserve queued local edits. Hydrate in small chunks to keep gateway acknowledgments responsive.
  const toHydrate = active.filter(run => !pendingRunIds.has(reference(run).runId ?? ''));
  for (let offset = 0; offset < toHydrate.length; offset += 25) {
    await upsertMergedRunsIntoBotRxDB(userId, toHydrate.slice(offset, offset + 25)
      .map(run => hydrateTrackerCloudRun(run, userId, String(run.username ?? 'unknown'))));
    if (offset + 25 < toHydrate.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  // Preserve only explicitly submitted new references, not unrelated concurrent cache arrivals.
  const getRuns = async (submitted?: { runId?: string | null; localId?: string | null }) => {
    const local = await loadLocalRunsFromBotRxDB(userId);
    // Count current cloud history plus unsynced/new local submissions. Stale cloud-backed
    // cache entries are excluded from this view, without deleting any stored record.
    return local.filter(run => {
      const ref = reference(run);
      if (run.deletedAt || (ref.runId && tombstones.has(ref.runId))) return false;
      return !ref.runId || cloudIds.has(ref.runId) || pendingRunIds.has(ref.runId)
        || pendingLocalIds.has(run.localId) || Boolean(submitted?.localId && submitted.localId === run.localId)
        || Boolean(submitted?.runId && submitted.runId === ref.runId);
    });
  };
  const visible = await getRuns();
  const visibleIds = new Set(visible.map(run => reference(run).runId));
  if (active.some(run => !visibleIds.has(reference(run).runId))) {
    throw new Error('Run history could not be loaded completely. Please retry.');
  }
  return { getRuns };
}
