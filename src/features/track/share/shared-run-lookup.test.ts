import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ local: vi.fn(), snapshot: vi.fn(), summary: vi.fn(), embed: vi.fn() }));
vi.mock('../local-run-store', () => ({ getLocalRuns: mocks.local }));
vi.mock('../tracker-api-client', () => ({ getLastRun: mocks.summary, getUserSettings: async () => ({shareChart: false}) }));
vi.mock('./share-snapshot-store', () => ({ readShareSnapshot: mocks.snapshot }));
vi.mock('./share-embed', () => ({ buildShareEmbed: mocks.embed }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({runDeltaMode: 'disabled'}) }));
import { resolveSharedRunContext, buildExpandedSharePayload } from './shared-run-lookup';
const token = 'S-' + 'a'.repeat(32);
const client = { users: { fetch: vi.fn().mockResolvedValue({username: 'fixture',displayAvatarURL: () => ''}) } };
beforeEach(() => { vi.clearAllMocks(); mocks.summary.mockResolvedValue({allRuns: [],runTypeCounts: {Farming: 99}}); mocks.local.mockResolvedValue([{runId: 'run-9',totalCoins: '0'}]); mocks.snapshot.mockResolvedValue({ref: 'owner:'+token,userId: 'owner',run: {runId: 'run-9',totalCoins: '2.97s'},sharerName: 'fixture',runTypeCounts: {Farming: 10}}); });
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
