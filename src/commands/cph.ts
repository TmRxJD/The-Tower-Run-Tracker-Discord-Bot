import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlagsBitField } from 'discord.js';
import type { CommandModule } from '../core/command-types';
import { getBotConfig } from '../config/bot-config';
import { formatNumberForDisplay, formatRateWithNotation, parseDurationToHours, parseResource } from '../utils/tracker-math';

type ResourceKind = 'coins' | 'cells' | 'dice';

const botConfig = getBotConfig();
const CPH = botConfig.commands.cph;
const COMMON = botConfig.common.responses;

const RESOURCE_META: Record<ResourceKind, { label: string; emoji: string }> = {
  coins: { label: 'Coins', emoji: '🪙' },
  cells: { label: 'Cells', emoji: '🔋' },
  dice: { label: 'Dice', emoji: '🎲' },
};

const data = new SlashCommandBuilder()
  .setName(CPH.name)
  .setDescription(CPH.description)
  .addStringOption(option =>
    option.setName(CPH.options.time.name)
      .setDescription(CPH.options.time.description)
      .setRequired(true))
  .addStringOption(option =>
    option.setName(CPH.options.coins.name)
      .setDescription(CPH.options.coins.description)
      .setRequired(false))
  .addStringOption(option =>
    option.setName(CPH.options.cells.name)
      .setDescription(CPH.options.cells.description)
      .setRequired(false))
  .addStringOption(option =>
    option.setName(CPH.options.dice.name)
      .setDescription(CPH.options.dice.description)
      .setRequired(false));


export const cphCommand: CommandModule = {
  data: data.toJSON(),
  async execute(interaction: ChatInputCommandInteraction) {
    const timeInput = interaction.options.getString(CPH.options.time.name);
    const coinsInput = interaction.options.getString(CPH.options.coins.name);
    const cellsInput = interaction.options.getString(CPH.options.cells.name);
    const diceInput = interaction.options.getString(CPH.options.dice.name);

    const totalHours = parseDurationToHours(timeInput);
    if (totalHours <= 0) {
      await interaction.reply({ content: CPH.messages.invalidTime, flags: MessageFlagsBitField.Flags.Ephemeral });
      return;
    }

    const provided = [
      { key: 'coins' as const, raw: coinsInput },
      { key: 'cells' as const, raw: cellsInput },
      { key: 'dice' as const, raw: diceInput },
    ].filter(entry => entry.raw);

    if (!provided.length) {
      await interaction.reply({ content: CPH.messages.missingResources, flags: MessageFlagsBitField.Flags.Ephemeral });
      return;
    }

    const invalid: string[] = [];
    const computed: string[] = [];

    for (const entry of provided) {
      const parsed = parseResource(entry.raw);
      if (!parsed.value) {
        invalid.push(RESOURCE_META[entry.key].label);
        continue;
      }
      const perHour = formatRateWithNotation(parsed.value, totalHours);
      const totalDisplay = formatNumberForDisplay(parsed.value);
      const { label, emoji } = RESOURCE_META[entry.key];
      computed.push(`${emoji} ${label}: ${totalDisplay} total → ${perHour}/hr`);
    }

    if (invalid.length) {
      await interaction.reply({ content: `${CPH.messages.invalidAmountsPrefix}${invalid.join(', ')}${CPH.messages.invalidAmountsHint}`, flags: MessageFlagsBitField.Flags.Ephemeral });
      return;
    }

    const durationDisplay = totalHours >= 0.01 ? totalHours.toFixed(2) : totalHours.toString();
    const header = `${CPH.messages.headerPrefix}${timeInput?.trim() ?? ''} (${durationDisplay}${CPH.messages.headerHoursSuffix})`;
    const response = [header, ...computed].join(CPH.messages.summaryDelimiter);

    await interaction.reply({ content: response, flags: MessageFlagsBitField.Flags.Ephemeral });
  },
};
