import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlagsBitField } from 'discord.js';
import { getBotConfig } from '../config/bot-config';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { ensureRunDocumentsHydratedForUser } from '../features/track/tracker-api-client';
import { handleTrackWorkflow } from '../features/track/track-workflow';

type TrackerCommandKey = 'track' | 'lifetime';

function hasPasteOption(commandConfig: Record<string, unknown>): boolean {
  const options = commandConfig.options as Record<string, unknown> | undefined;
  return Boolean(options && typeof options === 'object' && 'paste' in options);
}

export function buildTrackerCommandData(commandKey: TrackerCommandKey) {
  const botConfig = getBotConfig();
  const commandConfig = botConfig.commands[commandKey] as unknown as {
    name: string;
    description: string;
    options: {
      paste?: { name: string; description: string };
      note?: { name: string; description: string };
      type?: { name: string; description: string; choices: Array<{ name: string; value: string }> };
      screenshot?: { name: string; description: string };
      settings?: { name: string; description: string };
    };
  };

  const data = new SlashCommandBuilder()
    .setName(commandConfig.name)
    .setDescription(commandConfig.description);

  if (hasPasteOption(commandConfig as unknown as Record<string, unknown>) && commandConfig.options.paste) {
    data.addStringOption(option =>
      option.setName(commandConfig.options.paste!.name)
        .setDescription(commandConfig.options.paste!.description)
        .setRequired(false));
  }

  if (commandConfig.options.note) {
    data.addStringOption(option =>
      option.setName(commandConfig.options.note!.name)
        .setDescription(commandConfig.options.note!.description)
        .setRequired(false));
  }

  if (commandConfig.options.type) {
    data.addStringOption(option =>
      option.setName(commandConfig.options.type!.name)
        .setDescription(commandConfig.options.type!.description)
        .setRequired(false)
        .addChoices(...commandConfig.options.type!.choices));
  }

  if (commandConfig.options.screenshot) {
    data.addAttachmentOption(option =>
      option.setName(commandConfig.options.screenshot!.name)
        .setDescription(commandConfig.options.screenshot!.description)
        .setRequired(false));
  }

  if (commandConfig.options.settings) {
    data.addBooleanOption(option =>
      option.setName(commandConfig.options.settings!.name)
        .setDescription(commandConfig.options.settings!.description)
        .setRequired(false));
  }

  return data.toJSON();
}

export async function executeTrackerCommand(commandKey: TrackerCommandKey, interaction: ChatInputCommandInteraction) {
  const botConfig = getBotConfig();
  const common = botConfig.common.responses;
  const commandConfig = botConfig.commands[commandKey] as unknown as {
    options: {
      paste?: { name: string };
      note?: { name: string };
      type?: { name: string };
      screenshot?: { name: string };
      settings?: { name: string };
    };
  };

  if (!interaction.client || !('persistence' in interaction.client)) {
    await interaction.reply({ content: common.notReady, flags: MessageFlagsBitField.Flags.Ephemeral });
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral }).catch(() => {});
  }

  const client = interaction.client as TrackerBotClient;
  const paste = commandConfig.options.paste
    ? interaction.options.getString(commandConfig.options.paste.name) ?? undefined
    : undefined;
  const note = commandConfig.options.note
    ? interaction.options.getString(commandConfig.options.note.name) ?? undefined
    : undefined;
  const runType = commandConfig.options.type
    ? interaction.options.getString(commandConfig.options.type.name) ?? undefined
    : undefined;
  const settingsRequested = commandConfig.options.settings
    ? interaction.options.getBoolean(commandConfig.options.settings.name) ?? false
    : false;
  const attachment = commandConfig.options.screenshot
    ? interaction.options.getAttachment(commandConfig.options.screenshot.name) ?? undefined
    : undefined;

  await client.persistence?.users.touch(interaction.user.id, interaction.user.username).catch(() => {});

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
