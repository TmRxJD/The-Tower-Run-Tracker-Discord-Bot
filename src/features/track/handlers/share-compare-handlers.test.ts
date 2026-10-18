import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShareEmbed } from '../share/share-embed';
import { TRACKER_IDS, parseShareCompareControl, withShareCompareControl } from '../track-custom-ids';
import { COMPARE_TTL_MS } from '../share/compare/compare-session';
import { TRACK_RUN_BATTLE_REPORT_FIELDS } from '@tmrxjd/platform/tools';

const mock = vi.hoisted(() => ({ snapshot: vi.fn(), choices: vi.fn(), owned: vi.fn(), log: vi.fn() }));
vi.mock('../../../core/logger', () => ({ logger: { warn: mock.log } }));
vi.mock('../share/compare/compare-data', () => ({ loadSharedCompareSnapshot: mock.snapshot, loadCompareChoices: mock.choices, readOwnedCompareRun: mock.owned }));
import { handleShareCompareOpen, handleShareCompareSelect, handleShareCompareNext, handleShareComparePrevious, handleShareCompareCancel, handleShareCompareBack, handleShareCompareReports, handleShareCompareDetails } from './share-compare-handlers';

let sequence = 0;
const run = { type: 'Farming', wave: '200', tier: '10', totalCoins: '1B', roundDuration: '1h' };
const description = buildShareEmbed({ user: { username: 'Alice' }, run, runTypeCounts: {} }).data.description!;
function interaction(sourceId = `source-${++sequence}`, userId = 'viewer') {
  return {
    isMessageComponent: () => true, customId: TRACKER_IDS.share.comparePrefix + 'sharer:S-' + 'a'.repeat(32),
    user: { id: userId, username: userId }, client: { user: { id: 'bot' } },
    message: { id: sourceId, author: { id: 'bot' }, embeds: [{ description }], components: [] as Array<{ components: Array<{ customId: string }> }>, flags: { has: () => false }, edit: vi.fn() },
    channel: { send: vi.fn() }, deferReply: vi.fn().mockResolvedValue(undefined), deferUpdate: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue({ id: `private-${sourceId}-${userId}` }),
    values: [] as string[],
  };
}
type Fixture = ReturnType<typeof interaction>;
function selectedId(open: Fixture): string { return open.editReply.mock.calls[0][0].components[0].toJSON().components[0].custom_id; }
function buttonId(payload: { components: Array<{ toJSON: () => { components: Array<{ label?: string; custom_id?: string }> } }> }, label: string): string {
  return payload.components.flatMap(row => row.toJSON().components).find(button => button.label === label)!.custom_id!;
}
function control(open: Fixture, id = selectedId(open), userId = open.user.id) {
  const result = interaction(open.message.id, userId);
  result.customId = id;
  result.message.id = `private-${open.message.id}-${open.user.id}`;
  result.message.flags.has = () => true;
  return result;
}
const invoke = (handler: typeof handleShareCompareOpen, value: Fixture) => handler(value as never);
const candidate = (id: number) => ({ source: 'local', id: String(id), profileId: null, preview: { tier: '10', wave: String(id) } });
const convertId = (id: string, prefix: string) => {
  const parsed = parseShareCompareControl(TRACKER_IDS.share.compareSelectPrefix, id)!;
  return withShareCompareControl(prefix, parsed.token, parsed.revision);
};
describe('private Compare with mine flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.snapshot.mockResolvedValue({ run, sharerName: 'Alice' });
    mock.choices.mockResolvedValue({ choices: Array.from({ length: 30 }, (_, i) => candidate(i)), recentOnly: false, unlinked: false });
    mock.owned.mockResolvedValue({ ...run, totalCoins: '2B' });
  });
  afterEach(() => vi.useRealTimers());

  it('opens privately, selects only the clicker’s run and never sends or edits a public message', async () => {
    const open = interaction();
    await invoke(handleShareCompareOpen, open);
    expect(open.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(mock.choices).toHaveBeenCalledWith('viewer');
    const select = control(open); select.values = ['0'];
    await invoke(handleShareCompareSelect, select);
    expect(mock.owned).toHaveBeenCalledWith('viewer', candidate(0));
    expect(select.editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain('S **1B** | Y **2B**');
    expect(select.editReply.mock.calls[0][0].embeds[0].toJSON().fields).toBeUndefined();
    expect(open.channel.send).not.toHaveBeenCalled();
    expect(open.message.edit).not.toHaveBeenCalled();
    expect(select.message.edit).not.toHaveBeenCalled();
    expect(mock.log).toHaveBeenCalledWith('[share-compare] interaction', expect.objectContaining({ action: 'select', outcome: 'comparison_delivered', stage: 'reply' }));
  });
  it('isolates two users clicking the same public share', async () => {
    const a = interaction(undefined, 'alice'), b = interaction(a.message.id, 'bob');
    await Promise.all([invoke(handleShareCompareOpen, a), invoke(handleShareCompareOpen, b)]);
    expect(selectedId(a)).not.toBe(selectedId(b));
    const forged = control(a, selectedId(a), 'bob'); forged.values = ['0'];
    await invoke(handleShareCompareSelect, forged);
    expect(forged.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(forged.deferUpdate).not.toHaveBeenCalled();
    expect(mock.owned).not.toHaveBeenCalled();
  });
  it('rejects controls placed on a different message or any public message', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    for (const invalid of ['message', 'public']) {
      const select = control(open); select.values = ['0'];
      if (invalid === 'message') select.message.id = 'different'; else select.message.flags.has = () => false;
      await invoke(handleShareCompareSelect, select);
      expect(select.deferUpdate).not.toHaveBeenCalled();
      expect(select.editReply).not.toHaveBeenCalled();
    }
    expect(mock.owned).not.toHaveBeenCalled();
  });
  it('rejects forged indexes, out-of-page selection, malformed IDs and stale revisions', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    for (const value of ['30', '25', '-1', '0junk', '01', 'other-user:run']) {
      const select = control(open); select.values = [value];
      await invoke(handleShareCompareSelect, select);
      expect(select.deferUpdate).not.toHaveBeenCalled();
    }
    const malformed = control(open, TRACKER_IDS.share.compareSelectPrefix + 'invalid');
    await invoke(handleShareCompareSelect, malformed);
    const next = control(open, convertId(selectedId(open), TRACKER_IDS.share.compareNextPrefix));
    await invoke(handleShareCompareNext, next);
    const stale = control(open); stale.values = ['0'];
    await invoke(handleShareCompareSelect, stale);
    expect(stale.deferUpdate).not.toHaveBeenCalled();
    expect(mock.owned).not.toHaveBeenCalled();
  });
  it('pages forwards/backwards without another data read and supports choosing another run', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    const next = control(open, convertId(selectedId(open), TRACKER_IDS.share.compareNextPrefix));
    await invoke(handleShareCompareNext, next);
    const nextId = next.editReply.mock.calls[0][0].components[0].toJSON().components[0].custom_id;
    const previous = control(open, convertId(nextId, TRACKER_IDS.share.comparePrevPrefix));
    await invoke(handleShareComparePrevious, previous);
    const id = previous.editReply.mock.calls[0][0].components[0].toJSON().components[0].custom_id;
    const select = control(open, id); select.values = ['1']; await invoke(handleShareCompareSelect, select);
    const backId = buttonId(select.editReply.mock.calls[0][0], 'Choose another run');
    const back = control(open, backId); await invoke(handleShareCompareBack, back);
    expect(back.editReply.mock.calls[0][0].content).toContain('1–25 of 30');
    expect(mock.choices).toHaveBeenCalledTimes(1);
    expect(mock.owned).toHaveBeenCalledTimes(1);
  });
  it('coalesces repeated public clicks without fetching private history twice', async () => {
    const first = interaction(), repeated = interaction(first.message.id);
    await invoke(handleShareCompareOpen, first);
    await invoke(handleShareCompareOpen, repeated);
    expect(repeated.editReply.mock.calls[0][0].content).toContain('already have');
    expect(mock.choices).toHaveBeenCalledTimes(1);
  });
  it('prevents duplicate selections while a read is pending and honours cancellation before completion', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    let finish!: (value: unknown) => void;
    mock.owned.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const select = control(open); select.values = ['0'];
    const pending = invoke(handleShareCompareSelect, select);
    await Promise.resolve(); await Promise.resolve();
    const repeat = control(open); repeat.values = ['0']; await invoke(handleShareCompareSelect, repeat);
    expect(repeat.deferUpdate).not.toHaveBeenCalled();
    const cancel = control(open, convertId(selectedId(open), TRACKER_IDS.share.compareCancelPrefix));
    await invoke(handleShareCompareCancel, cancel);
    finish(run); await pending;
    expect(select.editReply).not.toHaveBeenCalled();
    expect(mock.log.mock.calls.some(([, payload]) => payload.outcome === 'comparison_delivered')).toBe(false);
    expect(mock.owned).toHaveBeenCalledTimes(1);
    expect(cancel.editReply.mock.calls[0][0].components).toEqual([]);
  });
  it('expires sessions and permits a fresh public click after expiry', async () => {
    vi.useFakeTimers();
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    vi.advanceTimersByTime(COMPARE_TTL_MS + 1);
    const expired = control(open); expired.values = ['0']; await invoke(handleShareCompareSelect, expired);
    expect(expired.deferUpdate).not.toHaveBeenCalled();
    const again = interaction(open.message.id); await invoke(handleShareCompareOpen, again);
    expect(mock.choices).toHaveBeenCalledTimes(2);
  });
  it('handles unlinked/no-runs users and missing/stale snapshots without fetching the sharer’s history', async () => {
    mock.choices.mockResolvedValueOnce({ choices: [], unlinked: true });
    const unlinked = interaction(); await invoke(handleShareCompareOpen, unlinked);
    expect(unlinked.editReply.mock.calls[0][0].content).toContain('Link this Discord account');
    mock.choices.mockResolvedValueOnce({ choices: [], unlinked: false });
    const empty = interaction(); await invoke(handleShareCompareOpen, empty);
    expect(empty.editReply.mock.calls[0][0].content).toContain('no available runs');
    mock.snapshot.mockResolvedValueOnce(null);
    const missing = interaction(); await invoke(handleShareCompareOpen, missing);
    expect(missing.editReply.mock.calls[0][0].content).toContain('snapshot is unavailable');
    expect(mock.choices).toHaveBeenCalledTimes(2);
  });
  it('does no lookup after failed acknowledgement or another bot’s lookalike share', async () => {
    const failed = interaction(); failed.deferReply.mockRejectedValueOnce(new Error('Ack failed'));
    await invoke(handleShareCompareOpen, failed);
    const other = interaction(); other.message.author.id = 'other-bot'; await invoke(handleShareCompareOpen, other);
    expect(mock.snapshot).not.toHaveBeenCalled();
    expect(mock.choices).not.toHaveBeenCalled();
  });
  it('does no selected read after failed acknowledgement, and lets the same selection retry', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    const failed = control(open); failed.values = ['0']; failed.deferUpdate.mockRejectedValueOnce(new Error('Ack failed'));
    await invoke(handleShareCompareSelect, failed);
    expect(mock.owned).not.toHaveBeenCalled();
    expect(mock.log).toHaveBeenCalledWith('[share-compare] interaction', expect.objectContaining({ action: 'select', outcome: 'ack_failed' }));
    const retry = control(open); retry.values = ['0']; await invoke(handleShareCompareSelect, retry);
    expect(mock.owned).toHaveBeenCalledTimes(1);
  });
  it('does not log delivery when Discord rejects the private edit', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    const select = control(open); select.values = ['0'];
    select.editReply.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), { code: 50027 }));
    await invoke(handleShareCompareSelect, select);
    const results = mock.log.mock.calls.filter(([, payload]) => payload.action === 'select').map(([, payload]) => payload);
    expect(results).toEqual([expect.objectContaining({ outcome: 'failed', stage: 'reply', code: 50027 })]);
    expect(JSON.stringify(mock.log.mock.calls)).not.toContain('PRIVATE_BODY');
  });
  it('compares full reports with cached page navigation and back controls, with every value row paired', async () => {
    const report = Object.fromEntries(TRACK_RUN_BATTLE_REPORT_FIELDS.map(field => [field.key, '100']));
    const shared = { ...report, ...run, damageDealt: '1T', deathRayDamage: '2T', interestEarned: '1M' };
    const mine = { ...shared, damageDealt: '2T', deathRayDamage: 0, interestEarned: '2M' };
    mock.snapshot.mockResolvedValueOnce({ run: shared, sharerName: 'Alice' }); mock.owned.mockResolvedValue(mine);
    const open = interaction();
    open.message.components = [{ components: [{ customId: TRACKER_IDS.share.reportPrefix + 'sharer:S-' + 'a'.repeat(32) }] }];
    await invoke(handleShareCompareOpen, open);
    const select = control(open); select.values = ['0']; await invoke(handleShareCompareSelect, select);
    const reports = control(open, buttonId(select.editReply.mock.calls[0][0], 'Compare battle reports'));
    await invoke(handleShareCompareReports, reports);
    const first = reports.editReply.mock.calls[0][0];
    expect(first.embeds[0].data.title).toBe('Battle report comparison');
    expect(first.embeds[0].data.description).toContain('S **');
    const repeated = control(open, reports.customId); await invoke(handleShareCompareReports, repeated);
    expect(repeated.deferUpdate).not.toHaveBeenCalled();
    const next = control(open, buttonId(first, 'Next')); await invoke(handleShareCompareNext, next);
    expect(next.editReply.mock.calls[0][0].embeds[0].data.footer.text).toContain('Page 2 of');
    expect(mock.owned).toHaveBeenCalledTimes(2);
    const details = control(open, buttonId(next.editReply.mock.calls[0][0], 'Back to details'));
    await invoke(handleShareCompareDetails, details);
    expect(details.editReply.mock.calls[0][0].embeds[0].data.title).toBe('Expanded run comparison');
    expect(mock.choices).toHaveBeenCalledTimes(1);
    expect(mock.log).toHaveBeenCalledWith('[share-compare] interaction', expect.objectContaining({ action: 'reports', outcome: 'report_delivered' }));
  });
  it('rejects forged report access and another user', async () => {
    const open = interaction(); await invoke(handleShareCompareOpen, open);
    const select = control(open); select.values = ['0']; await invoke(handleShareCompareSelect, select);
    const parsed = parseShareCompareControl(TRACKER_IDS.share.comparePrevPrefix, buttonId(select.editReply.mock.calls[0][0], 'Previous'))!;
    const forgedId = withShareCompareControl(TRACKER_IDS.share.compareReportsPrefix, parsed.token, parsed.revision);
    const forged = control(open, forgedId); await invoke(handleShareCompareReports, forged);
    const other = control(open, forgedId, 'other'); await invoke(handleShareCompareReports, other);
    expect(forged.deferUpdate).not.toHaveBeenCalled(); expect(other.deferUpdate).not.toHaveBeenCalled();
    expect(mock.owned).toHaveBeenCalledTimes(1);
  });
  it('coalesces report reads and prevents late reports after cancellation', async () => {
    const open = interaction(); open.message.components = [{ components: [{ customId: TRACKER_IDS.share.reportPrefix + 'sharer:S-' + 'a'.repeat(32) }] }];
    await invoke(handleShareCompareOpen, open);
    const select = control(open); select.values = ['0']; await invoke(handleShareCompareSelect, select);
    let finish!: (value: unknown) => void;
    mock.owned.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const reports = control(open, buttonId(select.editReply.mock.calls[0][0], 'Compare battle reports'));
    const pending = invoke(handleShareCompareReports, reports);
    await Promise.resolve(); await Promise.resolve();
    const repeat = control(open, reports.customId); await invoke(handleShareCompareReports, repeat);
    expect(repeat.deferUpdate).not.toHaveBeenCalled();
    const cancel = control(open, buttonId(select.editReply.mock.calls[0][0], 'Close')); await invoke(handleShareCompareCancel, cancel);
    finish(run); await pending;
    expect(reports.editReply).not.toHaveBeenCalled();
    expect(mock.owned).toHaveBeenCalledTimes(2);
    expect(mock.log.mock.calls.some(([, payload]) => payload.outcome === 'report_delivered')).toBe(false);
  });
  it('revalidates the selected run before reports and rejects deletion without showing cached report data', async () => {
    const open = interaction(); open.message.components = [{ components: [{ customId: TRACKER_IDS.share.reportPrefix + 'sharer:S-' + 'a'.repeat(32) }] }];
    await invoke(handleShareCompareOpen, open);
    const select = control(open); select.values = ['0']; await invoke(handleShareCompareSelect, select);
    mock.owned.mockResolvedValueOnce(null);
    const report = control(open, buttonId(select.editReply.mock.calls[0][0], 'Compare battle reports')); await invoke(handleShareCompareReports, report);
    expect(report.editReply.mock.calls[0][0].embeds).toEqual([]);
    expect(report.editReply.mock.calls[0][0].content).toContain('no longer available');
  });
  it('handles deleted selected runs and read errors privately without rendering stale data or raw errors', async () => {
    for (const outcome of ['deleted', 'error']) {
      const open = interaction(); await invoke(handleShareCompareOpen, open);
      if (outcome === 'deleted') mock.owned.mockResolvedValueOnce(null); else mock.owned.mockRejectedValueOnce(new Error('PRIVATE_SECRET'));
      const select = control(open); select.values = ['0']; await invoke(handleShareCompareSelect, select);
      expect(select.editReply.mock.calls[0][0].embeds).toEqual([]);
      expect(JSON.stringify(select.editReply.mock.calls)).not.toContain('PRIVATE_SECRET');
      expect(select.channel.send).not.toHaveBeenCalled();
    }
  });
});
