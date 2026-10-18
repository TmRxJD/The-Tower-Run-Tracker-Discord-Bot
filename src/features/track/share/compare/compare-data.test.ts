import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ local: vi.fn(), settings: vi.fn(), identity: vi.fn(), list: vi.fn(), selected: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../local-run-store', () => ({ getLocalRuns: mock.local, getLocalSettings: mock.settings }));
vi.mock('../../run-cloud-identity', () => ({ resolveBotRunCloudIdentity: mock.identity }));
vi.mock('../../run-cloud-pair-client', () => ({ fetchBotStitchedRunCloudDocumentsByIds: mock.selected }));
vi.mock('../../../../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ databases: { listDocuments: mock.list } }) }));
vi.mock('../share-snapshot-store', () => ({ readShareSnapshot: mock.snapshot }));
import { loadCompareChoices, loadSharedCompareSnapshot, readOwnedCompareRun, type CompareChoice } from './compare-data';
import { buildShareSnapshotRef } from '../share-run-ref';

const choice: CompareChoice = { source: 'cloud', id: 'run-1', runId: 'run-1', profileId: null, preview: {} };
describe('comparison data ownership and bounded reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.local.mockResolvedValue([]);
    mock.settings.mockResolvedValue({ cloudSyncEnabled: true });
    mock.identity.mockResolvedValue({ lookupUserIds: ['account-owner', 'viewer'], cloudWriteUserId: 'account-owner' });
    mock.list.mockResolvedValue({ documents: [], total: 0 });
  });
  it('requires a correctly owner-bound captured shared snapshot and never falls back to the sharer history', async () => {
    mock.snapshot.mockResolvedValue({ ref: 'sharer:S-' + 'a'.repeat(32), userId: 'other', sharerName: 'Alice', run: { wave: 'secret' } });
    expect(await loadSharedCompareSnapshot('sharer:S-' + 'a'.repeat(32))).toBeNull();
    mock.snapshot.mockResolvedValue(null);
    expect(await loadSharedCompareSnapshot('sharer:old')).toBeNull();
    expect(mock.local).not.toHaveBeenCalled();
    expect(mock.list).not.toHaveBeenCalled();
  });
  it('uses scoped local choices without any cloud history or identity read', async () => {
    mock.local.mockResolvedValue([{ localId: 'mine', userId: 'viewer', wave: '100' }, { localId: 'foreign', userId: 'other' }]);
    const result = await loadCompareChoices('viewer');
    expect(result.choices.map(item => item.id)).toEqual(['mine']);
    expect(mock.identity).not.toHaveBeenCalled();
    expect(mock.list).not.toHaveBeenCalled();
  });
  it('returns the immutable posted version and rejects a changed snapshot behind its original reference', async () => {
    const run = { runId: 'run-1', wave: '100' }, runTypeCounts = { Farming: 5 };
    const ref = buildShareSnapshotRef('sharer', run, runTypeCounts)!;
    mock.snapshot.mockResolvedValue({ ref, userId: 'sharer', sharerName: 'Alice', run, runTypeCounts });
    expect(await loadSharedCompareSnapshot(ref)).toMatchObject({ run: { wave: '100' } });
    mock.snapshot.mockResolvedValue({ ref, userId: 'sharer', sharerName: 'Alice', run: { ...run, wave: '200' }, runTypeCounts });
    expect(await loadSharedCompareSnapshot(ref)).toBeNull();
  });
  it('returns a useful unlinked/no-runs state and bounds the cloud chooser to main records', async () => {
    mock.identity.mockResolvedValue({ lookupUserIds: ['viewer'], cloudWriteUserId: null });
    expect(await loadCompareChoices('viewer')).toMatchObject({ choices: [], unlinked: true, recentOnly: true });
    expect(mock.list).toHaveBeenCalledTimes(1);
    expect(mock.list.mock.calls[0][1]).toBe('runs');
    expect(mock.list.mock.calls[0][2].map((value: string) => JSON.parse(value))).toContainEqual(expect.objectContaining({ method: 'limit', values: [100] }));
  });
  it('never cloud-reads when the owner has cloud sync disabled', async () => {
    mock.settings.mockResolvedValue({ cloudSyncEnabled: false });
    expect((await loadCompareChoices('viewer')).choices).toEqual([]);
    expect(mock.list).not.toHaveBeenCalled();
    expect(await readOwnedCompareRun('viewer', choice)).toBeNull();
  });
  it('accepts validated owner-bound main records for a linked user with no bot cache', async () => {
    mock.list.mockResolvedValueOnce({ documents: [{ $id: 'run-1', userId: 'account-owner', tier: '10', wave: '100' }], total: 1 });
    const result = await loadCompareChoices('viewer');
    expect(result.choices).toEqual([expect.objectContaining({ source: 'cloud', id: 'run-1', runId: 'run-1' })]);
    expect(mock.selected).not.toHaveBeenCalled();
  });
  it('rejects a foreign owner returned from a scoped cloud query before displaying choices', async () => {
    mock.list.mockResolvedValueOnce({ documents: [{ $id: 'foreign', userId: 'someone-else', wave: '999999' }], total: 1 });
    await expect(loadCompareChoices('viewer')).rejects.toThrow('ownership');
  });
  it.each([
    [{ $id: 'run-1', userId: 'other' }], [{ $id: 'run-2', userId: 'account-owner' }],
    [{ $id: 'run-1', userId: 'account-owner', profileId: 'moved' }],
    [{ $id: 'run-1', userId: 'account-owner', deletedAt: '2026-10-15' }], [],
  ].map(rows => ({ rows })))('rejects missing, changed-owner, changed-profile or deleted selected records', async ({ rows }) => {
    mock.selected.mockResolvedValue(rows);
    expect(await readOwnedCompareRun('viewer', choice)).toBeNull();
    expect(mock.selected).toHaveBeenCalledWith(['run-1']);
  });
  it('reads fresh selected cloud data exactly once, instead of a stale chooser preview', async () => {
    mock.selected.mockResolvedValue([{ $id: 'run-1', userId: 'account-owner', totalCoins: '200' }]);
    expect(await readOwnedCompareRun('viewer', choice)).toMatchObject({ totalCoins: '200' });
    expect(mock.list).not.toHaveBeenCalled();
  });
  it('rechecks local-only ownership/deletion and uses current local values', async () => {
    const local = { ...choice, source: 'local' as const, id: 'local-1', runId: undefined };
    mock.local.mockResolvedValue([{ localId: 'local-1', userId: 'viewer', totalCoins: 0 }]);
    expect(await readOwnedCompareRun('viewer', local)).toMatchObject({ totalCoins: 0 });
    mock.local.mockResolvedValue([{ localId: 'local-1', userId: 'someone-else' }]);
    expect(await readOwnedCompareRun('viewer', local)).toBeNull();
    expect(mock.selected).not.toHaveBeenCalled();
  });
  it('propagates read failure instead of presenting stale private values', async () => {
    mock.selected.mockRejectedValue(new Error('Cloud unavailable'));
    await expect(readOwnedCompareRun('viewer', choice)).rejects.toThrow('Cloud unavailable');
  });
});
