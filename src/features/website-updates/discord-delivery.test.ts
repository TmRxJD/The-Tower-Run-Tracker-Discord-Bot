import { ChannelType, Collection, type Client, type TextChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createUpdateDelivery, getUpdatesChannel, updatePayload } from './discord-delivery';
import { type PendingUpdate } from './mirror';
import { UPDATES_SOURCE } from './source';

const message = { title: 'Update v2.4.0', description: '@everyone <@123456789012345678> full content', footer: '2026-10-15 · Website Updates · Part 1 of 1' };
const pending: PendingUpdate = { message, nonce: 'a'.repeat(24), startedAt: Date.now() };
function fakeMessage(id: string, own = true, timestamp = Date.now()) {
  return { id, author: { id: own ? 'bot' : 'other' }, createdTimestamp: timestamp, nonce: null,
    embeds: [{ title: message.title, description: message.description, footer: { text: message.footer }, url: UPDATES_SOURCE }] };
}
function channelMock() {
  const channel = { send: vi.fn().mockResolvedValue({ id: '1400000000000000001' }),
    messages: { fetch: vi.fn(), edit: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) } };
  return { channel, adapter: createUpdateDelivery(channel as unknown as TextChannel, 'bot') };
}
describe('Discord Updates adapter', () => {
  it('disables all mentions for both sends and edits and links the exact public source', async () => {
    const { channel, adapter } = channelMock();
    await adapter.send(message, pending.nonce);
    await adapter.edit('1400000000000000001', message);
    expect(channel.send).toHaveBeenCalledWith({ ...updatePayload(message), nonce: pending.nonce, enforceNonce: true });
    expect(channel.send.mock.calls[0][0].allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(channel.messages.edit.mock.calls[0][1].allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(channel.send.mock.calls[0][0].embeds[0].url).toBe(UPDATES_SOURCE);
  });
  it('recovers an old bot-authored message by exact payload even without a nonce', async () => {
    const { channel, adapter } = channelMock();
    channel.messages.fetch.mockResolvedValue(new Collection([['m', fakeMessage('m')]]));
    expect(await adapter.recover(pending)).toBe('m');
  });
  it('does not recover another author or a similar edited payload', async () => {
    const { channel, adapter } = channelMock();
    const edited = fakeMessage('edited'); edited.embeds[0].description += ' other';
    channel.messages.fetch.mockResolvedValue(new Collection([['other', fakeMessage('other', false)], ['edited', edited]]));
    expect(await adapter.recover(pending)).toBeNull();
  });
  it('paginates beyond 100 intervening messages instead of blindly retrying', async () => {
    const { channel, adapter } = channelMock();
    channel.messages.fetch.mockResolvedValueOnce(new Collection(Array.from({ length: 100 }, (_, i) => [String(i), fakeMessage(String(i), false, pending.startedAt + i)])))
      .mockResolvedValueOnce(new Collection([['original', fakeMessage('original')]]));
    expect(await adapter.recover(pending)).toBe('original');
    expect(channel.messages.fetch.mock.calls[1][0].before).toBe('0');
  });
  it('fails closed for unreadable or nonadvancing history', async () => {
    const { channel, adapter } = channelMock();
    channel.messages.fetch.mockRejectedValueOnce(new Error('Forbidden'));
    await expect(adapter.recover(pending)).rejects.toThrow('Forbidden');
    channel.messages.fetch.mockResolvedValue(new Collection(Array.from({ length: 100 }, (_, i) => [String(i), fakeMessage(String(i), false, pending.startedAt + i)])));
    await expect(adapter.recover(pending)).rejects.toThrow('did not advance');
  });
  it('accepts an already-deleted surplus part but propagates other failures', async () => {
    const { channel, adapter } = channelMock();
    channel.messages.delete.mockRejectedValueOnce({ code: 10008 });
    await expect(adapter.remove('m')).resolves.toBeUndefined();
    channel.messages.delete.mockRejectedValueOnce({ code: 50013 });
    await expect(adapter.remove('m')).rejects.toEqual({ code: 50013 });
  });
  it('verifies channel type and required permissions before delivery', async () => {
    const member = {};
    const channel = { type: ChannelType.GuildText, guild: { members: { fetchMe: vi.fn().mockResolvedValue(member) } }, permissionsFor: vi.fn().mockReturnValue({ has: () => false }) };
    const client = { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as unknown as Client;
    await expect(getUpdatesChannel(client)).rejects.toThrow('permissions');
    channel.type = ChannelType.GuildVoice;
    await expect(getUpdatesChannel(client)).rejects.toThrow('text or announcement');
  });
});
