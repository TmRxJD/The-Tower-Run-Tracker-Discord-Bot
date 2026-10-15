import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mirrorPublishedUpdates, type MirrorState, type MirrorStore, type UpdateDelivery } from './mirror';
import { parsePublishedUpdates } from './source';
import { type UpdateMessage } from './messages';

const releases = (version: string, body = 'Published content.') => parsePublishedUpdates(`# Update v${version}\n**October 15, 2026**\n\n${body}`);
function harness() {
  let durable: unknown = null;
  const messages = new Map<string, UpdateMessage>();
  const store: MirrorStore = {
    load: vi.fn(async () => structuredClone(durable)),
    save: vi.fn(async (state: MirrorState) => { durable = structuredClone(state); }),
  };
  let sequence = 0;
  const delivery = {
    send: vi.fn(async (message: UpdateMessage, _nonce: string) => {
      expect(_nonce).toMatch(/^[a-f0-9]{24}$/);
      const id = String(1400000000000000000n + BigInt(++sequence));
      messages.set(id, message); return id;
    }),
    recover: vi.fn<UpdateDelivery['recover']>().mockResolvedValue(null),
    edit: vi.fn(async (id: string, message: UpdateMessage) => { messages.set(id, message); }),
    remove: vi.fn(async (id: string) => { messages.delete(id); }),
  };
  return { store, delivery, messages, state: () => structuredClone(durable) as MirrorState, corrupt: () => { durable = {}; } };
}
describe('durable Updates delivery', () => {
  it('baselines history atomically without messages, including later edits to historical entries', async () => {
    const h = harness();
    expect(await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery)).toMatchObject({ baselined: 1, sent: 0 });
    await mirrorPublishedUpdates(releases('1.0.0', 'Historical edit'), h.store, h.delivery);
    expect(h.delivery.send).not.toHaveBeenCalled();
  });
  it('delivers a new entry once, then deduplicates after loading state through a new store wrapper', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    const current = [...releases('2.0.0'), ...releases('1.0.0')];
    await mirrorPublishedUpdates(current, h.store, h.delivery);
    await mirrorPublishedUpdates(current, { load: h.store.load, save: h.store.save }, h.delivery);
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
    expect(h.state().entries[current[0].id].parts[0].messageId).toMatch(/^\d+$/);
  });
  it('checkpoints intent before send, recovers a lost response and updates its edited revision in place', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    const original = h.delivery.send.getMockImplementation()!;
    let sentId = '';
    h.delivery.send.mockImplementationOnce(async (message, nonce) => {
      expect(h.state().entries[releases('2.0.0')[0].id].parts[0].pending?.nonce).toBe(nonce);
      sentId = await original(message, nonce);
      throw new Error('Response lost');
    });
    await expect(mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery)).rejects.toThrow('Response lost');
    h.delivery.recover.mockResolvedValueOnce(sentId);
    const result = await mirrorPublishedUpdates(releases('2.0.0', 'Corrected content'), h.store, h.delivery);
    expect(result).toMatchObject({ sent: 0, recovered: 1, edited: 1 });
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
    expect(h.messages.get(sentId)?.description).toBe('Corrected content');
  });
  it('retries a known absent uncertain send with its original nonce, but never if recovery fails', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    h.delivery.send.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery)).rejects.toThrow();
    const nonce = h.delivery.send.mock.calls[0][1];
    h.delivery.recover.mockRejectedValueOnce(new Error('Read forbidden'));
    await expect(mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery)).rejects.toThrow('Read forbidden');
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
    await mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery);
    expect(h.delivery.send.mock.calls[1][1]).toBe(nonce);
  });
  it('recovers after a successful send whose message-ID checkpoint failed', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    const save = h.store.save;
    h.store.save = async state => {
      if (Object.values(state.entries).some(entry => entry.parts.some(part => part.messageId))) throw new Error('Disk full');
      await save(state);
    };
    await expect(mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery)).rejects.toThrow('Disk full');
    h.store.save = save;
    h.delivery.recover.mockResolvedValueOnce([...h.messages.keys()][0]);
    await mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery);
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
  });
  it('does not send if the initial intent checkpoint fails', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    h.store.save = vi.fn().mockRejectedValue(new Error('Disk unavailable'));
    await expect(mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery)).rejects.toThrow();
    expect(h.delivery.send).not.toHaveBeenCalled();
  });
  it('edits existing parts and removes surplus parts when published content shrinks', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    await mirrorPublishedUpdates(releases('2.0.0', 'Long paragraph.\n'.repeat(900)), h.store, h.delivery);
    const originalIds = [...h.messages.keys()];
    await mirrorPublishedUpdates(releases('2.0.0', 'Short corrected paragraph.'), h.store, h.delivery);
    expect(h.messages.size).toBe(1);
    expect([...h.messages.keys()][0]).toBe(originalIds[0]);
    expect(h.delivery.send).toHaveBeenCalledTimes(originalIds.length);
    expect(h.delivery.remove).toHaveBeenCalledTimes(originalIds.length - 1);
  });
  it('retries a failed edit by its original ID without another announcement', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    await mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery);
    h.delivery.edit.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(mirrorPublishedUpdates(releases('2.0.0', 'Correction'), h.store, h.delivery)).rejects.toThrow();
    await mirrorPublishedUpdates(releases('2.0.0', 'Correction'), h.store, h.delivery);
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
    expect(h.delivery.edit.mock.calls[0][0]).toBe(h.delivery.edit.mock.calls[1][0]);
  });
  it('retains removed identities so reappearance does not announce again, and rejects corrupt state', async () => {
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    await mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery);
    await mirrorPublishedUpdates(releases('1.0.0'), h.store, h.delivery);
    await mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery);
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
    h.corrupt();
    await expect(mirrorPublishedUpdates(releases('2.0.0'), h.store, h.delivery)).rejects.toThrow();
  });
  it('persists dedupe through the real SQLite KV and a new repository instance', async () => {
    process.env.TRACKER_BOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'tracker-updates-test-'));
    const { getTrackerKv, setTrackerKv } = await import('../../services/idb.js');
    const persistentStore = (): MirrorStore => ({
      load: () => getTrackerKv('test-website-updates'),
      save: state => setTrackerKv('test-website-updates', state, { requirePersistent: true }),
    });
    const h = harness();
    await mirrorPublishedUpdates(releases('1.0.0'), persistentStore(), h.delivery);
    await mirrorPublishedUpdates(releases('2.0.0'), persistentStore(), h.delivery);
    await mirrorPublishedUpdates(releases('2.0.0'), persistentStore(), h.delivery);
    expect(h.delivery.send).toHaveBeenCalledTimes(1);
    delete process.env.TRACKER_BOT_DATA_DIR;
  });
});
