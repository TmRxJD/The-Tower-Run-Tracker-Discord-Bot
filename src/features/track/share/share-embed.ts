import { Colors, EmbedBuilder } from 'discord.js';
import { generateCoverageDescription, formatDuration as formatRunDuration } from '../handlers/upload-helpers';
import { calculateHourlyRate } from '../tracker-helpers';
import { formatNumberForDisplay, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';

export type ShareEmbedInput = {
  user: { username: string; displayName?: string; displayAvatarURL?: () => string | null };
  run: Record<string, unknown>;
  runTypeCounts: Record<string, number>;
  options?: {
    includeNotes?: boolean;
    includeCoverage?: boolean;
    includeScreenshot?: boolean;
    includeTier?: boolean;
    includeWave?: boolean;
    includeDuration?: boolean;
    includeKilledBy?: boolean;
    includeTotalCoins?: boolean;
    includeTotalCells?: boolean;
    includeTotalDice?: boolean;
    includeDeathDefy?: boolean;
    includeCoinsPerHour?: boolean;
    includeCellsPerHour?: boolean;
    includeDicePerHour?: boolean;
  };
};

function getRunString(run: Record<string, unknown>, key: string): string | null {
  const value = run[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function firstAvailable(run: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = getRunString(run, key);
    if (value !== null) return value;
  }
  return null;
}

function replaceTokens(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((output, [key, value]) => {
    return output.split(`{${key}}`).join(value);
  }, template);
}

function buildDescription(run: Record<string, unknown>, options: NonNullable<ShareEmbedInput['options']>): string {
  const tierDisplayRaw = getRunString(run, 'tierDisplay');
  const tierDisplay = tierDisplayRaw && tierDisplayRaw.trim()
    ? tierDisplayRaw
    : formatNumberForDisplay(parseNumberInput(standardizeNotation(firstAvailable(run, ['tier']) ?? '0')));

  const wave = firstAvailable(run, ['wave']) ?? 'N/A';
  const duration = firstAvailable(run, ['duration', 'roundDuration']) ?? '0';
  const killedBy = firstAvailable(run, ['killedBy']) ?? 'Apathy';
  const totalCoins = firstAvailable(run, ['totalCoins', 'coins']) ?? '0';
  const totalCells = firstAvailable(run, ['totalCells', 'cells']) ?? '0';
  const totalDice = firstAvailable(run, ['totalDice', 'rerollShards', 'dice']) ?? '0';
  const deathDefy = firstAvailable(run, ['deathDefy']) ?? '0';

  const parts: string[] = [];
  if (options.includeTier !== false) {
    parts.push(`🔢 Tier: **${tierDisplay}**`);
  }
  if (options.includeWave !== false) {
    parts.push(`🌊 Wave: **${wave}**`);
  }
  if (options.includeDuration !== false) {
    parts.push(`⏱️ Duration: **${formatRunDuration(duration)}**`);
  }
  if (options.includeKilledBy !== false) {
    parts.push(`💀 Killed By: **${killedBy}**`);
  }
  if (options.includeTotalCoins !== false) {
    parts.push(`🪙 Total Coins: **${formatNumberForDisplay(parseNumberInput(standardizeNotation(totalCoins)))}**`);
  }
  if (options.includeTotalCells !== false) {
    parts.push(`🔋 Total Cells: **${formatNumberForDisplay(parseNumberInput(standardizeNotation(totalCells)))}**`);
  }
  if (options.includeTotalDice !== false) {
    parts.push(`🎲 Total Dice: **${formatNumberForDisplay(parseNumberInput(standardizeNotation(totalDice)))}**`);
  }
  if (options.includeDeathDefy !== false) {
    parts.push(`🍀 Death Defies: **${deathDefy}**`);
  }
  if (!parts.length) {
    return 'No primary share elements are enabled. Use Share Settings to enable fields.';
  }

  return parts.join('\n');
}

export function buildShareEmbed({ user, run, runTypeCounts, options }: ShareEmbedInput): EmbedBuilder {
  const config = getTrackUiConfig().share;
  const includeNotes = options?.includeNotes !== false;
  const includeCoverage = options?.includeCoverage !== false;
  const includeScreenshot = options?.includeScreenshot !== false;
  const includeTier = options?.includeTier !== false;
  const includeWave = options?.includeWave !== false;
  const includeDuration = options?.includeDuration !== false;
  const includeKilledBy = options?.includeKilledBy !== false;
  const includeTotalCoins = options?.includeTotalCoins !== false;
  const includeTotalCells = options?.includeTotalCells !== false;
  const includeTotalDice = options?.includeTotalDice !== false;
  const includeDeathDefy = options?.includeDeathDefy !== false;
  const includeCoinsPerHour = options?.includeCoinsPerHour !== false;
  const includeCellsPerHour = options?.includeCellsPerHour !== false;
  const includeDicePerHour = options?.includeDicePerHour !== false;
  const runTypeRaw = firstAvailable(run, ['type']) ?? 'Farming';
  const runType = runTypeRaw;
  const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1);
  const rawTypeCount = runTypeCounts[runType] ?? runTypeCounts[formattedType] ?? 0;
  const typeCount = Math.max(1, Number(rawTypeCount) || 0);

  const coinsPerHour = calculateHourlyRate(firstAvailable(run, ['totalCoins', 'coins']), firstAvailable(run, ['roundDuration', 'duration'])) || '0';
  const cellsPerHour = calculateHourlyRate(firstAvailable(run, ['totalCells', 'cells']), firstAvailable(run, ['roundDuration', 'duration'])) || '0';
  const dicePerHour = calculateHourlyRate(firstAvailable(run, ['totalDice', 'rerollShards', 'dice']), firstAvailable(run, ['roundDuration', 'duration'])) || '0';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: replaceTokens(config.authorTemplate, { username: user.displayName ?? user.username }),
      iconURL: user.displayAvatarURL?.() || undefined,
    })
    .setTitle(replaceTokens(config.titleTemplate, { runType: formattedType, typeCount: String(typeCount) }))
    .setURL(config.url)
    .setColor(Colors.Gold)
    .setThumbnail(config.thumbnail)
    .setDescription(buildDescription(run, {
      includeTier,
      includeWave,
      includeDuration,
      includeKilledBy,
      includeTotalCoins,
      includeTotalCells,
      includeTotalDice,
      includeDeathDefy,
      includeCoinsPerHour,
      includeCellsPerHour,
      includeDicePerHour,
    }))
    .setFooter({ text: config.footer });

  const hourlyFields: Array<{ name: string; value: string; inline: true }> = [];
  if (includeCoinsPerHour) {
    hourlyFields.push({ name: config.hourlyFieldLabels.coins, value: String(coinsPerHour), inline: true });
  }
  if (includeCellsPerHour) {
    hourlyFields.push({ name: config.hourlyFieldLabels.cells, value: String(cellsPerHour), inline: true });
  }
  if (includeDicePerHour) {
    hourlyFields.push({ name: config.hourlyFieldLabels.dice, value: String(dicePerHour), inline: true });
  }
  if (hourlyFields.length) {
    embed.addFields({ name: config.hourlySectionLabel, value: '\u200B', inline: false }, ...hourlyFields);
  }

  const noteText = firstAvailable(run, ['notes', 'note']);
  if (includeNotes && noteText && noteText.trim() && noteText !== 'N/A') {
    embed.addFields({ name: config.notesFieldLabel, value: noteText });
  }

  const fullRunData = run.fullRunData;
  const coverageSource = typeof fullRunData === 'object' && fullRunData !== null
    ? { ...(fullRunData as Record<string, unknown>), ...run }
    : run;
  const coverage = generateCoverageDescription(coverageSource);
  if (includeCoverage && coverage) {
    embed.addFields({ name: config.coverageFieldLabel, value: coverage, inline: false });
  }

  const screenshotUrl = firstAvailable(run, ['screenshotUrl']);
  if (includeScreenshot && screenshotUrl) {
    embed.setImage(screenshotUrl);
  }

  return embed;
}
