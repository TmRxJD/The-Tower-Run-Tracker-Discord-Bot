import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlagsBitField } from 'discord.js';
import { getBotConfig } from '../config/bot-config';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { resolveInteractionDisplayName } from '../features/track/discord-display-name';
import { ensureRunDocumentsHydratedForUser } from '../features/track/tracker-api-client';
import { handleTrackWorkflow } from '../features/track/track-workflow';

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

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
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

  await client.persistence?.users.touch(interaction.user.id, resolveInteractionDisplayName(interaction)).catch(() => {});

  if (!settingsRequested) {
    void ensureRunDocumentsHydratedForUser(interaction.user.id).catch((error) => {
      logger.warn('Background run hydration warmup failed; continuing with local workflow', error);
    });
  }

  await handleTrackWorkflow(interaction, {
    mode: commandKey,
    paste,
    note,
    runType,
    settingsRequested,
    attachment,
  });
}
