import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Client } from 'discord.js';
import type * as SourceModule from './source';

const mock = vi.hoisted(() => ({
  fetch: vi.fn(), channel: vi.fn(), mirror: vi.fn(), save: vi.fn(),
}));
vi.mock('../../services/idb', () => ({ getTrackerKv: vi.fn(), setTrackerKv: mock.save }));
vi.mock('./source', async original => ({ ...(await original<typeof SourceModule>()), fetchPublishedUpdates: mock.fetch }));
vi.mock('./discord-delivery', () => ({ getUpdatesChannel: mock.channel, createUpdateDelivery: vi.fn() }));
vi.mock('./mirror', () => ({ mirrorPublishedUpdates: mock.mirror }));
import { startWebsiteUpdatesMirror, stopWebsiteUpdatesMirror } from './runtime';

afterEach(() => { stopWebsiteUpdatesMirror(); vi.useRealTimers(); vi.clearAllMocks(); });
const client = { isReady: () => true, user: { id: 'bot' } } as unknown as Client;
describe('production mirror lifecycle', () => {
  it('never starts for the development bot', () => {
    startWebsiteUpdatesMirror(client, 'dev');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('never overlaps polls, and stops scheduling on shutdown', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mock.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    mock.channel.mockResolvedValue({ id: 'channel', name: 'dev-updates' });
    mock.mirror.mockResolvedValue({ sent: 0, edited: 0, recovered: 0, removed: 0, baselined: 0 });
    mock.save.mockResolvedValue(undefined);
    startWebsiteUpdatesMirror(client, 'prod');
    startWebsiteUpdatesMirror(client, 'prod');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    finish([{ title: 'Update', hash: 'hash' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.save).toHaveBeenCalledWith('website-updates-status:v1', expect.objectContaining({ ok: true, pid: process.pid }), { requirePersistent: true });
    stopWebsiteUpdatesMirror();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not touch delivery or baseline after a source failure and retries on the next poll', async () => {
    vi.useFakeTimers();
    mock.fetch.mockRejectedValue(new Error('Bad source'));
    mock.save.mockResolvedValue(undefined);
    startWebsiteUpdatesMirror(client, 'prod');
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.mirror).not.toHaveBeenCalled();
    expect(mock.save).toHaveBeenCalledWith('website-updates-status:v1', expect.objectContaining({ ok: false, stage: 'source' }), { requirePersistent: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });
});
