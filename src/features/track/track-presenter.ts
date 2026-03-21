import { Colors, EmbedBuilder } from 'discord.js';
import type { BotConfig } from '../../config/bot-config';
import { formatNumberForDisplay, formatRateWithNotation, parseDurationToHours, parseNumberInput, standardizeNotation } from '../../utils/tracker-math';
import { trimDisplayTimeSeconds } from './handlers/upload-helpers';
import type { RunSummaryView } from './types';

function safeNumber(value?: string) {
  if (!value) return 0;
  return parseNumberInput(standardizeNotation(value));
}

function trimBattleDateSeconds(value?: string) {
  const text = String(value ?? '').trim();
  if (!text) return '—';
  return text.replace(/(\b\d{1,2}:\d{2}):\d{2}\b/, '$1');
}

export function buildRunSummaryEmbed(view: RunSummaryView, copy: BotConfig['commands']['track']) {
  const hours = parseDurationToHours(view.duration ?? '0');
  const coinsPerHour = hours > 0 ? formatRateWithNotation(safeNumber(view.coins), hours) : undefined;
  const cellsPerHour = hours > 0 ? formatRateWithNotation(safeNumber(view.cells), hours) : undefined;
  const dicePerHour = hours > 0 ? formatRateWithNotation(safeNumber(view.dice), hours) : undefined;

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: copy.messages.fields.tier, value: view.tier ?? '—', inline: true },
    { name: copy.messages.fields.wave, value: view.wave ?? '—', inline: true },
    { name: copy.messages.fields.runType, value: view.runType ?? 'Farming', inline: true },
    { name: copy.messages.fields.duration, value: view.duration ?? '—', inline: true },
    { name: copy.messages.fields.killedBy, value: view.killedBy ?? 'Apathy', inline: true },
    { name: copy.messages.fields.date, value: trimBattleDateSeconds(view.battleDate), inline: true },
    { name: copy.messages.fields.coins, value: view.coins ? formatNumberForDisplay(safeNumber(view.coins)) : '—', inline: true },
    { name: copy.messages.fields.cells, value: view.cells ? formatNumberForDisplay(safeNumber(view.cells)) : '—', inline: true },
    { name: copy.messages.fields.dice, value: view.dice ? formatNumberForDisplay(safeNumber(view.dice)) : '—', inline: true },
  ];

  const rateLines = [
    coinsPerHour ? `${copy.messages.fields.coins}: ${coinsPerHour}` : null,
    cellsPerHour ? `${copy.messages.fields.cells}: ${cellsPerHour}` : null,
    dicePerHour ? `${copy.messages.fields.dice}: ${dicePerHour}` : null,
  ].filter(Boolean) as string[];

  if (rateLines.length) {
    fields.push({ name: copy.messages.fields.rates, value: rateLines.join('\n'), inline: false });
  }

  if (view.note) {
    fields.push({ name: copy.messages.fields.note, value: view.note, inline: false });
  }

  return new EmbedBuilder()
    .setTitle(copy.messages.summaryTitle)
    .setColor(Colors.Green)
    .addFields(fields);
}
