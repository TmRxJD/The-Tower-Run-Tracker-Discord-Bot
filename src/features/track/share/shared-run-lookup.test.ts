import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ local: vi.fn(), snapshot: vi.fn(), summary: vi.fn(), embed: vi.fn(), settings: vi.fn() }));
vi.mock('../local-run-store', () => ({ getLocalRuns: mocks.local }));
vi.mock('../tracker-api-client', () => ({ getLastRun: mocks.summary, getUserSettings: mocks.settings }));
vi.mock('./share-snapshot-store', () => ({ readShareSnapshot: mocks.snapshot }));
vi.mock('./share-embed', () => ({ buildShareEmbed: mocks.embed }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({runDeltaMode: 'disabled'}) }));
import { resolveSharedRunContext, buildExpandedSharePayload } from './shared-run-lookup';
import { EmbedBuilder } from 'discord.js';
const token = 'S-' + 'a'.repeat(32);
const client = { users: { fetch: vi.fn().mockResolvedValue({username: 'fixture',displayAvatarURL: () => ''}) } };
beforeEach(() => { vi.clearAllMocks(); mocks.settings.mockResolvedValue({shareChart:false}); mocks.summary.mockResolvedValue({allRuns: [],runTypeCounts: {Farming: 99}}); mocks.local.mockResolvedValue([{runId: 'run-9',totalCoins: '0'}]); mocks.snapshot.mockResolvedValue({ref: 'owner:'+token,userId: 'owner',run: {runId: 'run-9',totalCoins: '2.97s'},sharerName: 'fixture',runTypeCounts: {Farming: 10}}); });
it('resolves immutable versions without substituting newer live data and keeps captured counts', async () => {
  const context = await resolveSharedRunContext(client as never, 'owner', token);
  expect(context?.run.totalCoins).toBe('2.97s'); expect(mocks.local).not.toHaveBeenCalled();
  await buildExpandedSharePayload(client as never,'owner',context!);
  expect(mocks.embed.mock.calls[0][0]).toMatchObject({run: {totalCoins: '2.97s'},runTypeCounts: {Farming: 10}});
});
it('fails closed for missing or other-owner version snapshots', async () => {
  mocks.snapshot.mockResolvedValue(null); expect(await resolveSharedRunContext(client as never,'owner',token)).toBeNull();
  mocks.snapshot.mockResolvedValue({ref: 'other:'+token,userId: 'other',run: {}}); expect(await resolveSharedRunContext(client as never,'owner',token)).toBeNull();
  expect(mocks.local).not.toHaveBeenCalled();
});
it('preserves legacy live lookup without editing old posted references', async () => {
  const context = await resolveSharedRunContext(client as never,'owner','run-9');
  expect(context?.run.totalCoins).toBe('0'); expect(mocks.snapshot).not.toHaveBeenCalled();
});
it('preserves the captured cloud comparison when expansion has no complete local cache', async () => {
  const captured = { mode: 'last' as const, baseline: { wave: 100 }, comparisonLabel: 'vs Last Run' };
  mocks.snapshot.mockResolvedValue({ ref: 'owner:'+token, userId: 'owner', run: {runId:'run-9', wave:'200'}, sharerName:'fixture',runTypeCounts:{Farming:132},deltaResult:captured });
  const context = await resolveSharedRunContext(client as never, 'owner', token);
  await buildExpandedSharePayload(client as never, 'owner', context!);
  expect(mocks.embed.mock.calls.at(-1)?.[0].deltaResult).toEqual(captured);
});
it.each([true, false])('keeps capture metadata and the original chart without appending a capture annotation on expansion (verified=%s)', async historyVerified => {
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  mocks.settings.mockResolvedValue({shareChart:true}); mocks.embed.mockReturnValue(new EmbedBuilder().setTitle('Fixture run').setFooter({text:'Existing footer'}));
  mocks.snapshot.mockResolvedValue({ref:'owner:'+token,userId:'owner',run:{runId:'run-9'},sharerName:'fixture',runTypeCounts:{Farming:10},historyVerified,historyCapturedAt:1700000000000,chartBase64:png.toString('base64'),deltaResult:null});
  const context = await resolveSharedRunContext(client as never,'owner',token);
  const expanded = await buildExpandedSharePayload(client as never,'owner',context!);
  expect(context?.historyCapturedAt).toBe(1700000000000);
  expect(expanded.embed.data.footer?.text).toBe(historyVerified ? 'Existing footer' : 'Offline fallback: counts and comparisons use saved history and pending runs.');
  expect(expanded.files).toHaveLength(1); expect(expanded.files[0].attachment).toEqual(png);
  expect(mocks.embed.mock.calls.at(-1)?.[0]).toMatchObject({runTypeCounts:{Farming:10},deltaResult:undefined});
});
