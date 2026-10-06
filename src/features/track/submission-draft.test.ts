import { beforeEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../../services/idb', () => ({ getTrackerKv: storage.read, setTrackerKv: storage.write }));
import { isOwnedLiveSubmissionDraft, submissionDraftVersion } from './submission-draft';
beforeEach(() => { vi.resetModules(); storage.read.mockReset().mockResolvedValue(null); storage.write.mockReset().mockResolvedValue(undefined); });
it('retention persists only a marker and preserves inactivity timestamps, profile and all reviewed fields', async () => {
  const store = await import('./pending-run-store.js');
  const record = await store.createPendingRun({ flowMode: 'track', userId: 'owner', username: 'fixture', uploadProfileId: 'chosen', runData: { wave: '100', notes: 'fixture' }, screenshot: { url: 'https://example.invalid/fixture' } });
  const snapshot = structuredClone(record);
  const retained = await store.retainPendingRunForHistoryRetry(record.token, submissionDraftVersion(record));
  expect(retained).toEqual({ ...snapshot, historyRetryRequired: true });
  expect(retained?.lastActivity).toBe(snapshot.lastActivity);
  expect(storage.write.mock.calls.at(-1)?.[1]).toEqual([retained]);
  expect(await store.retainPendingRunForHistoryRetry(record.token, 'stale')).toBeNull();
});
it('failed durable marker write restores original draft in memory', async () => {
  const store = await import('./pending-run-store.js');
  const record = await store.createPendingRun({ flowMode: 'track', userId: 'owner', username: 'fixture', runData: { wave: '100' } });
  const snapshot = structuredClone(record); storage.write.mockRejectedValueOnce(Error('safe disk failure'));
  await expect(store.retainPendingRunForHistoryRetry(record.token, submissionDraftVersion(record))).rejects.toThrow('disk failure');
  expect(await store.getPendingRun(record.token)).toEqual(snapshot);
});
it('cancel during durable retention cannot resurrect the removed token', async () => {
  const store = await import('./pending-run-store.js');
  const record = await store.createPendingRun({ flowMode: 'track', userId: 'owner', username: 'fixture', runData: { wave: '100' } });
  let finish!: () => void; storage.write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const retaining = store.retainPendingRunForHistoryRetry(record.token, submissionDraftVersion(record));
  await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(2));
  await store.deletePendingRun(record.token); finish(); await retaining;
  expect(await store.getPendingRun(record.token)).toBeNull();
});
it('owner/session/expiry checks use the unchanged five-minute inactivity boundary', () => {
  const now = 1000000, record = { token: 'token', userId: 'owner', createdAt: now - 300000, lastActivity: now - 300000 };
  expect(isOwnedLiveSubmissionDraft(record, 'token', 'owner', now)).toBe(true);
  expect(isOwnedLiveSubmissionDraft(record, 'token', 'owner', now + 1)).toBe(false);
  expect(isOwnedLiveSubmissionDraft(record, 'other-token', 'owner', now)).toBe(false);
  expect(isOwnedLiveSubmissionDraft(record, 'token', 'other-owner', now)).toBe(false);
});

it('durable write intent survives failed token deletion and reload, without retaining a retryable token', async () => {
  const store = await import('./pending-run-store.js'); let durable: unknown = null;
  storage.write.mockImplementation(async (_key, value) => { durable = structuredClone(value); });
  const record = await store.createPendingRun({ flowMode: 'track', userId: 'owner', username: 'fixture', runData: { wave: '100' } });
  const admitted = await store.markPendingRunWriteIntent(record.token, submissionDraftVersion(record));
  expect(admitted?.submissionWriteIntent).toBe(true); expect(admitted?.lastActivity).toBe(record.lastActivity);
  storage.write.mockRejectedValueOnce(Error('safe delete failure'));
  await expect(store.deletePendingRun(record.token)).rejects.toThrow('delete failure');
  expect((await store.getPendingRun(record.token))?.submissionWriteIntent).toBe(true);
  vi.resetModules(); storage.read.mockResolvedValue(durable);
  const reloaded = await import('./pending-run-store.js');
  const restored = await reloaded.getPendingRun(record.token);
  expect(restored?.submissionWriteIntent).toBe(true);
  expect(await reloaded.markPendingRunWriteIntent(record.token, submissionDraftVersion(restored))).toBeNull();
});
it('failed write-intent commit restores the complete original pending input', async () => {
  const store = await import('./pending-run-store.js');
  const record = await store.createPendingRun({ flowMode: 'track', userId: 'owner', username: 'fixture', runData: { wave: '100' }, uploadProfileId: 'chosen' });
  const snapshot = structuredClone(record); storage.write.mockRejectedValueOnce(Error('safe intent failure'));
  await expect(store.markPendingRunWriteIntent(record.token, submissionDraftVersion(record))).rejects.toThrow('intent failure');
  expect(await store.getPendingRun(record.token)).toEqual(snapshot);
});
