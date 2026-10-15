import { ChannelType, PermissionFlagsBits, type Client, type NewsChannel, type TextChannel } from 'discord.js';
import { type UpdateMessage } from './messages';
import { type PendingUpdate, type UpdateDelivery } from './mirror';
import { UPDATES_CHANNEL, UPDATES_SOURCE } from './source';

export const updatePayload = (message: UpdateMessage) => ({
  embeds: [{ title: message.title, description: message.description, url: UPDATES_SOURCE, footer: { text: message.footer } }],
  allowedMentions: { parse: [] as [], repliedUser: false },
});

export async function getUpdatesChannel(client: Client): Promise<TextChannel | NewsChannel> {
  const channel = await client.channels.fetch(UPDATES_CHANNEL, { force: true });
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    throw new Error('Updates target must be a guild text or announcement channel');
  }
  const member = await channel.guild.members.fetchMe();
  if (!channel.permissionsFor(member)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
  ])) throw new Error('Updates channel lacks required existing bot permissions');
  return channel;
}

export function createUpdateDelivery(channel: TextChannel | NewsChannel, botId: string): UpdateDelivery {
  return {
    async send(message, nonce) {
      return (await channel.send({ ...updatePayload(message), nonce, enforceNonce: true })).id;
    },
    async edit(id, message) {
      // Editing by ID is idempotent; a deleted message fails closed instead of announcing again.
      await channel.messages.edit(id, updatePayload(message));
    },
    async remove(id) {
      try { await channel.messages.delete(id); }
      catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 10008)) throw error;
      }
    },
    async recover(pending: PendingUpdate) {
      // Discord only enforces nonces for a few minutes. Search the complete relevant history
      // after a restart/uncertain response, including after a long outage, before sending again.
      // Bot-authored embeds are readable without the Message Content intent.
      const since = pending.startedAt - 60_000;
      let before: string | undefined;
      for (let page = 0; page < 100; page++) {
        const messages = await channel.messages.fetch({ limit: 100, before, cache: false });
        if (!messages.size) return null;
        let oldestTime = Infinity;
        let oldestId: string | undefined;
        for (const message of messages.values()) {
          if (message.createdTimestamp < oldestTime) { oldestTime = message.createdTimestamp; oldestId = message.id; }
          if (message.createdTimestamp < since || message.author.id !== botId) continue;
          const embed = message.embeds[0];
          if (message.nonce === pending.nonce || (embed?.title === pending.message.title
            && embed.description === pending.message.description && embed.footer?.text === pending.message.footer
            && embed.url === UPDATES_SOURCE)) return message.id;
        }
        if (oldestTime < since || messages.size < 100) return null;
        if (!oldestId || oldestId === before) throw new Error('Updates recovery pagination did not advance');
        before = oldestId;
      }
      throw new Error('Updates recovery history limit reached; refusing an uncertain resend');
    },
  };
}
