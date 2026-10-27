import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { bindPreparedShareMessage, clearPreparedShareHistory, preparedShareCheckpoint, prepareShareHistory, resolvePreparedShareHistory } from './prepared-share';
import { performanceTraceIdentity, withPerformanceTrace } from '../../../core/performance-trace';
const rows = Array.from({ length: 1363 }, (_, i) => ({ runId: `run-${i}`, profileId: null, type: 'Farming', wave: `${i}`, killsWithBlackHole: '0', runDate: '2026-10-24', notes: 'private' }));
const input = () => ({ userId: 'owner', messageId: 'message', profileId: null, mode: 'track', checkpoint: 'checkpoint',
  history: { runs: rows, selectedRun: rows[0], verified: true, completeLocal: true, capturedAt: Date.now() } });
const resolve = (token: string, extra = {}) => resolvePreparedShareHistory({ token, userId: 'owner', messageId: 'message', profileId: null, mode: 'track', checkpoint: async () => 'checkpoint', ...extra });
beforeEach(clearPreparedShareHistory);
afterEach(() => vi.useRealTimers());
it('retains every history field, selected run and missing/zero semantics without mutable aliases', async () => {
  const token = prepareShareHistory(input())!;
  const first = (await resolve(token))!;
  expect(first.runs).toEqual(rows); expect(first.selectedRun).toEqual(rows[0]);
  first.runs[0].killsWithBlackHole = '999';
  expect((await resolve(token))!.runs[0].killsWithBlackHole).toBe('0');
  expect((await resolve(token))!.runs[0].missingOptional).toBeUndefined();
});
it.each([
  [{ userId: 'foreign' }, 'user_mismatch'], [{ messageId: 'other' }, 'message_mismatch'],
  [{ profileId: 'alt' }, 'profile_mismatch'], [{ mode: 'lifetime' }, 'mode_mismatch'],
])('reports a closed rejection reason without admitting a mismatched binding %j', async (changed, reason) => {
  const token = prepareShareHistory(input())!; const onDecision = vi.fn(); const checkpoint = vi.fn(async () => 'checkpoint');
  expect(await resolve(token, { ...changed as object, checkpoint, onDecision })).toBeNull();
  expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ reason })); expect(checkpoint).not.toHaveBeenCalled();
  expect(JSON.stringify(onDecision.mock.calls)).not.toContain(token);
  if (reason === 'user_mismatch') expect(onDecision.mock.calls[0][0].cacheAgeMs).toBeUndefined();
});
it('correlates a cache hit with its invocation, distinguishes expiry/missing/change and isolates observer failures', async () => {
  vi.useFakeTimers(); const onDecision = vi.fn();
  let origin: string | undefined;
  const token = await withPerformanceTrace(async () => { origin = performanceTraceIdentity().operationId; return prepareShareHistory(input())!; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await resolve(token, { onDecision })).not.toBeNull();
  expect(onDecision.mock.calls.at(-1)?.[0]).toMatchObject({ reason: 'hit', cacheAgeMs: 1000, originOperationId: origin });
  expect(await resolve(token, { onDecision: () => { throw Error('PRIVATE_OBSERVER'); } })).not.toBeNull();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await resolve(token, { onDecision })).toBeNull(); expect(onDecision.mock.calls.at(-1)?.[0].reason).toBe('expired');
  expect(await resolve(token, { onDecision })).toBeNull(); expect(onDecision.mock.calls.at(-1)?.[0].reason).toBe('missing');
  const changed = prepareShareHistory(input())!;
  expect(await resolve(changed, { checkpoint: async () => 'changed', onDecision })).toBeNull();
  expect(onDecision.mock.calls.at(-1)?.[0].reason).toBe('checkpoint_changed');
  expect(await resolve(changed, { onDecision: () => { throw Error('PRIVATE_OBSERVER'); } })).toBeNull();
});
it.each([{ userId: 'foreign' }, { messageId: 'other' }, { profileId: 'alt' }, { mode: 'lifetime' }])('rejects a mismatched binding before reading caller state %j', async changed => {
  const token = prepareShareHistory(input())!; const checkpoint = vi.fn(async () => 'checkpoint');
  expect(await resolve(token, { ...changed, checkpoint })).toBeNull(); expect(checkpoint).not.toHaveBeenCalled();
});
it('has absolute expiry even when repeatedly used, and refuses late mutation completion', async () => {
  vi.useFakeTimers(); const token = prepareShareHistory(input())!;
  await vi.advanceTimersByTimeAsync(4 * 60_000); expect(await resolve(token)).not.toBeNull();
  await vi.advanceTimersByTimeAsync(60_000); expect(await resolve(token)).toBeNull();
  const next = prepareShareHistory(input())!;
  expect(await resolve(next, { checkpoint: async () => 'changed' })).toBeNull();
  expect(await resolve(next)).toBeNull();
});
it('binds an unpublished snapshot once and does not move it to a different message or owner', async () => {
  const token = prepareShareHistory({ ...input(), messageId: null })!;
  expect(await resolve(token)).toBeNull();
  expect(bindPreparedShareMessage(token, 'foreign', 'message')).toBe(false);
  expect(bindPreparedShareMessage(token, 'owner', 'message')).toBe(true);
  expect(bindPreparedShareMessage(token, 'owner', 'other')).toBe(false);
  expect(await resolve(token)).not.toBeNull();
});
it('invalidates actual content, profile, membership, pending intent and tombstone changes while tolerating transport acknowledgements', () => {
  const row = { runId: 'one', localId: 'draft', runDate: '2026-10-24', totalCoins: '0', profileId: null, updatedAt: 1, createdAt: 1 };
  const fingerprint = preparedShareCheckpoint([row], [], []);
  expect(JSON.parse(preparedShareCheckpoint([{ ...row, localId: 'cloud-id', updatedAt: 2, createdAt: 2, $updatedAt: 'later' }], [], [])).rows[0][1]).toBe(JSON.parse(fingerprint).rows[0][1]);
  for (const patch of [{ totalCoins: '1' }, { notes: 'changed' }, { profileId: 'alt' }]) expect(preparedShareCheckpoint([{ ...row, ...patch }], [], [])).not.toBe(fingerprint);
  expect(preparedShareCheckpoint([], [], [])).not.toBe(fingerprint);
  expect(preparedShareCheckpoint([row], [{ op: 'delete' }], [])).not.toBe(fingerprint);
  expect(preparedShareCheckpoint([row], [], ['one'])).not.toBe(fingerprint);
  expect(preparedShareCheckpoint([{ runId: 'no-date', updatedAt: 1 }], [], [])).not.toBe(preparedShareCheckpoint([{ runId: 'no-date', updatedAt: 2 }], [], []));
});
it('evicts complete old entries at the capacity boundary and keeps the newest full observation', async () => {
  const first = prepareShareHistory(input())!;
  let latest = first;
  for (let i = 0; i < 64; i++) latest = prepareShareHistory(input())!;
  expect(await resolve(first)).toBeNull();
  expect((await resolve(latest))?.runs).toHaveLength(1363);
});
it('accepts partial or complete background hydration of the captured history without accepting new/changed data', async () => {
  const before = preparedShareCheckpoint([], [], [], true);
  const token = prepareShareHistory({ ...input(), checkpoint: before })!;
  expect(await resolve(token, { checkpoint: async () => preparedShareCheckpoint(rows.slice(0, 25), [], [], true) })).not.toBeNull();
  expect(await resolve(token, { checkpoint: async () => preparedShareCheckpoint(rows, [], [], true) })).not.toBeNull();
  expect(await resolve(token, { checkpoint: async () => preparedShareCheckpoint([...rows, {runId:'new-run'}], [], [], true) })).toBeNull();
});
it('invalidates a newly observed revision contradicting the capture even when its values match an older mirror', async () => {
  const old = {runId:'one',runDate:'2026-10-24',totalCoins:'1',updatedAt:1};
  const captured = {...old,totalCoins:'2',updatedAt:2};
  const token=prepareShareHistory({...input(),checkpoint:preparedShareCheckpoint([old],[],[],true),history:{...input().history,runs:[captured],selectedRun:captured}})!;
  expect(await resolve(token,{checkpoint:async()=>preparedShareCheckpoint([old],[],[],true)})).not.toBeNull();
  expect(await resolve(token,{checkpoint:async()=>preparedShareCheckpoint([captured],[],[],true)})).not.toBeNull();
  expect(await resolve(token,{checkpoint:async()=>preparedShareCheckpoint([{...old,updatedAt:3}],[],[],true)})).toBeNull();
});
