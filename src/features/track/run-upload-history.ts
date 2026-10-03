import { hydrateTrackerCloudRun, buildTrackerResolvedRunReference } from '@tmrxjd/platform/tools';
import { loadLocalRunsFromBotRxDB, upsertMergedRunsIntoBotRxDB } from '../../rxdb/run-rxdb-store';
import { getLocalSettings, getQueueItems } from './local-run-store';
import { getPermanentlyDeletedRunIds } from './run-deletion-tombstones';
import { loadBotCompleteRunCloudDocuments } from './run-cloud-pair-client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { logger } from '../../core/logger';
import { annotateHistoryFailure, historyFailureError, readHistoryFailure, type HistoryFailureStage } from './history-failure-diagnostic';
const diagnosticSalt = randomBytes(32);

// Bot interaction coordination only; parsing, hydration and reference semantics remain shared.
const tails = new Map<string, Promise<void>>();
type LockOperation = 'submission' | 'upload-history' | 'share-history' | 'presentation';
type OperationStage = 'action' | 'settings' | 'cloud-history' | 'local-history' | 'hydration' | 'duplicate-check' | 'save' | 'saved-state';
export type BotRunOperationContext = { setStage: (stage: OperationStage) => void };
const owners = new Map<string, { operation: LockOperation; started: number; stage: OperationStage }>();
export async function withBotRunSubmissionLock<T>(userId: string, action: (context: BotRunOperationContext) => Promise<T>,
  operation: LockOperation = 'submission'): Promise<T> {
  const previous = tails.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(userId, tail);
  const waitingSince = Date.now();
  let acquired = false;
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withBotHistoryDeadline(() => previous, 60_000, operation === 'presentation'
      ? 'Another response is still being delivered. Check your latest run before retrying.'
      : 'Another run is still being saved. Please retry shortly.', 'lock_wait');
    acquired = true;
    const owner = { operation, started: Date.now(), stage: 'action' as OperationStage };
    owners.set(userId, owner);
    slowTimer = setTimeout(() => logger.warn('Run operation lock held', {
      scope: createHmac('sha256', diagnosticSalt).update(userId).digest('hex').slice(0, 16),
      operation, stage: owner.stage, elapsedMs: Date.now() - owner.started,
    }), 30_000);
    return await action({ setStage: stage => { owner.stage = stage; } });
  }
  catch (error) {
    if (!acquired) {
      const owner = owners.get(userId);
      logger.warn('Run operation lock wait failed', {
        scope: createHmac('sha256', diagnosticSalt).update(userId).digest('hex').slice(0, 16),
        operation, waitMs: Date.now() - waitingSince,
        ownerOperation: owner?.operation ?? 'unknown',
        ownerStage: owner?.stage ?? 'unknown',
        ownerElapsedMs: owner ? Date.now() - owner.started : null,
      });
    }
    throw error;
  }
  finally {
    if (slowTimer) clearTimeout(slowTimer);
    if (acquired) owners.delete(userId);
    release();
    // A timed-out waiter must not remove the active predecessor's protection.
    void tail.then(() => { if (tails.get(userId) === tail) tails.delete(userId); });
  }
}

export async function withBotHistoryDeadline<T>(read: () => Promise<T>, timeoutMs = 45_000,
  message = 'Run history lookup timed out. Nothing was saved. Please retry.', stage: HistoryFailureStage = 'cloud_history'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(historyFailureError(message, 'timeout', stage)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Keep unresolved reads coalesced even when an interaction's bounded wait ends.
// Retrying must not amplify outstanding cloud work; completed results are not cached.
const cloudReads = new Map<string, Promise<Record<string, unknown>[]>>();
function readCompleteHistory(userId: string) {
  const existing = cloudReads.get(userId);
  if (existing) return existing;
  if (cloudReads.size >= 128) return Promise.reject(historyFailureError('Run history service is busy. Please retry.', 'busy', 'cloud_history'));
  const read = loadBotCompleteRunCloudDocuments(userId);
  cloudReads.set(userId, read);
  void read.then(() => { if (cloudReads.get(userId) === read) cloudReads.delete(userId); },
    () => { if (cloudReads.get(userId) === read) cloudReads.delete(userId); });
  return read;
}

function reference(run: Record<string, unknown>) {
  return buildTrackerResolvedRunReference({ runId: run.runId, fallbackRunId: run.id ?? run.$id, localId: run.localId });
}

export async function prepareBotRunUploadHistory(userId: string, options: { readOnly?: boolean; onStage?: BotRunOperationContext['setStage'] } = {}) {
  const correlation = randomUUID();
  let historyStage: HistoryFailureStage = 'settings';
  try {
    options.onStage?.('settings');
    const settings = await getLocalSettings(userId);
    if (settings.cloudSyncEnabled === false) {
      return { getRuns: () => loadLocalRunsFromBotRxDB(userId) };
    }
    // Never ingest partial results or normalize/write remote records on this read path.
    const started = Date.now();
    options.onStage?.('cloud-history');
    historyStage = 'cloud_history';
    const cloudRuns = await withBotHistoryDeadline(() => readCompleteHistory(userId), 45_000,
      options.readOnly ? 'Run history lookup timed out. Please retry sharing.' : undefined).catch(error => {
        const failure = annotateHistoryFailure(error, historyStage, correlation);
        logger.warn('Run history read failed', { operation: options.readOnly ? 'share-history' : 'upload-history',
          scope: createHmac('sha256', diagnosticSalt).update(userId).digest('hex').slice(0, 16),
          elapsedMs: Date.now() - started, pendingRead: cloudReads.has(userId), ...readHistoryFailure(failure) });
        throw failure;
      });
    options.onStage?.('local-history');
    historyStage = 'local_history';
    const tombstones = await getPermanentlyDeletedRunIds(userId);
    const active = cloudRuns.filter(run => !run.deletedAt && !tombstones.has(reference(run).runId ?? ''));
    const cloudIds = new Set(active.map(run => reference(run).runId).filter(Boolean));
    const queue = await getQueueItems(userId);
    const pendingRunIds = new Set(queue.filter(item => item.op === 'upsert').map(item => item.runId).filter(Boolean));
    const pendingLocalIds = new Set(queue.filter(item => item.op === 'upsert').map(item => item.localId).filter(Boolean));
    if (options.readOnly) {
      const local = await loadLocalRunsFromBotRxDB(userId);
      const localByCloudId = new Map(local.map(run => [reference(run).runId, run]));
      const rows: Record<string, unknown>[] = active.filter(run => !pendingRunIds.has(reference(run).runId ?? ''))
        .map(run => {
          const hydrated = hydrateTrackerCloudRun(run, userId, String(run.username ?? 'unknown'));
          const existing = localByCloudId.get(reference(run).runId);
          return { ...hydrated, ...(existing?.localId ? { localId: existing.localId } : {}) };
        });
      for (const run of local) {
        const ref = reference(run);
        if (run.deletedAt || (ref.runId && tombstones.has(ref.runId))) continue;
        if (!ref.runId || pendingRunIds.has(ref.runId) || pendingLocalIds.has(run.localId)) {
          const index = rows.findIndex(existing => reference(existing).runId && reference(existing).runId === ref.runId
            || Boolean(existing.localId && existing.localId === run.localId));
          if (index >= 0) rows[index] = run;
          else rows.push(run);
        }
      }
      const visibleIds = new Set(rows.map(row => reference(row).runId));
      if (active.some(run => !visibleIds.has(reference(run).runId))) {
        throw historyFailureError('Run history could not be loaded completely. Please retry.', 'count_consistency', 'visibility', correlation);
      }
      return { getRuns: async () => rows };
    }
    // Preserve queued local edits. Hydrate in small chunks to keep gateway acknowledgments responsive.
    const toHydrate = active.filter(run => !pendingRunIds.has(reference(run).runId ?? ''));
    options.onStage?.('hydration');
    historyStage = 'hydration';
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
    options.onStage?.('local-history');
    historyStage = 'visibility';
    const visible = await getRuns();
    const visibleIds = new Set(visible.map(run => reference(run).runId));
    if (active.some(run => !visibleIds.has(reference(run).runId))) {
      throw historyFailureError('Run history could not be loaded completely. Please retry.', 'count_consistency', 'visibility', correlation);
    }
    return { getRuns };
  } catch (error) { throw annotateHistoryFailure(error, historyStage, correlation); }
}
