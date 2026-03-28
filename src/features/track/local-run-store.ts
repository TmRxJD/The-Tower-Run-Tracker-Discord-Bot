import { randomUUID } from 'node:crypto';
import { buildTrackerRunFingerprint, canonicalizeTrackerRunData, computeExponentialBackoffMs } from '@tmrxjd/platform/tools';
import { trackerStoredSettingsSchema, type TrackerSettings } from './types';
import { logger } from '../../core/logger';
import { getTrackerKv, setTrackerKv } from '../../services/idb';

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
  shareScreenshot: true,
  shareTier: true,
  shareWave: true,
  shareDuration: true,
  shareKilledBy: true,
  shareTotalCoins: true,
  shareTotalCells: true,
  shareTotalDice: true,
  shareCoinsPerHour: true,
  shareCellsPerHour: true,
  shareDicePerHour: true,
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
  const retryCount = Number.isFinite(Number(record.retryCount)) ? Number(record.retryCount) : null;
  const nextRetryAt = Number.isFinite(Number(record.nextRetryAt)) ? Number(record.nextRetryAt) : undefined;

  if (!userId || !username || createdAt === null || retryCount === null) {
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
      retryCount,
      nextRetryAt,
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
    retryCount,
    nextRetryAt,
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

export async function getLocalRuns(userId: string): Promise<LocalRunRecord[]> {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  return [...bucket.runs];
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

export async function upsertLocalRun(userId: string, username: string, runData: Record<string, unknown>): Promise<LocalRunRecord> {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  const now = Date.now();
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
    ? bucket.runs.findIndex(r => r.runId && incoming.runId && String(r.runId) === String(incoming.runId))
    : -1;

  let index = byRunIdIndex;
  if (index < 0 && incoming.localId) {
    index = bucket.runs.findIndex(r => r.localId === incoming.localId);
  }
  if (index < 0) {
    const incomingFp = runFingerprint(incoming);
    index = bucket.runs.findIndex(r => runFingerprint(r) === incomingFp);
  }

  if (index >= 0) {
    const existing = bucket.runs[index];
    const existingTs = estimateRunTimestamp(existing);
    const incomingTs = estimateRunTimestamp(incoming) || now;
    if (incomingTs >= existingTs) {
      bucket.runs[index] = {
        ...existing,
        ...incoming,
        localId: existing.localId || incoming.localId,
        createdAt: existing.createdAt || incoming.createdAt || now,
        updatedAt: incomingTs,
      };
    }
  } else {
    bucket.runs.push({ ...incoming, updatedAt: estimateRunTimestamp(incoming) || now });
  }

  await persist();
  const result = bucket.runs[index >= 0 ? index : bucket.runs.length - 1];
  return result;
}

export async function mergeCloudRuns(userId: string, runs: Array<Record<string, unknown>>): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const run of runs || []) {
    const before = await getLocalRuns(userId);
    const username = typeof run.username === 'string' && run.username.trim() ? run.username : 'unknown';
    const inserted = await upsertLocalRun(userId, username, run);
    const after = await getLocalRuns(userId);
    const hadBefore = before.some(r => r.localId === inserted.localId || (r.runId && inserted.runId && r.runId === inserted.runId));
    if (hadBefore) updated += 1;
    else if (after.length > before.length) added += 1;
  }
  return { added, updated };
}

export async function queueCloudUpsert(input: {
  userId: string;
  username: string;
  runData: Record<string, unknown>;
  canonicalRunData?: Record<string, unknown>;
  screenshot?: { filename: string; contentType?: string | null; tempPath: string } | null;
  localId?: string;
}) {
  await ensureLoaded();
  const normalizedRunData = canonicalizeTrackerRunData(input.runData ?? {});
  const normalizedCanonicalRunData = input.canonicalRunData ? canonicalizeTrackerRunData(input.canonicalRunData) : undefined;
  cache!.queue.push({
    id: randomUUID(),
    op: 'upsert',
    userId: input.userId,
    username: input.username,
    localId: input.localId,
    runId: typeof normalizedRunData.runId === 'string' ? normalizedRunData.runId : undefined,
    runData: normalizedRunData,
    canonicalRunData: normalizedCanonicalRunData,
    screenshot: input.screenshot ?? null,
    createdAt: Date.now(),
    retryCount: 0,
    nextRetryAt: Date.now(),
  });
  await persist();
}

export async function queueCloudDelete(input: { userId: string; username: string; runId: string }) {
  await ensureLoaded();
  cache!.queue.push({
    id: randomUUID(),
    op: 'delete',
    userId: input.userId,
    username: input.username,
    runId: input.runId,
    createdAt: Date.now(),
    retryCount: 0,
    nextRetryAt: Date.now(),
  });
  await persist();
}

export async function queueCloudSettings(input: {
  userId: string;
  settingsData: TrackerSettings & { cloudSyncEnabled?: boolean; updatedAt?: number };
  settingsUpdatedAt: number;
}) {
  await ensureLoaded();
  const parsedSettings = trackerStoredSettingsSchema.parse({
    ...input.settingsData,
    updatedAt: input.settingsUpdatedAt,
  });
  const existingIndex = cache!.queue.findIndex(item => item.op === 'settings' && item.userId === input.userId);
  const nextItem: CloudQueueItem = {
    id: existingIndex >= 0 ? cache!.queue[existingIndex].id : randomUUID(),
    op: 'settings',
    userId: input.userId,
    username: input.userId,
    settingsData: parsedSettings,
    settingsUpdatedAt: input.settingsUpdatedAt,
    createdAt: existingIndex >= 0 ? cache!.queue[existingIndex].createdAt : Date.now(),
    retryCount: 0,
    nextRetryAt: Date.now() - 1,
    lastError: undefined,
  };

  if (existingIndex >= 0) {
    cache!.queue[existingIndex] = nextItem;
  } else {
    cache!.queue.push(nextItem);
  }

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
  cache!.queue[idx].retryCount += 1;
  cache!.queue[idx].nextRetryAt = Date.now() + computeExponentialBackoffMs({ attemptCount: cache!.queue[idx].retryCount });
  cache!.queue[idx].lastError = error;
  await persist();
}

export async function removeQueueItem(id: string) {
  await ensureLoaded();
  cache!.queue = cache!.queue.filter(item => item.id !== id);
  await persist();
}

export async function removeLocalRun(userId: string, runIdentifier: string) {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  const target = String(runIdentifier || '').trim();
  if (!target) return;
  const before = bucket.runs.length;
  bucket.runs = bucket.runs.filter((run) => {
    const runId = String(run.runId || '').trim();
    const localId = String(run.localId || '').trim();
    return runId !== target && localId !== target;
  });
  if (bucket.runs.length !== before) await persist();
}
