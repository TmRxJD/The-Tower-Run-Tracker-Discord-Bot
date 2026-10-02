import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), identity: vi.fn() }));
vi.mock('../../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ databases: { listDocuments: mocks.list, getDocument: mocks.get } }) }));
vi.mock('./run-cloud-identity', () => ({ resolveBotRunCloudIdentity: mocks.identity }));
import { loadBotCompleteRunCloudDocuments } from './run-cloud-pair-client';

const docs = (owner: string, n: number) => Array.from({ length: n }, (_, i) => ({
  $id: `${owner}-${String(i).padStart(4, '0')}`, userId: owner, type: 'Farming', tier: '22', wave: String(i + 1),
  coins: '100', duration: '1h0m0s', runDate: '2026-10-02', runTime: '01:00',
}));
function fixture(groups: Record<string, ReturnType<typeof docs>>, chunk = 100) {
  mocks.list.mockImplementation(async (_db, _collection, queries: string[]) => {
    const parsed = queries.map(q => JSON.parse(q));
    const owner = parsed.find(q => q.method === 'equal').values[0];
    const rows = groups[owner] ?? [];
    if (parsed.some(q => q.method === 'select')) return { total: rows.length, documents: rows.slice(0, 1) };
    const cursor = parsed.find(q => q.method === 'cursorAfter')?.values[0];
    const offset = cursor ? rows.findIndex(row => row.$id === cursor) + 1 : 0;
    return { total: rows.length, documents: rows.slice(offset, offset + chunk) };
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.identity.mockResolvedValue({ lookupUserIds: ['discord'] });
  mocks.get.mockRejectedValue({ code: 404 });
});
describe('complete bot history reads', () => {
  it('reads all 132 legacy-owned runs across pages without writes', async () => {
    fixture({ discord: docs('discord', 132) });
    const result = await loadBotCompleteRunCloudDocuments('discord');
    expect(result).toHaveLength(132);
    expect(new Set(result.map(d => d.$id)).size).toBe(132);
    expect(mocks.list).toHaveBeenCalledTimes(3); // 100 + 32 + final total check
  });
  it('does not mistake a short partial page for complete history', async () => {
    fixture({ discord: docs('discord', 132) }, 32);
    expect(await loadBotCompleteRunCloudDocuments('discord')).toHaveLength(132);
    expect(mocks.list).toHaveBeenCalledTimes(6);
  });
  it('loads both linked and legacy identities', async () => {
    mocks.identity.mockResolvedValue({ lookupUserIds: ['appwrite', 'discord', 'discord'] });
    fixture({ appwrite: docs('appwrite', 4), discord: docs('discord', 132) });
    expect(await loadBotCompleteRunCloudDocuments('discord')).toHaveLength(136);
  });
  it('rejects an incomplete pagination result', async () => {
    mocks.list.mockResolvedValueOnce({ total: 132, documents: docs('discord', 100) })
      .mockResolvedValueOnce({ total: 132, documents: [] });
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('incomplete');
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('propagates a cloud failure without fabricating an empty history', async () => {
    mocks.list.mockRejectedValue(new Error('fixture unavailable'));
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('fixture unavailable');
  });
  it('rejects repeated pages, invalid records and changing totals', async () => {
    mocks.list.mockResolvedValue({ total: 132, documents: docs('discord', 100) });
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('repeated');
    mocks.list.mockResolvedValue({ total: 1, documents: [{ $id: 42, userId: 'discord' }] });
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('unreadable');
    mocks.list.mockReset().mockResolvedValueOnce({ total: 1, documents: docs('discord', 1) })
      .mockResolvedValueOnce({ total: 2, documents: docs('discord', 1) });
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('changed');
  });
});
