import type { Attachment, ChatInputCommandInteraction, EmbedBuilder} from 'discord.js';
import { getBotConfig } from '../../config/bot-config';
import { ensureDeferredEphemeralReply } from './interaction-ack';
import { getUserSettings } from './tracker-api-client';
import { asTrackReplyInteraction } from './handlers/review-interaction-helpers';
import { renderTrackMenu, handleDirectTextPaste, handleDirectAttachment, handleDirectSaveImport } from './handlers';
import { buildSettingsPayload } from './handlers/settings-handlers';
import { setTrackerFlowMode, setTrackerInitialRunType } from './flow-mode-store';

interface TrackOptions {
  mode?: 'track' | 'lifetime';
  paste?: string;
  note?: string;
  runType?: string;
  settingsRequested: boolean;
  attachment?: Attachment | null;
  saveFile?: Attachment | null;
}

export async function handleTrackWorkflow(interaction: ChatInputCommandInteraction, options: TrackOptions) {
  const trackInteraction = asTrackReplyInteraction(interaction);
  const botConfig = getBotConfig();
  const mode = options.mode ?? 'track';
  setTrackerFlowMode(interaction.user.id, mode);
  if (options.runType) {
    setTrackerInitialRunType(interaction.user.id, options.runType);
  }
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
      const payload = {
        content: 'Lifetime paste flow is not supported. Please upload a lifetime screenshot instead.',
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: payload.content, embeds: [], components: [] }).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
      return;
    }
    if (!await ensureDeferredEphemeralReply(interaction)) return;
    await handleDirectTextPaste(trackInteraction, options.paste, normalizedAttachment, options.note ?? null, options.runType ?? null, mode);
    return;
  }

  const normalizedSaveFile = options.saveFile
    ? {
        url: options.saveFile.url,
        name: options.saveFile.name,
        contentType: options.saveFile.contentType ?? undefined,
      }
    : null;

  if (normalizedSaveFile && mode === 'track') {
    if (!await ensureDeferredEphemeralReply(interaction)) return;
    await handleDirectSaveImport(trackInteraction, normalizedSaveFile);
    return;
  }

  if (options.attachment) {
    if (!await ensureDeferredEphemeralReply(interaction)) return;
    await handleDirectAttachment(trackInteraction, normalizedAttachment!, options.note ?? null, options.runType ?? 'Farming', mode);
    return;
  }

  if (options.settingsRequested) {
    if (!await ensureDeferredEphemeralReply(interaction)) return;
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
    if (!await ensureDeferredEphemeralReply(interaction)) return;
    await renderTrackMenu(trackInteraction, mode);
    return;
  }
}
