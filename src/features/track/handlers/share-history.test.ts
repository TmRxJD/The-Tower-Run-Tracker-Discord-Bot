import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ history: vi.fn(), runs: vi.fn(), snapshot: vi.fn(), settings: vi.fn(), sharedSettings: vi.fn(), checkpoint: vi.fn() }));
const perfLog = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../../../core/logger', () => ({ logger: perfLog }));
vi.mock('../share/prepared-share-inputs', async original => ({ ...await original<object>(), capturePreparedShareCheckpoint: mocks.checkpoint }));
vi.mock('../run-upload-history', () => ({ prepareBotRunUploadHistory: mocks.history, withBotRunSubmissionLock: async (_user: string, action: (context: { setStage: () => void }) => Promise<unknown>) => action({ setStage: vi.fn() }) }));
vi.mock('../tracker-api-client', async importOriginal => ({ ...await importOriginal<object>(), getUserSettings: mocks.settings }));
vi.mock('../share/share-snapshot-store', () => ({ saveShareSnapshot: mocks.snapshot }));
vi.mock('../share/share-embed-delivery', () => ({ resolveShareEmbedChannelPayload: async (input: object) => input }));
vi.mock('../../../services/user-shared-settings-db', () => ({ getEffectiveUserSharedSettings: mocks.sharedSettings }));
vi.mock('./error-handlers', () => ({ logError: vi.fn() }));
import { handleTrackMenuShareLast } from './share-handlers';
import { logError } from './error-handlers';
import { setShareableRun } from '../share/share-state';
import { setTrackerFlowMode } from '../flow-mode-store';
import { clearPreparedShareHistory, prepareShareHistory } from '../share/prepared-share';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { setPendingUploadProfile } from '../upload-target-profile';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';

const rows = Array.from({ length: 132 }, (_, i) => ({ runId: `run-${i}`, localId: `local-${i}`, type: 'Farming', tier: '22', wave: String(i + 1), totalCoins: '100', roundDuration: '1h0m0s', reportTimestamp: new Date(1700000000000 + i * 1000).toISOString() }));
function interaction() { return { user: { id: 'share-owner', username: 'fixture', displayAvatarURL: () => '' }, client: {}, guildId: null, deferUpdate: vi.fn().mockResolvedValue(undefined), followUp: vi.fn().mockResolvedValue(undefined), channel: { send: vi.fn().mockResolvedValue({}) }, message: { components: [] } }; }
beforeEach(() => {
  vi.clearAllMocks(); setTrackerFlowMode('share-owner', 'track');
  clearPreparedShareHistory(); setPendingUploadProfile('share-owner', null); mocks.checkpoint.mockResolvedValue('unchanged');
  mocks.sharedSettings.mockResolvedValue({ runDeltaMode: 'disabled' });
  mocks.settings.mockResolvedValue({ shareChart: false }); mocks.runs.mockResolvedValue(rows);
  mocks.history.mockResolvedValue({ getRuns: mocks.runs }); mocks.snapshot.mockResolvedValue(true);
});

function preparedInteraction(snapshotRows = rows) {
  const owner = { ...interaction(), message: { id: 'source-result', components: [] }, customId: '' };
  const token = prepareShareHistory({ userId: owner.user.id, messageId: 'source-result', profileId: null, mode: 'track', checkpoint: 'unchanged',
    history: { runs: snapshotRows, selectedRun: snapshotRows[0], verified: true, completeLocal: true, capturedAt: Date.now() } })!;
  owner.customId = withToken(TRACKER_IDS.flow.preparedSharePrefix, token);
  return owner;
}
it('shares a complete prepared invocation repeatedly with zero additional history requests and current disclosure settings', async () => {
  const owner = preparedInteraction();
  for (let i = 0; i < 2; i++) await handleTrackMenuShareLast(owner as never);
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.runs).not.toHaveBeenCalled();
  expect(owner.channel.send).toHaveBeenCalledTimes(2);
  expect(mocks.settings.mock.calls.some(([, options]) => options?.localOnly === false)).toBe(true);
  expect(mocks.snapshot.mock.calls.at(-1)?.[0]).toMatchObject({ runTypeCounts: { Farming: 132 }, historyCapturedAt: expect.any(Number) });
  expect(owner.channel.send.mock.calls[0][0].embed.data.footer.text).toBe(getTrackUiConfig().share.footer);
  expect(perfLog.warn.mock.calls.filter(([message]) => message === '[perf] share.operation').at(-1)?.[1]).toMatchObject({ outcome: 'sent', preparedReason: 'hit' });
});
it('keeps the prepared result available after a known Discord send failure', async () => {
  const owner = preparedInteraction(); owner.channel.send.mockRejectedValueOnce(new Error('fixture failure'));
  await handleTrackMenuShareLast(owner as never); await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).toHaveBeenCalledTimes(2); expect(mocks.history).not.toHaveBeenCalled();
});
it('rejects a copied prepared token on another message before settings or publication', async () => {
  const owner = preparedInteraction(); owner.message.id = 'copied-message';
  await handleTrackMenuShareLast(owner as never);
  expect(mocks.settings).not.toHaveBeenCalled(); expect(owner.channel.send).not.toHaveBeenCalled();
  expect(perfLog.warn.mock.calls.filter(([message]) => message === '[perf] share.operation').at(-1)?.[1]).toMatchObject({ noSendReason: 'prepared_rejected', preparedReason: 'message_mismatch', preparedPhase: 'initial' });
});
it('rechecks observed changes immediately before public delivery', async () => {
  const owner = preparedInteraction(); mocks.checkpoint.mockResolvedValueOnce('unchanged').mockResolvedValue('changed');
  await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
  expect(owner.followUp.mock.calls.at(-1)?.[0].content).toContain('changed');
  expect(perfLog.warn.mock.calls.filter(([message]) => message === '[perf] share.operation').at(-1)?.[1]).toMatchObject({ noSendReason: 'prepared_changed_before_send', preparedReason: 'checkpoint_changed', preparedPhase: 'pre_send' });
});
it('honors a fresh cloud disclosure change without re-reading prepared history', async () => {
  const owner = preparedInteraction(rows.map((row, i) => i ? row : { ...row, notes: 'PRIVATE_PREPARED_NOTE' }));
  mocks.settings.mockImplementation(async (_id, options) => ({ shareChart: false, shareNotes: options?.localOnly !== false }));
  await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).toHaveBeenCalledOnce(); expect(mocks.history).not.toHaveBeenCalled();
  expect(JSON.stringify(owner.channel.send.mock.calls[0][0].embed.data)).not.toContain('PRIVATE_PREPARED_NOTE');
});
it('rejects an invocation when the active upload profile changed', async () => {
  const owner = preparedInteraction(); setPendingUploadProfile('share-owner', 'alt');
  await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).not.toHaveBeenCalled(); expect(mocks.settings).not.toHaveBeenCalled();
});
it('identifies an unavailable prepared cache and malformed token without fresh reads or public output', async () => {
  const owner = preparedInteraction(); clearPreparedShareHistory();
  await handleTrackMenuShareLast(owner as never);
  expect(perfLog.warn.mock.calls.filter(([message]) => message === '[perf] share.operation').at(-1)?.[1]).toMatchObject({ outcome: 'no-send', noSendReason: 'prepared_rejected', preparedReason: 'missing' });
  owner.customId = TRACKER_IDS.flow.preparedSharePrefix;
  await handleTrackMenuShareLast(owner as never);
  expect(perfLog.warn.mock.calls.filter(([message]) => message === '[perf] share.operation').at(-1)?.[1]).toMatchObject({ noSendReason: 'invalid_prepared_token' });
  expect(owner.channel.send).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.settings).not.toHaveBeenCalled();
  const telemetry = JSON.stringify(perfLog.warn.mock.calls);
  expect(telemetry).not.toContain(owner.user.id); expect(telemetry).not.toContain('source-result');
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

it('overlaps fresh history and shared settings without publishing before both complete', async () => {
  vi.useFakeTimers();
  const owner = interaction();
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: {} });
  mocks.history.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return { getRuns: mocks.runs };
  });
  mocks.sharedSettings.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { runDeltaMode: 'disabled' };
  });
  try {
    const pending = handleTrackMenuShareLast(owner as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(owner.channel.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(owner.channel.send).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it.each([2000, 500])('overlaps tracker settings (%ims) with fresh history after the local cloud gate', async settingsMs => {
  vi.useFakeTimers();
  const owner = interaction();
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: { Farming: 1 } });
  mocks.settings.mockImplementation(async (_id, options) => {
    if (!options?.localOnly) await new Promise(resolve => setTimeout(resolve, settingsMs));
    return { cloudSyncEnabled: true, shareChart: false };
  });
  mocks.history.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { getRuns: mocks.runs };
  });
  try {
    const pending = handleTrackMenuShareLast(owner as never);
    await vi.advanceTimersByTimeAsync(1499);
    expect(owner.channel.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(Math.max(settingsMs, 1500) - 1499);
    await pending;
    expect(owner.channel.send).toHaveBeenCalledOnce();
    expect(mocks.history).toHaveBeenCalledOnce();
    expect(mocks.settings.mock.calls[0]).toEqual(['share-owner', { localOnly: true }]);
    expect(mocks.settings.mock.calls[1]).toEqual(['share-owner', { localOnly: false }]);
    expect(mocks.snapshot.mock.calls.at(-1)?.[0].runTypeCounts).toEqual({ Farming: 132 });
  } finally { vi.useRealTimers(); }
});

it('waits for the authoritative local cloud preference and keeps disabled sharing local', async () => {
  let release!: (value: object) => void;
  mocks.settings.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue({ cloudSyncEnabled: false, shareChart: false });
  const owner = interaction();
  const pending = handleTrackMenuShareLast(owner as never);
  await vi.waitFor(() => expect(mocks.settings).toHaveBeenCalledOnce());
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.sharedSettings).not.toHaveBeenCalled();
  release({ cloudSyncEnabled: false, shareChart: false });
  await pending;
  expect(mocks.settings.mock.calls.every(([, options]) => options?.localOnly === true)).toBe(true);
  expect(mocks.sharedSettings).toHaveBeenCalledWith('share-owner', { localOnly: true });
  expect(mocks.history).toHaveBeenCalledOnce();
  expect(owner.channel.send).toHaveBeenCalledOnce();
});

it('fails before remote work or publication when the local cloud preference cannot be read', async () => {
  mocks.settings.mockRejectedValueOnce(new Error('fixture storage unavailable'));
  const owner = interaction();
  await handleTrackMenuShareLast(owner as never);
  expect(mocks.settings).toHaveBeenCalledOnce();
  expect(mocks.history).not.toHaveBeenCalled(); expect(mocks.sharedSettings).not.toHaveBeenCalled();
  expect(mocks.snapshot).not.toHaveBeenCalled(); expect(owner.channel.send).not.toHaveBeenCalled();
});

it('keeps explicit verified sharing on the fresh history path', async () => {
  setShareableRun('share-owner', { run: rows[0], runTypeCounts: {} });
  const owner = { ...interaction(), customId: 'tracker_share_verified' };
  await handleTrackMenuShareLast(owner as never);
  expect(mocks.history).toHaveBeenCalledWith('share-owner', expect.objectContaining({ localFirst: true, readOnly: true }));
  expect(owner.channel.send).toHaveBeenCalledOnce();
});
it('does not publish an explicit verified share if cloud verification fails', async () => {
  mocks.history.mockRejectedValue(new Error('fixture cloud unavailable'));
  const owner = { ...interaction(), customId: 'tracker_share_verified' };
  await handleTrackMenuShareLast(owner as never);
  expect(owner.channel.send).not.toHaveBeenCalled();
});
