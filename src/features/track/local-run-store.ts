import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { applyRetryFailureState, buildBattleRunDedupKeysFromStoredRun, buildTrackerQueuedRunReferenceIdentity, buildTrackerRunFingerprint, canonicalizeTrackerRunData, createRetryScheduleState, enqueueUniqueItemsByKey, isPopulatedBattleRunDedupKey, parseRetryScheduleState, replaceOrInsertMatchingItem, trackerRunReferencesSameEntry } from '@tmrxjd/platform/tools';
import { trackerStoredSettingsSchema, type TrackerSettings } from './types';
import { logger } from '../../core/logger';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import * as rxdbStore from '../../rxdb/run-rxdb-store';

type SyncOp = 'upsert' | 'delete' | 'settings';

export interface LocalRunRecord {
  localId: string;
  userId: string;
  username: string;
  runId?: string;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface CloudQueueItem {
  id: string;
  op: SyncOp;
  userId: string;
  username: string;
  runId?: string;
  localId?: string;
  runData?: Record<string, unknown>;
  canonicalRunData?: Record<string, unknown>;
  settingsData?: TrackerSettings & { updatedAt?: number };
  settingsUpdatedAt?: number;
  screenshot?: { filename: string; contentType?: string | null; tempPath: string } | null;
  createdAt: number;
  retryCount: number;
  nextRetryAt?: number;
  lastError?: string;
}

export interface LocalLifetimeRecord {
  entries: Array<Record<string, unknown>>;
  updatedAt: number;
}

interface LocalUserBucket {
  settings: TrackerSettings & { cloudSyncEnabled?: boolean; updatedAt?: number };
  runs: LocalRunRecord[];
  lifetime?: LocalLifetimeRecord;
}

interface LocalStoreState {
  version: 1;
  users: Record<string, LocalUserBucket>;
  queue: CloudQueueItem[];
}

const STORE_KEY = 'tracker-local-store:v1';
const defaultSettings = (): TrackerSettings & { cloudSyncEnabled: boolean } => ({
  defaultRunType: 'Farming',
  defaultTracker: 'Web',
  scanLanguage: 'English',
  timezone: 'UTC',
  decimalPreference: 'Period (.)',
  autoDetectDuplicates: true,
  confirmBeforeSubmit: true,
  shareNotes: true,
  shareCoverage: true,
  shareCoverageGoldenTower: true,
  shareCoverageBlackHole: true,
  shareCoverageSpotlight: true,
  shareCoverageDeathWave: true,
  shareCoverageOrbs: true,
  shareCoverageGoldenBot: true,
  shareCoverageAmpBot: true,
  shareCoverageSummoned: true,
  shareTotalShards: true,
  shareScreenshot: true,
  shareTier: true,
  shareWave: true,
  shareDuration: true,
  shareKilledBy: true,
  shareTotalCoins: true,
  shareTotalCells: true,
  shareTotalDice: true,
  shareDeathDefy: true,
  shareCoinsPerHour: true,
  shareCellsPerHour: true,
  shareDicePerHour: true,
  shareShardsPerHour: true,
  shareWavesPerHour: true,
  shareEnemiesPerHour: true,
  shareChart: true,
  shareCompact: false,
  cloudSyncEnabled: true,
});

let cache: LocalStoreState | null = null;

function parseEpochMillis(value: unknown): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value < 10_000_000_000) return value * 1000;
    return value > 0 ? value : 0;
  }

  const raw = String(value).trim();
  if (!raw) return 0;

  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      if (numeric > 0 && numeric < 10_000_000_000) return numeric * 1000;
      return numeric > 0 ? numeric : 0;
    }
  }

  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function estimateRunTimestamp(run: Record<string, unknown>): number {
  if (!run || typeof run !== 'object') return 0;
  const candidates = [
    run.updatedAt,
    run.createdAt,
    run.reportTimestamp,
    run.timestamp,
    run['Battle Date'],
    run.battleDate,
    `${run.date || run.runDate || ''} ${run.time || run.runTime || ''}`.trim(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate !== 'string' && !(candidate instanceof Date)) continue;
    const parsed = new Date(candidate).getTime();
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function runFingerprint(run: Record<string, unknown>): string {
  return buildTrackerRunFingerprint(run);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseCloudQueueItem(item: unknown): CloudQueueItem | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const op = record.op;
  if (op !== 'upsert' && op !== 'delete' && op !== 'settings') {
    return null;
  }

  const userId = typeof record.userId === 'string' && record.userId.trim().length > 0 ? record.userId : null;
  const username = typeof record.username === 'string' && record.username.trim().length > 0 ? record.username : null;
  const createdAt = Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : null;
  const retryState = parseRetryScheduleState({
    attemptCount: record.retryCount,
    nextRetryAt: record.nextRetryAt,
  });

  if (!userId || !username || createdAt === null) {
    return null;
  }

  if (op === 'settings') {
    const settingsData = record.settingsData && typeof record.settingsData === 'object' ? trackerStoredSettingsSchema.safeParse(record.settingsData) : null;
    const settingsUpdatedAt = Number.isFinite(Number(record.settingsUpdatedAt)) ? Number(record.settingsUpdatedAt) : null;
    if (!settingsData?.success || settingsUpdatedAt === null) {
      return null;
    }

    return {
      id: typeof record.id === 'string' && record.id.trim().length > 0 ? record.id : randomUUID(),
      op,
      userId,
      username,
      settingsData: settingsData.data,
      settingsUpdatedAt,
      createdAt,
      retryCount: retryState.attemptCount,
      nextRetryAt: retryState.nextRetryAt,
      lastError: typeof record.lastError === 'string' && record.lastError.length > 0 ? record.lastError : undefined,
    };
  }

  const runDataRecord = asRecord(record.runData);
  const canonicalRunDataRecord = asRecord(record.canonicalRunData);
  const screenshotRecord = asRecord(record.screenshot);

  const runData = runDataRecord ? canonicalizeTrackerRunData(runDataRecord) : undefined;
  const canonicalRunData = canonicalRunDataRecord ? canonicalizeTrackerRunData(canonicalRunDataRecord) : undefined;

  return {
    id: typeof record.id === 'string' && record.id.trim().length > 0 ? record.id : randomUUID(),
    op,
    userId,
    username,
    runId: typeof record.runId === 'string' && record.runId.trim().length > 0 ? record.runId : undefined,
    localId: typeof record.localId === 'string' && record.localId.trim().length > 0 ? record.localId : undefined,
    runData,
    canonicalRunData,
    screenshot: screenshotRecord
      ? {
          filename: typeof screenshotRecord.filename === 'string' ? screenshotRecord.filename : '',
          contentType: typeof screenshotRecord.contentType === 'string' ? screenshotRecord.contentType : null,
          tempPath: typeof screenshotRecord.tempPath === 'string' ? screenshotRecord.tempPath : '',
        }
      : null,
    createdAt,
    retryCount: retryState.attemptCount,
    nextRetryAt: retryState.nextRetryAt,
    lastError: typeof record.lastError === 'string' && record.lastError.length > 0 ? record.lastError : undefined,
  };
}

async function ensureLoaded() {
  if (cache) return;
  const parsed = await getTrackerKv<LocalStoreState>(STORE_KEY);
  if (parsed) {
    const hadLegacyScreenshotPayload = Array.isArray(parsed?.queue)
      ? parsed.queue.some(item => isRecord(item) && Boolean(item.screenshot))
      : false;
    const normalizedQueue: CloudQueueItem[] = Array.isArray(parsed?.queue)
      ? parsed.queue
          .map(parseCloudQueueItem)
          .filter((item): item is CloudQueueItem => item !== null)
      : [];
    cache = {
      version: 1,
      users: parsed?.users ?? {},
      queue: normalizedQueue,
    };

    if (hadLegacyScreenshotPayload) {
      await persist();
    }
  } else {
    cache = { version: 1, users: {}, queue: [] };
  }
}

async function persist() {
  if (!cache) return;
  await setTrackerKv(STORE_KEY, cache);
}

function pickQueueScreenshotTempPath(item: CloudQueueItem | null | undefined): string | null {
  const tempPath = item?.screenshot?.tempPath;
  return typeof tempPath === 'string' && tempPath.trim().length > 0 ? tempPath : null;
}

async function cleanupSupersededQueuedScreenshot(item: CloudQueueItem | null | undefined, nextTempPath?: string | null): Promise<void> {
  const existingTempPath = pickQueueScreenshotTempPath(item);
  if (!existingTempPath) return;
  if (nextTempPath && existingTempPath === nextTempPath) return;

  try {
    await fs.unlink(existingTempPath);
  } catch {
    // Ignore missing temp files; queue replacement should not fail on cleanup.
  }
}

function getOrCreateUser(userId: string): LocalUserBucket {
  if (!cache) throw new Error('Local store not loaded');
  if (!cache.users[userId]) {
    cache.users[userId] = {
      settings: defaultSettings(),
      runs: [],
    };
  }
  if (!cache.users[userId].settings) cache.users[userId].settings = defaultSettings();
  const parsedSettings = trackerStoredSettingsSchema.safeParse({ ...defaultSettings(), ...cache.users[userId].settings });
  if (!parsedSettings.success) {
    logger.warn(`Invalid local tracker settings payload for ${userId}; resetting to defaults`, parsedSettings.error.flatten());
    cache.users[userId].settings = defaultSettings();
  } else {
    cache.users[userId].settings = parsedSettings.data;
  }
  if (!Array.isArray(cache.users[userId].runs)) cache.users[userId].runs = [];
  if (!cache.users[userId].lifetime || typeof cache.users[userId].lifetime !== 'object') {
    cache.users[userId].lifetime = { entries: [], updatedAt: 0 };
  }
  if (!Array.isArray(cache.users[userId].lifetime.entries)) {
    cache.users[userId].lifetime.entries = [];
  }
  if (!Number.isFinite(cache.users[userId].lifetime.updatedAt)) {
    cache.users[userId].lifetime.updatedAt = 0;
  }
  return cache.users[userId];
}

export async function hasPersistedLocalSettings(userId: string): Promise<boolean> {
  await ensureLoaded();
  return Number.isFinite(Number(cache?.users[userId]?.settings?.updatedAt));
}

export async function listLocalStoreUserIds(): Promise<string[]> {
  await ensureLoaded();
  if (!cache) return [];
  return Object.keys(cache.users);
}

const DISCORD_SNOWFLAKE_USER_ID_PATTERN = /^\d{17,20}$/;

export async function listCloudSyncEnabledUserIds(): Promise<string[]> {
  await ensureLoaded();
  if (!cache) return [];
  const userIds = Object.keys(cache.users).filter((userId) => cache!.users[userId]?.settings?.cloudSyncEnabled !== false);
  if (process.env.DEPLOYMENT_MODE === 'dev') {
    return userIds.filter((userId) => DISCORD_SNOWFLAKE_USER_ID_PATTERN.test(userId));
  }
  return userIds;
}

export async function getLocalSettingsRecord(userId: string): Promise<{ state: TrackerSettings & { cloudSyncEnabled: boolean }; updatedAt: number | null }> {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  return {
    state: { ...defaultSettings(), ...bucket.settings, cloudSyncEnabled: bucket.settings.cloudSyncEnabled !== false },
    updatedAt: Number.isFinite(Number(bucket.settings.updatedAt)) ? Number(bucket.settings.updatedAt) : null,
  };
}

export async function getLocalSettings(userId: string): Promise<TrackerSettings & { cloudSyncEnabled: boolean }> {
  const local = await getLocalSettingsRecord(userId);
  return local.state;
}

export async function updateLocalSettings(userId: string, patch: Partial<TrackerSettings & { cloudSyncEnabled?: boolean; updatedAt?: number }>) {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  const nextUpdatedAt = Number.isFinite(Number(patch.updatedAt)) ? Number(patch.updatedAt) : Date.now();
  const parsed = trackerStoredSettingsSchema.parse({ ...bucket.settings, ...patch, updatedAt: nextUpdatedAt });
  bucket.settings = parsed;
  if (bucket.settings.cloudSyncEnabled === undefined) bucket.settings.cloudSyncEnabled = true;
  await persist();
  return { ...defaultSettings(), ...bucket.settings, cloudSyncEnabled: bucket.settings.cloudSyncEnabled !== false };
}

export async function getLegacyKvRuns(userId: string): Promise<LocalRunRecord[]> {
  await ensureLoaded();
  const bucket = cache?.users[userId];
  if (!bucket || !Array.isArray(bucket.runs)) {
    return [];
  }
  return [...bucket.runs];
}

export async function clearLegacyKvRuns(userId: string): Promise<void> {
  await ensureLoaded();
  const bucket = cache?.users[userId];
  if (!bucket || bucket.runs.length === 0) {
    return;
  }
  bucket.runs = [];
  await persist();
}

export async function getLocalRuns(userId: string): Promise<LocalRunRecord[]> {
  try {
    const rxdbRuns = await rxdbStore.loadLocalRunsFromBotRxDB(userId);
    return rxdbRuns;
  } catch (error) {
    logger.warn('[local-run-store] RxDB read failed; falling back to legacy KV runs', { userId, error });
  }
  return getLegacyKvRuns(userId);
}

export async function getLocalLifetime(userId: string): Promise<LocalLifetimeRecord> {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  return {
    entries: [...bucket.lifetime!.entries],
    updatedAt: bucket.lifetime!.updatedAt,
  };
}

export async function updateLocalLifetime(userId: string, entries: Array<Record<string, unknown>>, updatedAt = Date.now()): Promise<LocalLifetimeRecord> {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  bucket.lifetime = {
    entries: Array.isArray(entries) ? entries : [],
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
  await persist();
  return {
    entries: [...bucket.lifetime.entries],
    updatedAt: bucket.lifetime.updatedAt,
  };
}

export function upsertRunInRunList(
  runs: LocalRunRecord[],
  userId: string,
  username: string,
  runData: Record<string, unknown>,
  now: number,
): { runs: LocalRunRecord[]; record: LocalRunRecord; wasUpdate: boolean } {
  const nextRuns = [...runs];
  const normalizedRunData = canonicalizeTrackerRunData(runData);

  const incoming = {
    ...normalizedRunData,
    userId,
    username,
    localId: String(normalizedRunData?.localId || randomUUID()),
    createdAt: parseEpochMillis(normalizedRunData?.createdAt) || now,
    updatedAt: parseEpochMillis(normalizedRunData?.updatedAt) || parseEpochMillis(normalizedRunData?.reportTimestamp) || now,
  } as LocalRunRecord;

  const byRunIdIndex = incoming.runId
    ? nextRuns.findIndex(r => r.runId && incoming.runId && String(r.runId) === String(incoming.runId))
    : -1;

  let index = byRunIdIndex;
  if (index < 0 && incoming.localId) {
    index = nextRuns.findIndex(r => r.localId === incoming.localId);
  }
  if (index < 0) {
    const incomingImportKeys = buildBattleRunDedupKeysFromStoredRun(incoming);
    if (incomingImportKeys.some(isPopulatedBattleRunDedupKey)) {
      index = nextRuns.findIndex((run) => {
        const existingImportKeys = buildBattleRunDedupKeysFromStoredRun(run);
        return incomingImportKeys.some(key => existingImportKeys.includes(key));
      });
    }
  }
  if (index < 0) {
    const incomingFp = runFingerprint(incoming);
    index = nextRuns.findIndex(r => {
      if (runFingerprint(r) !== incomingFp) return false;
      if (incoming.runId && r.runId && String(r.runId) !== String(incoming.runId)) return false;
      return true;
    });
  }

  if (index >= 0) {
    const existing = nextRuns[index];
    const existingTs = estimateRunTimestamp(existing);
    const incomingTs = estimateRunTimestamp(incoming) || now;
    if (incomingTs >= existingTs) {
      nextRuns[index] = {
        ...existing,
        ...incoming,
        localId: existing.localId || incoming.localId,
        createdAt: existing.createdAt || incoming.createdAt || now,
        updatedAt: incomingTs,
      };
    }
    return { runs: nextRuns, record: nextRuns[index], wasUpdate: true };
  }

  const record = { ...incoming, updatedAt: estimateRunTimestamp(incoming) || now };
  nextRuns.push(record);
  return { runs: nextRuns, record, wasUpdate: false };
}

function upsertRunInBucket(
  bucket: LocalUserBucket,
  userId: string,
  username: string,
  runData: Record<string, unknown>,
  now: number,
): { index: number; wasUpdate: boolean } {
  const merged = upsertRunInRunList(bucket.runs, userId, username, runData, now);
  bucket.runs = merged.runs;
  const index = bucket.runs.findIndex(run => run.localId === merged.record.localId);
  return { index: index >= 0 ? index : bucket.runs.length - 1, wasUpdate: merged.wasUpdate };
}

async function upsertLocalRunViaRxDB(
  userId: string,
  username: string,
  runData: Record<string, unknown>,
): Promise<LocalRunRecord> {
  return rxdbStore.upsertLocalRunIntoBotRxDB(userId, username, runData);
}

export type BulkUpsertLocalRunsResult = {
  added: number;
  updated: number;
  records: LocalRunRecord[];
  wasUpdates: boolean[];
};

async function bulkUpsertLocalRunsViaRxDB(
  userId: string,
  runs: Array<{ username: string; runData: Record<string, unknown> }>,
): Promise<BulkUpsertLocalRunsResult> {
  return rxdbStore.bulkUpsertLocalRunsIntoBotRxDB(userId, runs);
}

export async function upsertLocalRun(userId: string, username: string, runData: Record<string, unknown>): Promise<LocalRunRecord> {
  try {
    return await upsertLocalRunViaRxDB(userId, username, runData);
  } catch (error) {
    logger.warn('[local-run-store] RxDB upsert failed; falling back to legacy KV runs', { userId, error });
  }

  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  const now = Date.now();
  const { index } = upsertRunInBucket(bucket, userId, username, runData, now);
  await persist();
  return bucket.runs[index];
}

export async function bulkUpsertLocalRuns(
  userId: string,
  runs: Array<{ username: string; runData: Record<string, unknown> }>,
): Promise<BulkUpsertLocalRunsResult> {
  if (!runs.length) return { added: 0, updated: 0, records: [], wasUpdates: [] };

  try {
    return await bulkUpsertLocalRunsViaRxDB(userId, runs);
  } catch (error) {
    logger.warn('[local-run-store] RxDB bulk upsert failed; falling back to legacy KV runs', { userId, error });
  }

  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  const now = Date.now();
  let added = 0;
  let updated = 0;
  const records: LocalRunRecord[] = [];
  const wasUpdates: boolean[] = [];

  for (const { username, runData } of runs) {
    const { index, wasUpdate } = upsertRunInBucket(bucket, userId, username, runData, now);
    records.push(bucket.runs[index]);
    wasUpdates.push(wasUpdate);
    if (wasUpdate) updated += 1;
    else added += 1;
  }

  await persist();
  return { added, updated, records, wasUpdates };
}

export async function mergeCloudRuns(userId: string, runs: Array<Record<string, unknown>>): Promise<{ added: number; updated: number }> {
  if (!runs?.length) return { added: 0, updated: 0 };
  return bulkUpsertLocalRuns(
    userId,
    runs.map(run => ({
      username: typeof run.username === 'string' && run.username.trim() ? run.username : 'unknown',
      runData: run,
    })),
  );
}

export type QueueCloudUpsertInput = {
  userId: string;
  username: string;
  runData: Record<string, unknown>;
  canonicalRunData?: Record<string, unknown>;
  screenshot?: { filename: string; contentType?: string | null; tempPath: string } | null;
  localId?: string;
};

async function applyQueueUpsertInMemory(input: QueueCloudUpsertInput): Promise<void> {
  if (!cache) throw new Error('Local store not loaded');
  const normalizedRunData = canonicalizeTrackerRunData(input.runData ?? {});
  const normalizedCanonicalRunData = input.canonicalRunData ? canonicalizeTrackerRunData(input.canonicalRunData) : undefined;
  const targetReference = buildTrackerQueuedRunReferenceIdentity({
    localId: input.localId,
    runData: normalizedRunData,
  });
  const targetLocalId = targetReference.localId ?? undefined;
  const targetRunId = targetReference.runId ?? undefined;
  const nextScreenshotTempPath = typeof input.screenshot?.tempPath === 'string' && input.screenshot.tempPath.trim().length > 0
    ? input.screenshot.tempPath.trim()
    : null;
  if (targetRunId) {
    cache.queue = cache.queue.filter(item => !(item.op === 'delete' && item.userId === input.userId && item.runId === targetRunId));
  }
  const retryState = createRetryScheduleState();
  const nextQueue = replaceOrInsertMatchingItem({
    existingItems: cache.queue,
    matchesExisting: item => {
      if (item.op !== 'upsert' || item.userId !== input.userId) return false;
      return trackerRunReferencesSameEntry({
        left: {
          localId: targetReference.localId,
          runId: targetReference.runId,
        },
        right: buildTrackerQueuedRunReferenceIdentity(item),
      });
    },
    buildItem: previousItem => ({
      id: previousItem?.id ?? randomUUID(),
      op: 'upsert' as const,
      userId: input.userId,
      username: input.username,
      localId: targetLocalId,
      runId: targetRunId,
      runData: normalizedRunData,
      canonicalRunData: normalizedCanonicalRunData,
      screenshot: input.screenshot ?? null,
      createdAt: previousItem?.createdAt ?? Date.now(),
      retryCount: retryState.attemptCount,
      nextRetryAt: retryState.nextRetryAt,
      lastError: undefined,
    }),
  });

  if (nextQueue.previousItem) {
    await cleanupSupersededQueuedScreenshot(nextQueue.previousItem, nextScreenshotTempPath);
  }

  cache.queue = nextQueue.items;
}

export async function queueCloudUpsert(input: QueueCloudUpsertInput) {
  await ensureLoaded();
  await applyQueueUpsertInMemory(input);
  await persist();
}

export async function queueCloudUpsertsBatch(inputs: QueueCloudUpsertInput[]): Promise<void> {
  if (!inputs.length) return;
  await ensureLoaded();
  for (const input of inputs) {
    await applyQueueUpsertInMemory(input);
  }
  await persist();
}

export async function queueCloudDelete(input: { userId: string; username: string; runId: string }) {
  await ensureLoaded();
  const retryState = createRetryScheduleState();
  const nextQueue = enqueueUniqueItemsByKey({
    existingItems: cache!.queue,
    incomingItems: [{
      id: randomUUID(),
      op: 'delete' as const,
      userId: input.userId,
      username: input.username,
      runId: input.runId,
      createdAt: Date.now(),
      retryCount: retryState.attemptCount,
      nextRetryAt: retryState.nextRetryAt,
    }],
    getKey: item => item.op === 'delete' ? `delete:${item.userId}:${item.runId ?? ''}` : item.id,
  });

  if (!nextQueue.changed) {
    return;
  }

  cache!.queue = nextQueue.items;
  await persist();
}

export async function queueCloudSettings(input: {
  userId: string;
  settingsData: TrackerSettings & { cloudSyncEnabled?: boolean; updatedAt?: number };
  settingsUpdatedAt: number;
}) {
  await ensureLoaded();
  const retryState = createRetryScheduleState();
  const parsedSettings = trackerStoredSettingsSchema.parse({
    ...input.settingsData,
    updatedAt: input.settingsUpdatedAt,
  });
  const nextQueue = replaceOrInsertMatchingItem({
    existingItems: cache!.queue,
    matchesExisting: item => item.op === 'settings' && item.userId === input.userId,
    buildItem: previousItem => ({
      id: previousItem?.id ?? randomUUID(),
      op: 'settings' as const,
      userId: input.userId,
      username: input.userId,
      settingsData: parsedSettings,
      settingsUpdatedAt: input.settingsUpdatedAt,
      createdAt: previousItem?.createdAt ?? Date.now(),
      retryCount: retryState.attemptCount,
      nextRetryAt: Date.now() - 1,
      lastError: undefined,
    }),
  });

  cache!.queue = nextQueue.items;

  await persist();
}

export async function getQueueItems(userId?: string): Promise<CloudQueueItem[]> {
  await ensureLoaded();
  const items = cache!.queue;
  if (!userId) return [...items];
  return items.filter(item => item.userId === userId);
}

export async function getQueueCount(userId?: string) {
  const items = await getQueueItems(userId);
  return items.length;
}

export async function markQueueItemFailed(id: string, error: string) {
  await ensureLoaded();
  const idx = cache!.queue.findIndex(item => item.id === id);
  if (idx < 0) return;
  cache!.queue[idx] = applyRetryFailureState({
    item: cache!.queue[idx],
    getAttemptCount: item => item.retryCount,
    updateItem: (item, retryState) => ({
      ...item,
      retryCount: retryState.attemptCount,
      nextRetryAt: retryState.nextRetryAt,
      lastError: error,
    }),
  });
  await persist();
}

export async function releaseQueuedItemsForImmediateRetry(userId: string) {
  await ensureLoaded();
  let changed = false;
  for (const item of cache!.queue) {
    if (item.userId !== userId) continue;
    item.nextRetryAt = Date.now() - 1;
    changed = true;
  }
  if (changed) {
    await persist();
  }
}

export async function removeQueueItem(id: string) {
  await ensureLoaded();
  cache!.queue = cache!.queue.filter(item => item.id !== id);
  await persist();
}

export async function removeLocalRun(userId: string, input: { runId?: string | null; localId?: string | null } | string) {
  const targetReference = typeof input === 'string'
    ? {
        runId: String(input || '').trim() || undefined,
        localId: String(input || '').trim() || undefined,
      }
    : {
        runId: typeof input.runId === 'string' && input.runId.trim().length > 0 ? input.runId.trim() : undefined,
        localId: typeof input.localId === 'string' && input.localId.trim().length > 0 ? input.localId.trim() : undefined,
      };
  if (!targetReference.runId && !targetReference.localId) return;

  try {
    await rxdbStore.removeLocalRunFromBotRxDB(userId, targetReference);
    await ensureLoaded();
    const bucket = getOrCreateUser(userId);
    const before = bucket.runs.length;
    bucket.runs = bucket.runs.filter((run) => !trackerRunReferencesSameEntry({
      left: targetReference,
      right: {
        runId: typeof run.runId === 'string' && run.runId.trim().length > 0 ? run.runId.trim() : undefined,
        localId: typeof run.localId === 'string' && run.localId.trim().length > 0 ? run.localId.trim() : undefined,
      },
    }));
    if (bucket.runs.length !== before) await persist();
    return;
  } catch (error) {
    logger.warn('[local-run-store] RxDB remove failed; falling back to legacy KV runs', { userId, error });
  }

  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  const before = bucket.runs.length;
  bucket.runs = bucket.runs.filter((run) => {
    return !trackerRunReferencesSameEntry({
      left: targetReference,
      right: {
        runId: typeof run.runId === 'string' && run.runId.trim().length > 0 ? run.runId.trim() : undefined,
        localId: typeof run.localId === 'string' && run.localId.trim().length > 0 ? run.localId.trim() : undefined,
      },
    });
  });
  if (bucket.runs.length !== before) await persist();
}
