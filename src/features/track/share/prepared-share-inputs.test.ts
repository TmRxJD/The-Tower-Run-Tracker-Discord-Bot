import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ runs: vi.fn(), queue: vi.fn(), settings: vi.fn(), deleted: vi.fn() }));
vi.mock('../local-run-store', () => ({getLocalRuns:mocks.runs,getQueueItems:mocks.queue,getLocalSettings:mocks.settings}));
vi.mock('../run-deletion-tombstones', () => ({getPermanentlyDeletedRunIds:mocks.deleted}));
import { capturePreparedShareCheckpoint } from './prepared-share-inputs';
beforeEach(() => { vi.clearAllMocks();mocks.runs.mockResolvedValue([{runId:'cloud',localId:'draft',runDate:'2026-10-24',totalCoins:'1'}]);mocks.queue.mockResolvedValue([]);mocks.settings.mockResolvedValue({cloudSyncEnabled:true});mocks.deleted.mockResolvedValue(new Set()); });
it('does not invalidate a displayed run when its represented durable intent is acknowledged', async () => {
  mocks.queue.mockResolvedValue([{op:'upsert',automaticRecovery:true,uploadProfileId:null,runId:'cloud',localId:'draft',runData:{totalCoins:'1'}}]);
  const before=await capturePreparedShareCheckpoint('owner');mocks.queue.mockResolvedValue([]);
  expect(await capturePreparedShareCheckpoint('owner')).toBe(before);
});
it('invalidates unrepresented pending content, deletion receipts and local cloud preference changes', async () => {
  const before=await capturePreparedShareCheckpoint('owner');
  mocks.queue.mockResolvedValue([{op:'upsert',automaticRecovery:true,uploadProfileId:null,runId:'pending',runData:{totalCoins:'2'}}]);
  expect(await capturePreparedShareCheckpoint('owner')).not.toBe(before);
  mocks.queue.mockResolvedValue([]);mocks.deleted.mockResolvedValue(new Set(['cloud']));
  expect(await capturePreparedShareCheckpoint('owner')).not.toBe(before);
  mocks.deleted.mockResolvedValue(new Set());mocks.settings.mockResolvedValue({cloudSyncEnabled:false});
  expect(await capturePreparedShareCheckpoint('owner')).not.toBe(before);
});
