import { SlashCommandBuilder, type ChatInputCommandInteraction, Colors, EmbedBuilder, MessageFlagsBitField } from 'discord.js';
import type { CommandModule } from '../core/command-types';
import { logger } from '../core/logger';
import { getBotConfig } from '../config/bot-config';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { formatTopFrequencyLines, summarizeAnalyticsEvents, summarizeUsageParityMetrics } from '@tmrxjd/platform/tools';

const botConfig = getBotConfig();
const ANALYTICS = botConfig.commands.analytics;
const COMMON = botConfig.common.responses;

const data = new SlashCommandBuilder()
  .setName(ANALYTICS.name)
  .setDescription(ANALYTICS.description)
  .addIntegerOption(option =>
    option.setName(ANALYTICS.options.daysBack.name)
      .setDescription(ANALYTICS.options.daysBack.description)
      .setRequired(false)
      .setMinValue(ANALYTICS.options.daysBack.min)
      .setMaxValue(ANALYTICS.options.daysBack.max));

function clampDays(value: number): number {
  const { min, max } = ANALYTICS.options.daysBack;
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export const analyticsCommand: CommandModule = {
  data: data.toJSON(),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!('persistence' in interaction.client) || !interaction.client.persistence) {
      await interaction.reply({ content: COMMON.notReady, flags: MessageFlagsBitField.Flags.Ephemeral });
      return;
    }

    const client = interaction.client as TrackerBotClient;
    const days = clampDays(interaction.options.getInteger(ANALYTICS.options.daysBack.name) ?? 7);
    const analyticsRepo = client.persistence?.analytics;
    if (!analyticsRepo) {
      await interaction.reply({ content: COMMON.notReady, flags: MessageFlagsBitField.Flags.Ephemeral });
      return;
    }

    try {
      const now = Date.now();
      await interaction.deferReply({ flags: MessageFlagsBitField.Flags.Ephemeral });
      const start = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
      const end = new Date(now).toISOString();
      const events = await analyticsRepo.listBetween(start, end);

      if (!events.length) {
        await interaction.editReply({ content: ANALYTICS.messages.noData });
        return;
      }

      const summary = summarizeAnalyticsEvents(events.map(event => ({
        commandName: event.commandName,
        event: event.event,
        userId: event.userId,
        guildId: event.guildId,
        timestampIso: event.ts,
      })), 10, ANALYTICS.messages.none);
      const parity = summarizeUsageParityMetrics(events.map(event => ({
        commandName: event.commandName,
        event: event.event,
        userId: event.userId,
        guildId: event.guildId,
        timestampIso: event.ts,
      })), ANALYTICS.messages.none);

      const commandLines = formatTopFrequencyLines(summary.topCommands);
      const eventLines = formatTopFrequencyLines(summary.topEvents);

      const description = [
        `${ANALYTICS.messages.summaryLabel}: ${summary.totalEvents}`,
        `${ANALYTICS.messages.usersLabel}: ${summary.uniqueUsers}`,
        `${ANALYTICS.messages.guildsLabel}: ${summary.uniqueGuilds}`,
        `Uses: ${parity.uses}`,
        `New uses: ${parity.newUses}`,
        `Unique uses: ${parity.uniqueUses}`,
        `Run tracker uploads: ${parity.runTrackerUploads}`,
        `Lifetime uploads: ${parity.lifetimeTrackerUploads}`,
        '',
        `${ANALYTICS.messages.commandsHeader}:`,
        ...commandLines,
        '',
        `${ANALYTICS.messages.eventsHeader}:`,
        ...eventLines,
      ].join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`${ANALYTICS.messages.titlePrefix}${days}${ANALYTICS.messages.titleSuffix}`)
        .setColor(Colors.Blue)
        .setDescription(description)
        .setFooter({ text: `${ANALYTICS.messages.footerPrefix}${interaction.user.tag}` })
        .setTimestamp(now);

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('analytics command failed', err);
      const payload = { content: ANALYTICS.messages.loadFailed, flags: MessageFlagsBitField.Flags.Ephemeral } as const;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  },
};
