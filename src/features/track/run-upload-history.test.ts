import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cloud: vi.fn(), read: vi.fn(), upsert: vi.fn(), settings: vi.fn(), queue: vi.fn(), tombstones: vi.fn() }));
vi.mock('./run-cloud-pair-client', () => ({ loadBotCompleteRunCloudDocuments: mocks.cloud }));
vi.mock('../../rxdb/run-rxdb-store', async importOriginal => ({ ...await importOriginal<object>(), loadLocalRunsFromBotRxDB: mocks.read, upsertMergedRunsIntoBotRxDB: mocks.upsert }));
vi.mock('./local-run-store', async importOriginal => ({ ...await importOriginal<object>(), getLocalSettings: mocks.settings, getQueueItems: mocks.queue }));
vi.mock('./run-deletion-tombstones', () => ({ getPermanentlyDeletedRunIds: mocks.tombstones }));
import { prepareBotRunUploadHistory, withBotRunSubmissionLock, withBotHistoryDeadline } from './run-upload-history';
import { getLocalRunSummary } from './tracker-api-client';
import { findPotentialDuplicateRun } from './handlers/upload-helpers';
import { buildRunTypeCounts } from './handlers/review-submission-helpers';

type Row = Record<string, unknown>;
let local: Row[];
const cloud = (n = 132) => Array.from({ length: n }, (_, i) => ({
  $id: `run-${i}`, userId: 'owner', username: 'fixture', type: 'Farming', tier: String(i % 22 + 1),
  wave: String(100 + i), coins: '100', duration: '1h0m0s', runDate: '2026-10-02', runTime: '01:00',
}));
beforeEach(() => {
  vi.clearAllMocks(); local = [];
  mocks.settings.mockResolvedValue({ cloudSyncEnabled: true });
  mocks.queue.mockResolvedValue([]); mocks.tombstones.mockResolvedValue(new Set());
  mocks.cloud.mockResolvedValue(cloud());
  mocks.read.mockImplementation(async () => [...local]);
  mocks.upsert.mockImplementation(async (_user, rows: Row[]) => {
    for (const row of rows) {
      const runId = row.runId ?? row.id ?? row.$id;
      const index = local.findIndex(r => r.runId === runId);
      const record = { ...row, runId, localId: `local-${runId}` };
      if (index < 0) local.push(record); else local[index] = record;
    }
  });
});
describe('upload history coordination', () => {
  it('hydrates 132 runs on cold start, checks duplicates and counts retained types across tiers', async () => {
    const history = await prepareBotRunUploadHistory('owner');
    const runs = await history.getRuns();
    expect(await getLocalRunSummary('owner', runs)).toEqual({ totalRuns: 132, runTypeCounts: { Farming: 132 } });
    expect(findPotentialDuplicateRun({ tier: '1', wave: '100', totalCoins: '100', roundDuration: '1h0m0s' }, runs).isDuplicate).toBe(true);
    expect(mocks.upsert.mock.calls.every(call => call[1].length <= 25)).toBe(true);
    local.push({ localId: 'new-local', type: 'Tournament', tier: '11', wave: '900' });
    const after = await getLocalRunSummary('owner', await history.getRuns());
    expect(after).toEqual({ totalRuns: 133, runTypeCounts: { Farming: 132, Tournament: 1 } });
    expect(buildRunTypeCounts({ localSummaryBefore: { totalRuns: 132, runTypeCounts: { Farming: 132 } }, localSummaryAfter: after, canonicalRunData: {}, submitRunData: {}, shouldUpdateExistingRun: false })).toEqual(after.runTypeCounts);
  });
  it('finishes a partially loaded cache and repeated shares retain 132, not cached #1', async () => {
    local = cloud(25).map(row => ({ ...row, runId: row.$id, localId: `local-${row.$id}` }));
    for (let i = 0; i < 2; i++) {
      const history = await prepareBotRunUploadHistory('owner');
      expect((await getLocalRunSummary('owner', await history.getRuns())).runTypeCounts.Farming).toBe(132);
    }
    expect(local).toHaveLength(132);
  });
  it('keeps queued local edits and uploads, excludes stale/deleted entries without deleting them', async () => {
    local = [{ runId: 'stale', localId: 'stale-local', type: 'Farming' },
      { runId: 'pending', localId: 'pending-local', type: 'Tournament' },
      { runId: 'run-0', localId: 'edit-local', type: 'Milestone' }];
    mocks.queue.mockResolvedValue([{ op: 'upsert', runId: 'pending', localId: 'pending-local' }, { op: 'upsert', runId: 'run-0', localId: 'edit-local' }]);
    mocks.cloud.mockResolvedValue([...cloud(2), { $id: 'deleted', deletedAt: '2026-10-02', userId: 'owner' }]);
    const history = await prepareBotRunUploadHistory('owner');
    const counts = await getLocalRunSummary('owner', await history.getRuns());
    expect(counts).toEqual({ totalRuns: 3, runTypeCounts: { Milestone: 1, Tournament: 1, Farming: 1 } });
    expect(local.some(row => row.runId === 'stale')).toBe(true);
  });
  it('cloud failure performs no ingestion or fabricated numbering', async () => {
    mocks.cloud.mockRejectedValue(new Error('fixture cloud offline'));
    await expect(prepareBotRunUploadHistory('owner')).rejects.toThrow('offline');
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(() => buildRunTypeCounts({ localSummaryBefore: { totalRuns: 132, runTypeCounts: { Farming: 132 } }, localSummaryAfter: { totalRuns: 0, runTypeCounts: {} }, canonicalRunData: {}, submitRunData: {}, shouldUpdateExistingRun: false })).toThrow('could not be verified');
  });
  it('local-only settings use local history without any cloud request', async () => {
    mocks.settings.mockResolvedValue({ cloudSyncEnabled: false });
    local = [{ localId: 'local', type: 'Farming' }];
    expect(await (await prepareBotRunUploadHistory('owner')).getRuns()).toHaveLength(1);
    expect(mocks.cloud).not.toHaveBeenCalled();
  });
  it('serializes concurrent submissions so the second sees the first as a duplicate', async () => {
    mocks.cloud.mockResolvedValue([]);
    const candidate = { tier: '22', wave: '900', totalCoins: '100', roundDuration: '1h0m0s', type: 'Farming' };
    const operations: string[] = [];
    const save = () => withBotRunSubmissionLock('owner', async () => {
      const runs = await (await prepareBotRunUploadHistory('owner')).getRuns();
      const duplicate = findPotentialDuplicateRun(candidate, runs);
      operations.push(duplicate.isDuplicate ? 'edit' : 'log');
      if (!duplicate.isDuplicate) local.push({ ...candidate, localId: 'new-run' });
      await new Promise(resolve => setTimeout(resolve, 5));
    });
    await Promise.all([save(), save()]);
    expect(operations).toEqual(['log', 'edit']);
    expect(local).toHaveLength(1);
    await expect(withBotRunSubmissionLock('owner', async () => { throw new Error('fixture failure'); })).rejects.toThrow();
    expect(await withBotRunSubmissionLock('owner', async () => 'released')).toBe('released');
  });
});

describe('bounded history waits', () => {
  it('timeout and rate-limit failures cannot ingest late/partial cloud history', async () => {
    vi.useFakeTimers();
    let resolveCloud!: (rows: Row[]) => void;
    mocks.cloud.mockImplementation(() => new Promise<Row[]>(resolve => { resolveCloud = resolve; }));
    try {
      const rejected = expect(prepareBotRunUploadHistory('owner')).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(45_001); await rejected;
      resolveCloud(cloud()); await Promise.resolve(); await Promise.resolve();
      expect(mocks.upsert).not.toHaveBeenCalled();
      mocks.cloud.mockRejectedValue(Object.assign(new Error('rate limited'), { code: 429 }));
      await expect(prepareBotRunUploadHistory('owner')).rejects.toThrow('rate limited');
      expect(mocks.upsert).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('a timed-out waiter never unlocks its still-active predecessor', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const first = withBotRunSubmissionLock('timeout-owner', () => gate);
    const second = expect(withBotRunSubmissionLock('timeout-owner', async () => 'should not run')).rejects.toThrow('still being saved');
    try {
      await vi.advanceTimersByTimeAsync(60_001); await second;
      const thirdAction = vi.fn(async () => 'third');
      const third = withBotRunSubmissionLock('timeout-owner', thirdAction);
      await Promise.resolve(); await Promise.resolve(); expect(thirdAction).not.toHaveBeenCalled();
      finish(); await first; expect(await third).toBe('third');
      expect(await withBotHistoryDeadline(async () => 'ready', 5)).toBe('ready');
    } finally { finish(); vi.useRealTimers(); }
  });
});
