import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlagsBitField } from 'discord.js';
import { getBotConfig } from '../config/bot-config';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { resolveInteractionDisplayName } from '../features/track/discord-display-name';
import { resolveBotRunCloudIdentity } from '../features/track/run-cloud-identity';
import { syncBotsTrackerState } from '../services/bots-tracker-db';
import { handleTrackWorkflow } from '../features/track/track-workflow';
import { ensureDeferredEphemeralReply } from '../features/track/interaction-ack';

type TrackerCommandKey = 'track' | 'lifetime';

function hasPasteOption(options: object): options is { paste: { name: string; description: string } } {
  return 'paste' in options;
}

export function buildTrackerCommandData(commandKey: TrackerCommandKey) {
  const botConfig = getBotConfig();
  const commandConfig = botConfig.commands[commandKey];
  const options = commandConfig.options;

  const data = new SlashCommandBuilder()
    .setName(commandConfig.name)
    .setDescription(commandConfig.description);

  if (hasPasteOption(options)) {
    data.addStringOption(option =>
      option.setName(options.paste.name)
        .setDescription(options.paste.description)
        .setRequired(false));
  }

  if ('note' in options && options.note) {
    data.addStringOption(option =>
      option.setName(options.note.name)
        .setDescription(options.note.description)
        .setRequired(false));
  }

  if ('type' in options && options.type) {
    data.addStringOption(option =>
      option.setName(options.type.name)
        .setDescription(options.type.description)
        .setRequired(false)
        .addChoices(...options.type.choices));
  }

  if ('screenshot' in options && options.screenshot) {
    data.addAttachmentOption(option =>
      option.setName(options.screenshot.name)
        .setDescription(options.screenshot.description)
        .setRequired(false));
  }

  if ('savefile' in options && options.savefile) {
    data.addAttachmentOption(option =>
      option.setName(options.savefile.name)
        .setDescription(options.savefile.description)
        .setRequired(false));
  }

  if ('settings' in options && options.settings) {
    data.addBooleanOption(option =>
      option.setName(options.settings.name)
        .setDescription(options.settings.description)
        .setRequired(false));
  }

  return data.toJSON();
}

export async function executeTrackerCommand(commandKey: TrackerCommandKey, interaction: ChatInputCommandInteraction) {
  const botConfig = getBotConfig();
  const common = botConfig.common.responses;
  const commandConfig = botConfig.commands[commandKey];
  const options = commandConfig.options;

  if (!interaction.client || !('persistence' in interaction.client)) {
    await interaction.reply({ content: common.notReady, flags: MessageFlagsBitField.Flags.Ephemeral });
    return;
  }

  // Nothing below can reach the user if the interaction was never acknowledged.
  if (!await ensureDeferredEphemeralReply(interaction)) {
    return;
  }

  const client = interaction.client as TrackerBotClient;
  const paste = 'paste' in options && options.paste
    ? interaction.options.getString(options.paste.name) ?? undefined
    : undefined;
  const note = 'note' in options && options.note
    ? interaction.options.getString(options.note.name) ?? undefined
    : undefined;
  const runType = 'type' in options && options.type
    ? interaction.options.getString(options.type.name) ?? undefined
    : undefined;
  const settingsRequested = 'settings' in options && options.settings
    ? interaction.options.getBoolean(options.settings.name) ?? false
    : false;
  const attachment = 'screenshot' in options && options.screenshot
    ? interaction.options.getAttachment(options.screenshot.name) ?? undefined
    : undefined;
  const saveFile = 'savefile' in options && options.savefile
    ? interaction.options.getAttachment(options.savefile.name) ?? undefined
    : undefined;

  await client.persistence?.users.touch(interaction.user.id, resolveInteractionDisplayName(interaction)).catch(() => {});

  try {
    const identity = await resolveBotRunCloudIdentity(interaction.user.id);
    if (!identity.cloudWriteUserId) {
      await interaction.editReply({
        content: 'Link your Discord account on the Tower Run Tracker website before using cloud-backed tracker commands.',
      }).catch(() => {});
      return;
    }
  } catch (error) {
    logger.warn('Tracker identity resolution failed', error);
    await interaction.editReply({
      content: 'Link your Discord account on the Tower Run Tracker website before using cloud-backed tracker commands.',
    }).catch(() => {});
    return;
  }

  if (!settingsRequested) {
    void syncBotsTrackerState(interaction.user.id).catch((error) => {
      logger.warn('Bots tracker background sync skipped', error);
    });
  }

  await handleTrackWorkflow(interaction, {
    mode: commandKey,
    paste,
    note,
    runType,
    settingsRequested,
    attachment,
    saveFile,
  });
}
