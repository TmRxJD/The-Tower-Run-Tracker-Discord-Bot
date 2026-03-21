import { randomUUID } from 'node:crypto';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
import { canonicalizeTrackerRunData } from './shared/run-data-normalization';

interface PendingRunRecord {
  token: string;
  userId: string;
  username: string;
  runData: Record<string, unknown>;
  canonicalRunData?: Record<string, unknown> | null;
  screenshot?: { url: string; name?: string; contentType?: string } | null;
  decimalPreference?: string;
  isDuplicate?: boolean;
  runSource?: 'paste' | 'ocr' | 'manual' | 'unknown';
  createdAt: number;
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

export async function createPendingRun(input: Omit<PendingRunRecord, 'token' | 'createdAt'>) {
  await ensureLoaded();
  const token = randomUUID();
  const record: PendingRunRecord = {
    ...input,
    runData: canonicalizeTrackerRunData(input.runData ?? {}),
    canonicalRunData: input.canonicalRunData ? canonicalizeTrackerRunData(input.canonicalRunData) : null,
    token,
    createdAt: Date.now(),
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
  const next = {
    ...current,
    ...patch,
    runData: patch.runData ? canonicalizeTrackerRunData(patch.runData) : current.runData,
    canonicalRunData: patch.canonicalRunData
      ? canonicalizeTrackerRunData(patch.canonicalRunData)
      : (patch.canonicalRunData === null ? null : current.canonicalRunData),
  } as PendingRunRecord;
  cache!.set(token, next);
  await persist();
  return next;
}

export async function deletePendingRun(token: string) {
  await ensureLoaded();
  cache!.delete(token);
  await persist();
}

export async function cleanupStalePendingRuns(maxAgeMs = 1000 * 60 * 60 * 6) {
  await ensureLoaded();
  const cutoff = Date.now() - maxAgeMs;
  let changed = false;
  for (const [token, record] of cache!) {
    if (record.createdAt < cutoff) {
      cache!.delete(token);
      changed = true;
    }
  }
  if (changed) await persist();
}
