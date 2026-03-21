import { randomUUID } from 'node:crypto';
import { buildTrackerRunFingerprint, computeExponentialBackoffMs } from '@tmrxjd/platform/tools';
import type { TrackerSettings } from './types';
import { getTrackerKv, setTrackerKv } from '../../services/idb';

type SyncOp = 'upsert' | 'delete';

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
  settings: TrackerSettings & { cloudSyncEnabled?: boolean };
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

async function ensureLoaded() {
  if (cache) return;
  const parsed = await getTrackerKv<LocalStoreState>(STORE_KEY);
  if (parsed) {
    const hadLegacyScreenshotPayload = Array.isArray(parsed?.queue)
      ? parsed.queue.some((item) => Boolean((item as { screenshot?: unknown }).screenshot))
      : false;
    const normalizedQueue: CloudQueueItem[] = Array.isArray(parsed?.queue)
      ? parsed.queue.map((item) => ({
          id: item.id,
          op: item.op,
          userId: item.userId,
          username: item.username,
          runId: item.runId,
          localId: item.localId,
          runData: item.runData,
          canonicalRunData: item.canonicalRunData,
          screenshot: item.screenshot,
          createdAt: item.createdAt,
          retryCount: item.retryCount,
          nextRetryAt: Number.isFinite(Number(item.nextRetryAt)) ? Number(item.nextRetryAt) : Date.now(),
          lastError: item.lastError,
        }))
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
  cache.users[userId].settings = { ...defaultSettings(), ...cache.users[userId].settings };
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

export async function getLocalSettings(userId: string): Promise<TrackerSettings & { cloudSyncEnabled: boolean }> {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  return { ...defaultSettings(), ...bucket.settings, cloudSyncEnabled: bucket.settings.cloudSyncEnabled !== false };
}

export async function updateLocalSettings(userId: string, patch: Partial<TrackerSettings & { cloudSyncEnabled?: boolean }>) {
  await ensureLoaded();
  const bucket = getOrCreateUser(userId);
  bucket.settings = { ...bucket.settings, ...patch };
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

  const incoming = {
    ...runData,
    userId,
    username,
    localId: String(runData?.localId || randomUUID()),
    createdAt: parseEpochMillis(runData?.createdAt) || now,
    updatedAt: parseEpochMillis(runData?.updatedAt) || parseEpochMillis(runData?.reportTimestamp) || now,
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
  cache!.queue.push({
    id: randomUUID(),
    op: 'upsert',
    userId: input.userId,
    username: input.username,
    localId: input.localId,
    runId: typeof input.runData.runId === 'string' ? input.runData.runId : undefined,
    runData: input.runData,
    canonicalRunData: input.canonicalRunData,
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
