import { SlashCommandBuilder, EmbedBuilder, Colors, type ChatInputCommandInteraction, MessageFlagsBitField } from 'discord.js';
import { getBotConfig } from '../config/bot-config';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { resolveInteractionDisplayName } from '../features/track/discord-display-name';
import { ensureRunDocumentsHydratedForUser, getLastRun, getLocalRunSummary } from '../features/track/tracker-api-client';
import { handleTrackWorkflow } from '../features/track/track-workflow';

type TrackerCommandKey = 'track' | 'lifetime';

function buildProgressBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${percent}%`;
}

function buildCloudImportEmbed(processed: number, total: number, percent: number): EmbedBuilder {
  if (total === 0) {
    return new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle('📥 Cloud Sync')
      .setDescription("No runs found in the cloud. You're ready to start tracking!");
  }
  if (processed >= total) {
    return new EmbedBuilder()
      .setColor(Colors.Green)
      .setTitle('✅ Cloud Import Complete')
      .setDescription(`Imported **${total.toLocaleString()}** run${total === 1 ? '' : 's'}.\nLoading your tracker...`);
  }
  const description = processed === 0
    ? `Found **${total.toLocaleString()}** run${total === 1 ? '' : 's'} in the cloud.\nSaving to local storage...`
    : `${buildProgressBar(percent)}\n**${processed.toLocaleString()}** / **${total.toLocaleString()}** runs saved`;
  return new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle('📥 Importing Runs from Cloud')
    .setDescription(description);
}

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
    const { totalRuns } = await getLocalRunSummary(interaction.user.id).catch(() => ({ totalRuns: -1, runTypeCounts: {} as Record<string, number> }));

    if (totalRuns === 0) {
      // First-time user: show a live progress embed while the full cloud import runs.
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle('📥 Cloud Sync').setDescription('Connecting to the cloud...')],
      }).catch(() => {});

      let lastProgressUpdate = 0;
      await ensureRunDocumentsHydratedForUser(interaction.user.id, {
        onProgress: async ({ processed, total, percent }: { processed: number; total: number; percent: number }) => {
          const now = Date.now();
          const isFirst = processed === 0;
          const isLast = processed >= total && total > 0;
          if (!isFirst && !isLast && now - lastProgressUpdate < 750) return;
          lastProgressUpdate = now;
          await interaction.editReply({ embeds: [buildCloudImportEmbed(processed, total, percent)] }).catch(() => {});
        },
      }).catch((error) => {
        logger.warn('Initial cloud import failed; continuing with local workflow', error);
      });
    } else {
      // Returning user: show a syncing embed and await a guaranteed full cloud sync
      // before opening the menu so runs uploaded on the site always appear immediately.
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(Colors.Blue).setTitle('🔄 Syncing with Cloud').setDescription('Checking for new runs\u2026')],
      }).catch(() => {});
      await getLastRun(interaction.user.id, { cloudSyncMode: 'latest' }).catch((error) => {
        logger.warn('Pre-menu cloud sync failed; showing local data', error);
      });
    }
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
