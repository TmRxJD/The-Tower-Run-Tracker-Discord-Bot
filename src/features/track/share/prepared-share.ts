import { randomUUID, createHash } from 'node:crypto';
import { buildTrackerResolvedRunReference } from '@tmrxjd/platform/tools';

export type PreparedShareHistory = {
  runs: Record<string, unknown>[];
  selectedRun: Record<string, unknown> | null;
  verified: boolean;
  completeLocal: boolean;
  capturedAt: number;
};
type Entry = { userId: string; messageId: string | null; profileId: string | null; mode: string; checkpoint: string;
  expiresAt: number; data: Buffer; cost: number };
const entries = new Map<string, Entry>();
const TTL_MS = 5 * 60_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
let bytes = 0;
function remove(token: string) { const entry = entries.get(token); if (entry) bytes -= entry.cost; entries.delete(token); }
function prune() { for (const [token, entry] of entries) if (entry.expiresAt <= Date.now()) remove(token); }

/** Full immutable history, bounded by bytes and absolute invocation lifetime; never a global history cache. */
export function prepareShareHistory(input: { userId: string; messageId?: string | null; profileId?: string | null;
  mode: string; checkpoint: string; history: PreparedShareHistory }): string | null {
  prune();
  const data = Buffer.from(JSON.stringify(input.history));
  const cost = data.byteLength + Buffer.byteLength(input.checkpoint);
  if (cost > MAX_ENTRY_BYTES) return null; // Preserve the complete fresh-read fallback; never truncate.
  while (entries.size >= 64 || bytes + cost > MAX_BYTES) remove(entries.keys().next().value!);
  const token = randomUUID();
  entries.set(token, { userId: input.userId, messageId: input.messageId ?? null, profileId: input.profileId ?? null,
    mode: input.mode, checkpoint: input.checkpoint, expiresAt: Date.now() + TTL_MS, data, cost });
  bytes += cost;
  return token;
}
export function bindPreparedShareMessage(token: string, userId: string, messageId: string): boolean {
  prune(); const entry = entries.get(token);
  if (!entry || entry.userId !== userId || !messageId || entry.messageId && entry.messageId !== messageId) return false;
  entry.messageId = messageId; return true;
}
export async function resolvePreparedShareHistory(input: { token: string; userId: string; messageId: string;
  profileId?: string | null; mode: string; checkpoint: () => Promise<string> }): Promise<PreparedShareHistory | null> {
  prune(); const entry = entries.get(input.token);
  if (!entry || entry.userId !== input.userId || entry.messageId !== input.messageId
    || entry.profileId !== (input.profileId ?? null) || entry.mode !== input.mode) return null;
  const checkpoint = await input.checkpoint();
  const history = JSON.parse(entry.data.toString('utf8')) as PreparedShareHistory;
  if (entries.get(input.token) !== entry || entry.expiresAt <= Date.now()
    || checkpoint !== entry.checkpoint && !permitsCapturedHydration(entry.checkpoint, checkpoint, history.runs)) {
    remove(input.token); return null;
  }
  return history;
}

/** Changes to visible data, membership or pending intent invalidate a prepared invocation.
 * Transport revision metadata is excluded; real dates remain when used as chart fallbacks. */
export function preparedShareCheckpoint(runs: readonly Record<string, unknown>[], queue: readonly Record<string, unknown>[], tombstones: readonly string[], cloudEnabled?: boolean): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  const normalized = runs.map((run, index) => {
    const runDate = run.runDate ?? run.date;
    const hasRunDate = typeof runDate === 'string' && Number.isFinite(Date.parse(`${runDate} ${run.runTime ?? run.time ?? ''}`.trim()));
    const value = Object.fromEntries(Object.entries(run).filter(([key]) => !key.startsWith('$') && !['_rev', '_meta', 'updatedAtEpoch'].includes(key)
      && !(hasRunDate && ['updatedAt', 'createdAt'].includes(key)) && !(run.runId && key === 'localId')));
    const ref = buildTrackerResolvedRunReference({ runId: run.runId, localId: run.localId, fallbackRunId: run.id ?? run.$id });
    return [ref.runId ?? ref.localId ?? `unknown-${index}`, createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'),
      String(run.$updatedAt ?? run.updatedAtEpoch ?? run.updatedAt ?? '')];
  }).sort(([a, ah], [b, bh]) => a.localeCompare(b) || ah.localeCompare(bh));
  return JSON.stringify({ rows: normalized, queue: createHash('sha256').update(JSON.stringify(stable(queue))).digest('hex'),
    deleted: [...tombstones].sort(), cloudEnabled });
}
/** Filling an empty/partial mirror from this already captured observation is not a mutation.
 * Never accept a new identity/content absent from both checkpoints, or any vanished prior row. */
function permitsCapturedHydration(beforeText: string, currentText: string, captured: Record<string, unknown>[]): boolean {
  try {
    type Checkpoint = { rows: string[][]; queue: string; deleted: string[]; cloudEnabled?: boolean };
    const before = JSON.parse(beforeText) as Checkpoint, current = JSON.parse(currentText) as Checkpoint;
    const expected = JSON.parse(preparedShareCheckpoint(captured, [], [])) as Checkpoint;
    if (!Array.isArray(before.rows) || !Array.isArray(current.rows) || before.queue !== current.queue
      || JSON.stringify(before.deleted) !== JSON.stringify(current.deleted) || before.cloudEnabled !== current.cloudEnabled) return false;
    const prior = new Map<string, Set<string>>(), expectedValues = new Map<string, Set<string>>();
    const counts = (rows: string[][]) => { const result = new Map<string, number>(); for (const [id] of rows) result.set(id, (result.get(id) ?? 0) + 1); return result; };
    for (const [id, hash, revision = ''] of before.rows) { const values = prior.get(id) ?? new Set<string>(); values.add(`${hash}:${revision}`); prior.set(id, values); }
    for (const [id, hash] of expected.rows) { const values = expectedValues.get(id) ?? new Set<string>(); values.add(hash); expectedValues.set(id, values); }
    const priorCounts = counts(before.rows), expectedCounts = counts(expected.rows), currentCounts = counts(current.rows);
    if ([...priorCounts].some(([id, count]) => (currentCounts.get(id) ?? 0) < count)) return false;
    return current.rows.every(([id, hash, revision = '']) => (expectedValues.get(id)?.has(hash) || prior.get(id)?.has(`${hash}:${revision}`))
      && (currentCounts.get(id) ?? 0) <= Math.max(priorCounts.get(id) ?? 0, expectedCounts.get(id) ?? 0));
  } catch { return false; }
}
export function clearPreparedShareHistory(): void { entries.clear(); bytes = 0; }
