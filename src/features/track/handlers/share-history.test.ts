import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn(), snapshot: vi.fn(), settings: vi.fn() }));
vi.mock('../run-upload-history', () => ({ prepareBotRunUploadHistory: mocks.history, withBotRunSubmissionLock: async (_user: string, action: (context: { setStage: () => void }) => Promise<unknown>) => action({ setStage: vi.fn() }) }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(), getUserSettings: mocks.settings }));
vi.mock('../share/share-snapshot-store', () => ({ saveShareSnapshot: mocks.snapshot }));
vi.mock('../share/share-embed-delivery', () => ({ resolveShareEmbedChannelPayload: async (input: object) => input }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: async () => ({ runDeltaMode: 'disabled' }) }));
vi.mock('./error-handlers', () => ({ logError: vi.fn() }));
import { handleTrackMenuShareLast } from './share-handlers';
import { logError } from './error-handlers';
import { setShareableRun } from '../share/share-state';
import { setTrackerFlowMode } from '../flow-mode-store';

const rows = Array.from({ length: 132 }, (_, i) => ({ runId: `run-${i}`, localId: `local-${i}`, type: 'Farming', tier: '22', wave: String(i + 1), totalCoins: '100', roundDuration: '1h0m0s', reportTimestamp: new Date(1700000000000 + i * 1000).toISOString() }));
function interaction() { return { user: { id: 'share-owner', username: 'fixture', displayAvatarURL: () => '' }, client: {}, guildId: null, deferUpdate: vi.fn().mockResolvedValue(undefined), followUp: vi.fn().mockResolvedValue(undefined), channel: { send: vi.fn().mockResolvedValue({}) }, message: { components: [] } }; }
beforeEach(() => {
  vi.clearAllMocks(); setTrackerFlowMode('share-owner', 'track');
  mocks.settings.mockResolvedValue({ shareChart: false }); mocks.runs.mockResolvedValue(rows);
  mocks.history.mockResolvedValue({ getRuns: mocks.runs }); mocks.snapshot.mockResolvedValue(true);
});
describe('verified share history', () => {
  it('refreshes stale #1 while preserving an older selected run and repeated share semantics', async () => {
    setShareableRun('share-owner', { run: rows[0], runTypeCounts: { Farming: 1 }, screenshotUrl: null });
    for (let i = 0; i < 2; i++) {
      const owner = interaction(); await handleTrackMenuShareLast(owner as never);
      expect(owner.channel.send).toHaveBeenCalledOnce();
      const payload = owner.channel.send.mock.calls[0][0] as { embed: { data: { title: string } } };
      expect(payload.embed.data.title).toBe('Farming Run #132');
      expect(mocks.snapshot.mock.calls.at(-1)?.[0].run.runId).toBe('run-0');
    }
    expect(mocks.history).toHaveBeenCalledTimes(2);
  });
  it('shares the newest retained run when no cached selection exists', async () => {
    setShareableRun('share-owner', { run: null as never, runTypeCounts: {}, screenshotUrl: null });
    const owner = interaction(); await handleTrackMenuShareLast(owner as never);
    expect(mocks.snapshot.mock.calls.at(-1)?.[0].run.runId).toBe('run-131');
    expect(owner.channel.send).toHaveBeenCalledOnce();
  });
  it('does not silently replace a deleted cached selection with another run', async () => {
    setShareableRun('share-owner', { run: { runId: 'deleted' }, runTypeCounts: { Farming: 1 }, screenshotUrl: null });
    const owner = interaction(); await handleTrackMenuShareLast(owner as never);
    expect(owner.channel.send).not.toHaveBeenCalled();
    expect(owner.followUp.mock.calls[0][0].content).toContain('no longer in your current history');
  });
  it('cloud failure sends no fabricated numbered share', async () => {
    mocks.history.mockRejectedValue(new Error('fixture cloud unavailable'));
    const owner = interaction(); await handleTrackMenuShareLast(owner as never);
    expect(owner.channel.send).not.toHaveBeenCalled();
    expect(owner.followUp.mock.calls[0][0].content).not.toContain('fixture cloud unavailable');
  });
});

it('preserves the original delivery exception and send stage without echoing its private message', async () => {
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: {} });
  const owner = interaction();
  const error = Object.assign(new Error('PRIVATE_PASTE_TOKEN'), { code: 50013 });
  owner.channel.send.mockRejectedValue(error);
  await handleTrackMenuShareLast(owner as never);
  expect(logError).toHaveBeenCalledWith(owner.client, owner.user, error, 'track_menu_sharelast', null, null, 'send');
  expect(JSON.stringify(owner.followUp.mock.calls)).not.toContain('PRIVATE_PASTE_TOKEN');
});

it('refreshes cached draft metrics after authoritative history hydration', async () => {
  setShareableRun('share-owner', { run: { ...rows[0], totalCoins: '2.97s' }, runTypeCounts: { Farming: 9 } });
  mocks.runs.mockResolvedValue([{ ...rows[0], totalCoins: '0' }, ...rows.slice(1)]);
  const owner = interaction(); await handleTrackMenuShareLast(owner as never);
  const saved = mocks.snapshot.mock.calls.at(-1)?.[0];
  expect(saved.run.totalCoins).toBe('0'); expect(saved.run.runId).toBe('run-0');
  expect(saved.ref).toMatch(/^share-owner:S-[a-f0-9]{32}$/);
  expect(JSON.stringify(owner.channel.send.mock.calls[0][0].embed.data)).not.toContain('2.97s');
});
it('does not attach an unavailable version reference when snapshot persistence fails', async () => {
  mocks.snapshot.mockResolvedValue(false);
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: {} });
  const owner = interaction(); await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).toHaveBeenCalledOnce();
  expect(owner.channel.send.mock.calls[0][0].shareRunRef).toBeNull();
});

it('does not read, snapshot or publish after both acknowledgement attempts fail', async () => {
  const owner = { ...interaction(), deferReply: vi.fn().mockRejectedValue(Object.assign(new Error('PRIVATE_ACK_FAILURE'), { code: 'UND_ERR_CONNECT_TIMEOUT' })) };
  owner.deferUpdate.mockRejectedValue(new Error('PRIVATE_UPDATE_FAILURE'));
  await handleTrackMenuShareLast(owner as never);
  expect(mocks.settings).not.toHaveBeenCalled();
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(owner.channel.send).not.toHaveBeenCalled();
  expect(owner.followUp).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalledWith(owner.client, owner.user, expect.objectContaining({ code: 'UND_ERR_CONNECT_TIMEOUT' }), 'track_menu_sharelast', null, null, 'acknowledge');
});
it('retains a successful deferred-reply fallback before publishing', async () => {
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: {} });
  const owner = { ...interaction(), deferReply: vi.fn().mockResolvedValue(undefined) };
  owner.deferUpdate.mockRejectedValue(new Error('update unavailable'));
  await handleTrackMenuShareLast(owner as never);
  expect(owner.deferReply).toHaveBeenCalledOnce();
  expect(owner.channel.send).toHaveBeenCalledOnce();
});
it('uses an existing acknowledgement without attempting a second one', async () => {
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: {} });
  const owner = { ...interaction(), deferred: true };
  await handleTrackMenuShareLast(owner as never);
  expect(owner.deferUpdate).not.toHaveBeenCalled();
  expect(owner.channel.send).toHaveBeenCalledOnce();
});
