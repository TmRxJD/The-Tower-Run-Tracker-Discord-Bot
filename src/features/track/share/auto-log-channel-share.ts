import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { getUserSettings } from '../tracker-api-client';
import { logError } from '../handlers/error-handlers';
import { buildEmbedUserFromInteraction } from '../discord-display-name';
import { buildShareEmbed } from './share-embed';
import { getAutoLogMessageRef, setAutoLogMessageRef } from './log-channel-state';

const LOG_CHANNEL_RESTRICTED_GUILD_ID = '850137217828388904';

type ReviewInteraction = MessageComponentInteraction | ModalSubmitInteraction;

type EditableLogMessage = {
  edit?: (payload: { embeds: unknown[] }) => Promise<{ id?: unknown }> | unknown;
  delete: () => Promise<unknown>;
};

export async function autoShareToConfiguredLogChannel(params: {
  interaction: ReviewInteraction;
  userId: string;
  run: Record<string, unknown>;
  runTypeCounts: Record<string, number>;
}) {
  const settings = await getUserSettings(params.userId).catch(() => null);
  const logChannelId = typeof settings?.logChannelId === 'string' ? settings.logChannelId.trim() : '';
  const logChannelGuildId = typeof settings?.logChannelGuildId === 'string' ? settings.logChannelGuildId.trim() : '';
  if (!logChannelId) return;
  if (logChannelGuildId === LOG_CHANNEL_RESTRICTED_GUILD_ID) return;

  const includeNotes = settings?.shareNotes !== false;
  const includeCoverage = settings?.shareCoverage !== false;
  const includeScreenshot = settings?.shareScreenshot !== false;
  const includeTier = settings?.shareTier !== false;
  const includeWave = settings?.shareWave !== false;
  const includeDuration = settings?.shareDuration !== false;
  const includeKilledBy = settings?.shareKilledBy !== false;
  const includeTotalCoins = settings?.shareTotalCoins !== false;
  const includeTotalCells = settings?.shareTotalCells !== false;
  const includeTotalDice = settings?.shareTotalDice !== false;
  const includeCoinsPerHour = settings?.shareCoinsPerHour !== false;
  const includeCellsPerHour = settings?.shareCellsPerHour !== false;
  const includeDicePerHour = settings?.shareDicePerHour !== false;

  const embed = buildShareEmbed({
    user: buildEmbedUserFromInteraction(params.interaction),
    run: params.run,
    runTypeCounts: params.runTypeCounts,
    options: {
      includeTier,
      includeWave,
      includeDuration,
      includeKilledBy,
      includeTotalCoins,
      includeTotalCells,
      includeTotalDice,
      includeCoinsPerHour,
      includeCellsPerHour,
      includeDicePerHour,
      includeNotes,
      includeCoverage,
      includeScreenshot,
    },
  });

  const channel = await params.interaction.client.channels.fetch(logChannelId).catch(() => null);
  if (!channel || !('send' in channel) || typeof channel.send !== 'function') return;

  const previousRef = await getAutoLogMessageRef(params.userId, params.run).catch(() => null);
  const messageManager = 'messages' in channel ? (channel as { messages?: { fetch?: (messageId: string) => Promise<EditableLogMessage> } }).messages : undefined;
  if (previousRef?.messageId && previousRef.channelId === logChannelId && messageManager && typeof messageManager.fetch === 'function') {
    const updated = await messageManager.fetch(previousRef.messageId)
      .then(async (message) => {
        const editableMessage = message as EditableLogMessage;
        if (typeof editableMessage.edit === 'function') {
          const edited = await Promise.resolve(editableMessage.edit({ embeds: [embed] })).catch(() => null);
          const messageId = typeof (edited as { id?: unknown } | null)?.id === 'string'
            ? String((edited as { id?: unknown }).id)
            : previousRef.messageId;
          await setAutoLogMessageRef(params.userId, params.run, {
            channelId: logChannelId,
            messageId,
            updatedAt: Date.now(),
          }).catch(() => {});
          return true;
        }

        await editableMessage.delete().catch(() => null);
        return false;
      })
      .catch(() => false);
    if (updated) return;
  }

  await channel.send({ embeds: [embed] }).then(async (message) => {
    const messageId = typeof (message as { id?: unknown }).id === 'string' ? String((message as { id?: unknown }).id) : null;
    if (!messageId) return;
    await setAutoLogMessageRef(params.userId, params.run, {
      channelId: logChannelId,
      messageId,
      updatedAt: Date.now(),
    }).catch(() => {});
  }).catch((error) => {
    void logError(params.interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, params.interaction.user, error, 'track_menu_log_channel_autoshare');
  });
}