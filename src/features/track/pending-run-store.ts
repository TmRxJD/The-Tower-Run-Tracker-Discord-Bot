import { randomUUID } from 'node:crypto';
import { canonicalizeRunData } from '@tmrxjd/platform/tools';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import type { BotProfileOption } from './upload-target-profile';
import { PENDING_RUN_INACTIVITY_MS, submissionDraftVersion } from './submission-draft';

interface PendingRunRecord {
  token: string;
  userId: string;
  username: string;
  runData: Record<string, unknown>;
  canonicalRunData?: Record<string, unknown> | null;
  rawParseFields?: Record<string, unknown> | null;
  screenshot?: { url: string; name?: string; contentType?: string } | null;
  decimalPreference?: string;
  isDuplicate?: boolean;
  defaultRunType?: string;
  profileOptions?: BotProfileOption[];
  uploadProfileId?: string | null;
  pasteDiagnosticId?: string;
  runSource?: 'paste' | 'ocr' | 'manual' | 'unknown';
  historyRetryRequired?: boolean;
  submissionWriteIntent?: boolean;
  flowMode?: 'track' | 'lifetime';
  createdAt: number;
  lastActivity: number;
}

const STORE_KEY = 'tracker-pending-runs:v1';

let cache: Map<string, PendingRunRecord> | null = null;

async function ensureLoaded() {
  if (cache) return;
  cache = new Map();
  const parsed = await getTrackerKv<PendingRunRecord[]>(STORE_KEY);
  if (Array.isArray(parsed)) {
    parsed.forEach(rec => cache!.set(rec.token, rec));
  }
}

async function persist() {
  if (!cache) return;
  const all = Array.from(cache.values());
  await setTrackerKv(STORE_KEY, all);
}

export async function createPendingRun(input: Omit<PendingRunRecord, 'token' | 'createdAt' | 'lastActivity' | 'flowMode'> & { flowMode: 'track' | 'lifetime' }) {
  await ensureLoaded();
  // Purge stale sessions before creating a new one so abandoned flows don't accumulate.
  await cleanupStalePendingRuns();
  const token = randomUUID();
  const now = Date.now();
  const record: PendingRunRecord = {
    ...input,
    flowMode: input.flowMode,
    runData: canonicalizeRunData(input.runData ?? {}),
    canonicalRunData: input.canonicalRunData ? canonicalizeRunData(input.canonicalRunData) : null,
    rawParseFields: input.rawParseFields && typeof input.rawParseFields === 'object' ? { ...input.rawParseFields } : null,
    token,
    createdAt: now,
    lastActivity: now,
  };
  cache!.set(token, record);
  await persist();
  return record;
}

export async function getPendingRun(token: string): Promise<PendingRunRecord | null> {
  await ensureLoaded();
  return cache!.get(token) ?? null;
}

export async function updatePendingRun(token: string, patch: Partial<PendingRunRecord>): Promise<PendingRunRecord | null> {
  await ensureLoaded();
  const current = cache!.get(token);
  if (!current) return null;
  const next: PendingRunRecord = {
    ...current,
    ...patch,
    runData: patch.runData ? canonicalizeRunData(patch.runData) : current.runData,
    canonicalRunData: patch.canonicalRunData
      ? canonicalizeRunData(patch.canonicalRunData)
      : (patch.canonicalRunData === null ? null : current.canonicalRunData),
    rawParseFields: patch.rawParseFields
      ? { ...patch.rawParseFields }
      : (patch.rawParseFields === null ? null : current.rawParseFields),
    lastActivity: Date.now(),
  };
  cache!.set(token, next);
  await persist();
  return next;
}

export async function deletePendingRun(token: string) {
  await ensureLoaded();
  const current = cache!.get(token);
  cache!.delete(token);
  try { await persist(); }
  catch (error) { if (current && !cache!.has(token)) cache!.set(token, current); throw error; }
}

/** Persist admission before calling a write, so an uncertain outcome cannot be replayed after restart. */
export async function markPendingRunWriteIntent(token: string, version: string): Promise<PendingRunRecord | null> {
  await ensureLoaded();
  const current = cache!.get(token);
  if (!current || current.submissionWriteIntent || submissionDraftVersion(current) !== version) return null;
  const next = { ...current, submissionWriteIntent: true };
  cache!.set(token, next);
  try { await persist(); }
  catch (error) { if (cache!.get(token) === next) cache!.set(token, current); throw error; }
  return next;
}

/** Retain only the unchanged draft; do not refresh its original inactivity timestamp. */
export async function retainPendingRunForHistoryRetry(token: string, version: string): Promise<PendingRunRecord | null> {
  await ensureLoaded();
  const current = cache!.get(token);
  if (!current || submissionDraftVersion(current) !== version) return null;
  if (current.historyRetryRequired) return current;
  const next = { ...current, historyRetryRequired: true };
  cache!.set(token, next);
  try { await persist(); }
  catch (error) { if (cache!.get(token) === next) cache!.set(token, current); throw error; }
  return next;
}

export async function cleanupStalePendingRuns(maxInactivityMs = PENDING_RUN_INACTIVITY_MS) {
  await ensureLoaded();
  const cutoff = Date.now() - maxInactivityMs;
  let changed = false;
  for (const [token, record] of cache!) {
    const lastActive = record.lastActivity ?? record.createdAt;
    if (lastActive < cutoff) {
      cache!.delete(token);
      changed = true;
    }
  }
  if (changed) await persist();
}
