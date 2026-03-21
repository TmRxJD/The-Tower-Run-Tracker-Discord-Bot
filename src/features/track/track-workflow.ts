import { Attachment, ChatInputCommandInteraction, EmbedBuilder, MessageFlagsBitField } from 'discord.js';
import { logger } from '../../core/logger';
import { getBotConfig } from '../../config/bot-config';
import { getUserSettings } from './tracker-api-client';
import type { TrackReplyInteractionLike } from './interaction-types';
import { renderTrackMenu, handleDirectTextPaste, handleDirectAttachment } from './handlers';
import { buildSettingsPayload } from './handlers/settings-handlers';
import { setTrackerFlowMode } from './flow-mode-store';

interface TrackOptions {
  mode?: 'track' | 'lifetime';
  paste?: string;
  note?: string;
  runType?: string;
  settingsRequested: boolean;
  attachment?: Attachment | null;
}

export async function handleTrackWorkflow(interaction: ChatInputCommandInteraction, options: TrackOptions) {
  const trackInteraction = interaction as unknown as TrackReplyInteractionLike;
  const botConfig = getBotConfig();
  const mode = options.mode ?? 'track';
  setTrackerFlowMode(interaction.user.id, mode);
  const commandConfig = botConfig.commands[mode];
  const normalizedAttachment = options.attachment
    ? {
        url: options.attachment.url,
        name: options.attachment.name,
        id: options.attachment.id,
        contentType: options.attachment.contentType ?? undefined,
      }
    : null;

  if (options.paste) {
    if (mode === 'lifetime') {
      await interaction.reply({
        content: 'Lifetime paste flow is not supported. Please upload a lifetime screenshot instead.',
        ephemeral: true,
      }).catch(() => {});
      return;
    }
    await handleDirectTextPaste(trackInteraction, options.paste, normalizedAttachment, options.note ?? null, options.runType ?? null, mode);
    return;
  }

  if (options.attachment) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
    }
    await handleDirectAttachment(trackInteraction, normalizedAttachment!, options.note ?? null, options.runType ?? 'Farming', mode);
    return;
  }

  if (options.settingsRequested) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
    }
    const settings = await getUserSettings(interaction.user.id);
    const payload = settings
      ? await buildSettingsPayload(interaction.user.id, settings)
      : { content: commandConfig.messages.noSettings, embeds: [] as EmbedBuilder[], components: [] };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: payload.content, embeds: payload.embeds, components: payload.components }).catch(() => {});
    } else {
      await interaction.reply({ content: payload.content, embeds: payload.embeds, components: payload.components, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!options.attachment) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
    }
    await renderTrackMenu(trackInteraction, mode);
    return;
  }
}
