import { readVerifiedHistorySnapshot, saveVerifiedHistorySnapshot } from './run-history-snapshot';
import { trackerRunsShareDuplicateIdentity } from '@tmrxjd/platform/tools';
import { yieldToEventLoop } from '../../utils/event-loop';
import { hydrateTrackerCloudRun, buildTrackerResolvedRunReference } from '@tmrxjd/platform/tools';
import { loadLocalRunsFromBotRxDB, upsertMergedRunsIntoBotRxDB } from '../../rxdb/run-rxdb-store';
import { getLocalSettings, getQueueItems } from './local-run-store';
import { getPermanentlyDeletedRunIds } from './run-deletion-tombstones';
import { loadBotCompleteRunCloudDocuments } from './run-cloud-pair-client';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { logger } from '../../core/logger';
import { annotateHistoryFailure, historyFailureError, readHistoryFailure, getKnownHistoryFailure, type HistoryFailureStage } from './history-failure-diagnostic';
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
  const waitingStarted = performance.now();
  let acquiredAt = 0;
  let stageStarted = 0;
  let currentStage: OperationStage = 'action';
  const stageMs: Partial<Record<OperationStage, number>> = {};
  const finishStage = () => { if (acquiredAt) stageMs[currentStage] = (stageMs[currentStage] ?? 0) + performance.now() - stageStarted; };
  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withBotHistoryDeadline(() => previous, 60_000, operation === 'presentation'
      ? 'Another response is still being delivered. Check your latest run before retrying.'
      : 'Another run is still being saved. Please retry shortly.', 'lock_wait');
    acquired = true;
    acquiredAt = performance.now();
    stageStarted = acquiredAt;
    const owner = { operation, started: Date.now(), stage: 'action' as OperationStage };
    owners.set(userId, owner);
    slowTimer = setTimeout(() => logger.warn('Run operation lock held', {
      scope: createHmac('sha256', diagnosticSalt).update(userId).digest('hex').slice(0, 16),
      operation, stage: owner.stage, elapsedMs: Date.now() - owner.started,
    }), 30_000);
    return await action({ setStage: stage => { finishStage(); currentStage = stage; stageStarted = performance.now(); owner.stage = stage; } });
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
    finishStage();
    if (acquiredAt) logger.warn('[perf] run.operation', {
      operation, waitMs: Math.round(acquiredAt - waitingStarted),
      durationMs: Math.round(performance.now() - acquiredAt),
      stages: Object.fromEntries(Object.entries(stageMs).map(([stage, ms]) => [stage, Math.round(ms)])),
    });
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
function historyReadKey(userId: string, includeExtended: boolean) { return `${includeExtended ? 'full' : 'main'}:${userId}`; }
function readCompleteHistory(userId: string, includeExtended = true) {
  const key = historyReadKey(userId, includeExtended);
  const existing = cloudReads.get(key);
  if (existing) return existing;
  if (cloudReads.size >= 128) return Promise.reject(historyFailureError('Run history service is busy. Please retry.', 'busy', 'cloud_history'));
  const read = includeExtended ? loadBotCompleteRunCloudDocuments(userId) : loadBotCompleteRunCloudDocuments(userId, { includeExtended: false });
  cloudReads.set(key, read);
  void read.then(() => { if (cloudReads.get(key) === read) cloudReads.delete(key); },
    () => { if (cloudReads.get(key) === read) cloudReads.delete(key); });
  return read;
}

function reference(run: Record<string, unknown>) {
  return buildTrackerResolvedRunReference({ runId: run.runId, fallbackRunId: run.id ?? run.$id, localId: run.localId });
}

export type BotRunHistory = { verified?: boolean; completeLocal?: boolean; getRuns: (submitted?: { runId?: string | null; localId?: string | null }) => Promise<Record<string, unknown>[]> };
export async function prepareBotRunUploadHistory(userId: string, options: { readOnly?: boolean; mainOnly?: boolean; localFirst?: boolean; localOnly?: boolean; onStage?: BotRunOperationContext['setStage'] } = {}): Promise<BotRunHistory> {
  if (options.localFirst) {
    const tombstones = await getPermanentlyDeletedRunIds(userId);
    const settings = await getLocalSettings(userId);
    if (settings.cloudSyncEnabled !== false && !options.localOnly) {
      try {
        const online = await withBotHistoryDeadline(() => prepareBotRunUploadHistory(userId, { ...options, localFirst: false, readOnly: true }), 15000);
        return { ...online, verified: true, completeLocal: !options.mainOnly };
      } catch (error) {
        const failure = getKnownHistoryFailure(error);
        if (failure && ['schema', 'ownership', 'pagination'].includes(failure.cause)) throw error;
        logger.warn('Cloud history unavailable; continuing with durable local data', { stage: failure?.stage ?? 'cloud_history', cause: failure?.cause ?? 'unavailable' });
      }
    }
    const snapshot = settings.cloudSyncEnabled === false ? null : await readVerifiedHistorySnapshot(userId);
    return { verified: settings.cloudSyncEnabled === false, completeLocal: settings.cloudSyncEnabled === false || Boolean(snapshot), getRuns: async () => {
      const local = await loadLocalRunsFromBotRxDB(userId);
      const rows: Record<string, unknown>[] = snapshot ? snapshot.documents.map(run => {
        const existing = local.find(row => reference(row).runId === reference(run).runId);
        return { ...hydrateTrackerCloudRun(run, userId, String(run.username ?? 'unknown')), ...(existing?.localId ? { localId: existing.localId } : {}) };
      }) : [...local];
      // The normal RxDB cache is memory-backed. Newly accepted durable intents remain
      // visible after restart without cloud access or replaying historical unknowns.
      const queued = await getQueueItems(userId);
      for (const item of queued) if (item.op === 'delete' && item.runId) tombstones.add(item.runId);
      for (const item of queued) {
        if (item.op !== 'upsert' || !item.automaticRecovery || item.uploadProfileId === undefined || !item.runData) continue;
        const restored = { ...item.runData, ...item.canonicalRunData, localId: item.localId, runId: item.runId, profileId: item.uploadProfileId };
        const index = rows.findIndex(row => Boolean(item.localId && row.localId === item.localId)
          || Boolean(item.runId && reference(row).runId === item.runId)
          || Boolean(item.duplicateCheckPending && (row.profileId || null) === (item.uploadProfileId || null) && trackerRunsShareDuplicateIdentity(row, restored)));
        if (index >= 0) rows[index] = { ...rows[index], ...restored };
        else rows.push(restored);
      }
      return rows.filter(run => !run.deletedAt && !tombstones.has(reference(run).runId ?? '') && !tombstones.has(String(run.localId ?? '')));
    } };
  }
  if (options.mainOnly && !options.readOnly) throw new Error('Main-only history must remain read-only.');
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
    const cloudRuns = await withBotHistoryDeadline(() => readCompleteHistory(userId, !options.mainOnly), 45_000,
      options.readOnly ? 'Run history lookup timed out. Please retry sharing.' : undefined).catch(error => {
        const failure = annotateHistoryFailure(error, historyStage, correlation);
        logger.warn('Run history read failed', { operation: options.readOnly ? 'share-history' : 'upload-history',
          scope: createHmac('sha256', diagnosticSalt).update(userId).digest('hex').slice(0, 16),
          elapsedMs: Date.now() - started, pendingRead: cloudReads.has(historyReadKey(userId, !options.mainOnly)), ...readHistoryFailure(failure) });
        throw failure;
      });
    if (!options.mainOnly) await saveVerifiedHistorySnapshot(userId, cloudRuns).catch(() => logger.warn('Verified history fallback snapshot could not be persisted'));
    options.onStage?.('local-history');
    historyStage = 'local_history';
    const tombstones = await getPermanentlyDeletedRunIds(userId);
    const queue = await getQueueItems(userId);
    for (const item of queue) if (item.op === 'delete' && item.runId) tombstones.add(item.runId);
    const active = cloudRuns.filter(run => !run.deletedAt && !tombstones.has(reference(run).runId ?? ''));
    const cloudIds = new Set(active.map(run => reference(run).runId).filter(Boolean));
    const pendingByLocalId = new Map(queue.filter(item => item.op === 'upsert').map(item => [item.localId, item]));
    const pendingRunIds = new Set(queue.filter(item => item.op === 'upsert').map(item => item.runId).filter(Boolean));
    const pendingLocalIds = new Set(queue.filter(item => item.op === 'upsert').map(item => item.localId).filter(Boolean));
    if (options.readOnly) {
      const local = [...await loadLocalRunsFromBotRxDB(userId)];
      for (const item of queue) {
        if (item.op !== 'upsert' || !item.automaticRecovery || item.uploadProfileId === undefined || !item.runData
          || local.some(row => Boolean(item.localId && row.localId === item.localId))) continue;
        local.push({ ...item.runData, ...item.canonicalRunData, localId: item.localId, runId: item.runId,
          userId, username: item.username, createdAt: item.createdAt, updatedAt: item.createdAt } as typeof local[number]);
      }
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
          const pending = pendingByLocalId.get(run.localId);
          const index = rows.findIndex(existing => reference(existing).runId && reference(existing).runId === ref.runId
            || Boolean(existing.localId && existing.localId === run.localId)
            || Boolean(pending?.duplicateCheckPending && (existing.profileId || null) === (pending.uploadProfileId || null) && trackerRunsShareDuplicateIdentity(existing, run)));
          if (index >= 0) rows[index] = { ...run, runId: reference(rows[index]).runId ?? ref.runId };
          else rows.push(run);
        }
      }
      const visibleIds = new Set(rows.map(row => reference(row).runId));
      if (active.some(run => !visibleIds.has(reference(run).runId))) {
        throw historyFailureError('Run history could not be loaded completely. Please retry.', 'count_consistency', 'visibility', correlation);
      }
      return { getRuns: async submitted => {
        if (!submitted?.runId && !submitted?.localId) return rows;
        const saved = (await loadLocalRunsFromBotRxDB(userId)).find(run => Boolean(submitted.localId && run.localId === submitted.localId)
          || Boolean(submitted.runId && reference(run).runId === submitted.runId));
        if (!saved || saved.deletedAt || tombstones.has(reference(saved).runId ?? '')) return rows;
        const current = [...rows];
        const index = current.findIndex(run => Boolean(saved.localId && run.localId === saved.localId)
          || Boolean(reference(saved).runId && reference(run).runId === reference(saved).runId));
        if (index < 0) current.push(saved); else current[index] = saved;
        return current;
      } };

    }
    // Preserve queued local edits. Hydrate in small chunks to keep gateway acknowledgments responsive.
    const toHydrate = active.filter(run => !pendingRunIds.has(reference(run).runId ?? ''));
    options.onStage?.('hydration');
    historyStage = 'hydration';
    for (let offset = 0; offset < toHydrate.length; offset += 25) {
      await upsertMergedRunsIntoBotRxDB(userId, toHydrate.slice(offset, offset + 25)
        .map(run => hydrateTrackerCloudRun(run, userId, String(run.username ?? 'unknown'))));
      if (offset + 25 < toHydrate.length) await yieldToEventLoop();
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
