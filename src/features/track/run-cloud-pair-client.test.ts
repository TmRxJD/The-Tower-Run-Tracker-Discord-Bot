import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), identity: vi.fn() }));
vi.mock('../../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ databases: { listDocuments: mocks.list, getDocument: mocks.get } }) }));
vi.mock('./run-cloud-identity', () => ({ resolveBotRunCloudIdentity: mocks.identity }));
import { loadBotCompleteRunCloudDocuments, writeBotRunCloudDocumentPair } from './run-cloud-pair-client';
import { readHistoryFailure } from './history-failure-diagnostic';

const docs = (owner: string, n: number) => Array.from({ length: n }, (_, i) => ({
  $id: `${owner}-${String(i).padStart(4, '0')}`, userId: owner, type: 'Farming', tier: '22', wave: String(i + 1),
  coins: '100', duration: '1h0m0s', runDate: '2026-10-02', runTime: '01:00',
}));
function fixture(groups: Record<string, Array<{ $id: string; userId: string; [key: string]: unknown }>>, chunk = Infinity) {
  mocks.list.mockImplementation(async (_db, _collection, queries: string[]) => {
    const parsed = queries.map(q => JSON.parse(q));
    const owner = parsed.find(q => q.method === 'equal').values[0];
    const rows = groups[owner] ?? [];
    if (parsed.some(q => q.method === 'select')) return { total: rows.length, documents: rows.slice(0, 1) };
    const cursor = parsed.find(q => q.method === 'cursorAfter')?.values[0];
    const offset = cursor ? rows.findIndex(row => row.$id === cursor) + 1 : 0;
    return { total: rows.length, documents: rows.slice(offset, offset + Math.min(chunk, parsed.find(q => q.method === 'limit')?.values[0] ?? 100)) };
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.identity.mockResolvedValue({ lookupUserIds: ['discord'] });
  mocks.get.mockRejectedValue({ code: 404 });
});
describe('complete bot history reads', () => {
  it.each([
    [{ total: 1, documents: 'PRIVATE' }, 'schema'],
    [{ total: 2, documents: [] }, 'pagination'],
    [{ total: 2, documents: [...docs('discord', 1), ...docs('discord', 1)] }, 'pagination'],
  ])('labels rejected main pages without emitting their content %#', async (page, cause) => {
    mocks.list.mockResolvedValue(page);
    const error = await loadBotCompleteRunCloudDocuments('discord').catch(error => error);
    expect(readHistoryFailure(error)).toMatchObject({ cause, stage: 'main_page' });
    expect(JSON.stringify(readHistoryFailure(error))).not.toContain('PRIVATE');
  });
  it('labels a changed final count distinctly from malformed records', async () => {
    mocks.list.mockResolvedValueOnce({ total: 1, documents: docs('discord', 1) }).mockResolvedValueOnce({ total: 2, documents: [] }).mockResolvedValueOnce({ total: 1, documents: docs('discord', 1) }).mockResolvedValueOnce({ total: 2, documents: [] });
    const error = await loadBotCompleteRunCloudDocuments('discord').catch(error => error);
    expect(readHistoryFailure(error)).toMatchObject({ cause: 'count_consistency', stage: 'main_count' });
  });
  it('labels SDK failures with safe status and the actual request stage', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('PRIVATE_HTTP_BODY'), { code: 429, response: 'PRIVATE_HTTP_BODY' }));
    const error = await loadBotCompleteRunCloudDocuments('discord').catch(error => error);
    expect(readHistoryFailure(error)).toMatchObject({ cause: 'http_status', status: 429, stage: 'main_page' });
    expect(JSON.stringify(readHistoryFailure(error))).not.toContain('PRIVATE_HTTP_BODY');
    mocks.list.mockRejectedValue(Object.assign(new Error('PRIVATE_SOCKET_BODY'), { code: 'ECONNRESET' }));
    const transport = await loadBotCompleteRunCloudDocuments('discord').catch(error => error);
    expect(readHistoryFailure(transport)).toMatchObject({ cause: 'transport', transportCode: 'ECONNRESET', stage: 'main_page' });
    expect(JSON.stringify(readHistoryFailure(transport))).not.toContain('PRIVATE_SOCKET_BODY');
  });
  it('completes a 1359-run, one-second-per-request lookup in eight seconds with bounded waves', async () => {
    vi.useFakeTimers();
    fixture({ discord: docs('discord', 1359) });
    const main = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (db, collection, queries: string[]) => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (collection !== 'runs_extended_data') return main(db, collection, queries);
      const ids: string[] = queries.map(q => JSON.parse(q)).find(q => q.method === 'equal').values;
      return { total: ids.length, documents: ids.map($id => ({ $id, userId: 'discord' })) };
    });
    try {
      const start = Date.now(); const pending = loadBotCompleteRunCloudDocuments('discord');
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toHaveLength(1359); expect(Date.now() - start).toBe(8_000);
      expect(mocks.list).toHaveBeenCalledTimes(18); expect(mocks.get).not.toHaveBeenCalled();
      expect(15 + Math.ceil(1359 / 25)).toBe(70); // Old sequential GET batch waves plus main reads.
    } finally { vi.useRealTimers(); }
  });
  it('stops issuing new pages when a slow SDK call finishes after the deadline', async () => {
    vi.useFakeTimers(); fixture({ discord: docs('discord', 132) });
    const list = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (...args) => { await new Promise(resolve => setTimeout(resolve, 46_000)); return list(...args); });
    try {
      let failure: unknown;
      const rejected = expect(loadBotCompleteRunCloudDocuments('discord').catch(error => { failure = error; throw error; })).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(46_001); await rejected;
      expect(readHistoryFailure(failure)).toMatchObject({ cause: 'timeout', stage: 'main_page' });
      expect(mocks.list).toHaveBeenCalledOnce(); expect(mocks.get).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each([{ userId: 'foreign' }, { profileId: 'foreign-profile' }])('rejects foreign extended ownership/profile metadata %j', async fields => {
    fixture({ discord: docs('discord', 1) }); const list = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (db, collection, queries) => collection === 'runs_extended_data'
      ? { total: 1, documents: [{ $id: 'discord-0000', ...fields }] } : list(db, collection, queries));
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('could not be verified');
  });
  it('preserves Main and Alt values for linked and legacy owners, allowing genuinely missing extended rows', async () => {
    mocks.identity.mockResolvedValue({ lookupUserIds: ['appwrite', 'discord'] });
    fixture({ appwrite: [{ ...docs('appwrite', 1)[0], profileId: 'alt-a' }], discord: docs('discord', 1) });
    const list = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (db, collection, queries) => collection === 'runs_extended_data'
      ? { total: 1, documents: [{ $id: 'appwrite-0000', userId: 'appwrite', profileId: 'alt-a', shockwaveDamage: '0' }] } : list(db, collection, queries));
    const runs = await loadBotCompleteRunCloudDocuments('discord');
    expect(runs.find(row => row.$id === 'appwrite-0000')?.profileId).toBe('alt-a');
    expect(runs.find(row => row.$id === 'discord-0000')?.shockwaveDamage).toBeUndefined();
  });
  it('loads 1359 runs with partial extended pages in bounded bulk queries and no individual GETs', async () => {
    const rows = docs('discord', 1359);
    fixture({ discord: rows });
    const main = mocks.list.getMockImplementation()!;
    mocks.list.mockImplementation(async (db, collection, queries: string[]) => {
      if (collection !== 'runs_extended_data') return main(db, collection, queries);
      const parsed = queries.map(q => JSON.parse(q));
      const ids: string[] = parsed.find(q => q.method === 'equal').values;
      const cursor = parsed.find(q => q.method === 'cursorAfter')?.values[0];
      const offset = cursor ? ids.indexOf(cursor) + 1 : 0;
      return { total: ids.length, documents: ids.slice(offset, offset + 32).map($id => ({ $id, userId: 'discord', shockwaveDamage: '0' })) };
    });
    const runs = await loadBotCompleteRunCloudDocuments('discord');
    expect(runs).toHaveLength(1359); expect(runs.every(run => run.shockwaveDamage === '0')).toBe(true);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(58); //4 main pages/check +54 short extended pages.
  });
  it('rejects foreign, repeated and prematurely empty extended result pages', async () => {
    for (const pages of [
      [{ total: 1, documents: [{ $id: 'foreign' }] }],
      [{ total: 2, documents: [{ $id: 'discord-0000' }] }, { total: 2, documents: [{ $id: 'discord-0000' }] }],
      [{ total: 2, documents: [] }],
    ]) {
      fixture({ discord: docs('discord', 2) });
      const main = mocks.list.getMockImplementation()!; let i = 0;
      mocks.list.mockImplementation(async (db, collection, queries) => collection === 'runs_extended_data' ? pages[i++] : main(db, collection, queries));
      await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('Extended run history');
    }
  });
  it('rejects incomplete direct new cloud writes before writing either document', async () => {
    await expect(writeBotRunCloudDocumentPair({userId:'discord', username:'fixture', runId:'new-direct-fixture', run:{tier:'5',wave:'321'}, uploadProfileId:null})).rejects.toThrow('required fields');
    expect(mocks.get).toHaveBeenCalledOnce();
  });
  it('reads all 132 legacy-owned runs across pages without writes', async () => {
    fixture({ discord: docs('discord', 132) });
    const result = await loadBotCompleteRunCloudDocuments('discord');
    expect(result).toHaveLength(132);
    expect(new Set(result.map(d => d.$id)).size).toBe(132);
    expect(mocks.list).toHaveBeenCalledTimes(4); // Main page/check and two bounded extended queries.
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('does not mistake a short partial page for complete history', async () => {
    fixture({ discord: docs('discord', 132) }, 32);
    expect(await loadBotCompleteRunCloudDocuments('discord')).toHaveLength(132);
    expect(mocks.list).toHaveBeenCalledTimes(8);
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
      .mockResolvedValueOnce({ total: 2, documents: docs('discord', 1) })
      .mockResolvedValueOnce({ total: 1, documents: docs('discord', 1) })
      .mockResolvedValueOnce({ total: 2, documents: docs('discord', 1) });
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('changed');
  });
});

it.each([102, 100])('investigation: rejects a changed total on a later main page (%i) without fetching extended data', async changedTotal => {
  mocks.list.mockResolvedValueOnce({ total: 101, documents: docs('discord', 101).slice(0, 100) })
    .mockResolvedValueOnce({ total: changedTotal, documents: docs('discord', 101).slice(100) }).mockResolvedValueOnce({ total: 101, documents: docs('discord', 101).slice(0, 100) }).mockResolvedValueOnce({ total: changedTotal, documents: docs('discord', 101).slice(100) });
  const error = await loadBotCompleteRunCloudDocuments('discord').catch(error => error);
  expect(readHistoryFailure(error)).toMatchObject({ cause: 'count_consistency', stage: 'main_page' });
  expect(mocks.list).toHaveBeenCalledTimes(4);
  expect(mocks.get).not.toHaveBeenCalled();
});


describe('one fresh bounded consistency retry', () => {
  it('discards first attempt rows and starts without its cursor after changing page totals', async () => {
    const fresh = docs('discord', 2).map((row, i) => ({ ...row, $id: `fresh-${i}` }));
    mocks.list.mockResolvedValueOnce({ total: 101, documents: docs('discord', 101).slice(0, 100) })
      .mockResolvedValueOnce({ total: 102, documents: docs('discord', 101).slice(100) })
      .mockResolvedValueOnce({ total: 2, documents: fresh })
      .mockResolvedValueOnce({ total: 2, documents: fresh.slice(0, 1) })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    const result = await loadBotCompleteRunCloudDocuments('discord');
    expect(result.map(row => row.$id)).toEqual(['fresh-0', 'fresh-1']);
    expect(mocks.identity).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenCalledTimes(5);
    expect(mocks.list.mock.calls[2][2].map((q: string) => JSON.parse(q)).some((q: { method: string }) => q.method === 'cursorAfter')).toBe(false);
  });
  it('retries a changed final count from a fresh complete read', async () => {
    const fresh = [{ ...docs('discord', 1)[0], $id: 'fresh-final' }];
    mocks.list.mockResolvedValueOnce({ total: 1, documents: docs('discord', 1) })
      .mockResolvedValueOnce({ total: 2, documents: [] })
      .mockResolvedValueOnce({ total: 1, documents: fresh })
      .mockResolvedValueOnce({ total: 1, documents: fresh })
      .mockResolvedValueOnce({ total: 0, documents: [] });
    expect((await loadBotCompleteRunCloudDocuments('discord'))[0].$id).toBe('fresh-final');
    expect(mocks.identity).toHaveBeenCalledTimes(2);
  });
  it('does not retry schema, ownership, repeated-page or SDK transport failures', async () => {
    for (const page of [{ total: 1, documents: [{ $id: 'wrong', userId: 'other' }] }, { total: -1, documents: [] }]) {
      mocks.list.mockReset().mockResolvedValue(page); mocks.identity.mockClear();
      await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow();
      expect(mocks.identity).toHaveBeenCalledOnce();
    }
    mocks.list.mockReset().mockRejectedValue({ code: 'ETIMEDOUT' }); mocks.identity.mockClear();
    await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(mocks.identity).toHaveBeenCalledOnce();
  });
  it('cancellation after a changed-total response prevents another attempt', async () => {
    const cancellation = new AbortController();
    mocks.list.mockResolvedValueOnce({ total: 101, documents: docs('discord', 101).slice(0, 100) })
      .mockImplementationOnce(async () => { cancellation.abort(); return { total: 102, documents: docs('discord', 101).slice(100) }; });
    await expect(loadBotCompleteRunCloudDocuments('discord', { signal: cancellation.signal })).rejects.toThrow('cancelled');
    expect(mocks.list).toHaveBeenCalledTimes(2); expect(mocks.identity).toHaveBeenCalledOnce();
  });
  it('shares the original 45s deadline across retry and starts no request after late completion', async () => {
    const { withBotHistoryDeadline } = await import('./run-upload-history.js');
    vi.useFakeTimers();
    mocks.list.mockResolvedValueOnce({ total: 1, documents: docs('discord', 1) })
      .mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 20_000)); return { total: 2, documents: [] }; })
      .mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 26_000)); return { total: 1, documents: docs('discord', 1) }; });
    try {
      const job = loadBotCompleteRunCloudDocuments('discord');
      const final = job.catch(error => error);
      const caller = expect(withBotHistoryDeadline(() => job, 45_000)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(45_001); await caller;
      expect(mocks.list).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1000);
      expect(readHistoryFailure(await final)).toMatchObject({ cause: 'timeout', stage: 'main_page' });
      expect(mocks.list).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

it('bounds extended concurrency and drains a failed wave before rejecting without starting another', async () => {
  fixture({ discord: docs('discord', 900) }); const main = mocks.list.getMockImplementation()!;
  let active = 0, peak = 0, extendedCalls = 0;
  mocks.list.mockImplementation(async (db, collection, queries) => {
    if (collection !== 'runs_extended_data') return main(db, collection, queries);
    const index = extendedCalls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, index === 0 ? 1 : 10)); active--;
    if (index === 0) throw Object.assign(new Error('fixture'), { code: 503 });
    return { total: 0, documents: [] };
  });
  await expect(loadBotCompleteRunCloudDocuments('discord')).rejects.toThrow('fixture');
  expect(peak).toBe(4); expect(active).toBe(0); expect(extendedCalls).toBe(4);
});
