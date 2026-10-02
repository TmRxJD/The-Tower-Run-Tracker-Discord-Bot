import { readTrackerMetricValue, readTrackerModuleShardsTotal } from '@tmrxjd/platform/tools';
import { Colors, EmbedBuilder } from 'discord.js';
import { generateCoverageDescription, formatDuration as formatRunDuration } from '../handlers/upload-helpers';
import { computeHourlyRate } from '../tracker-helpers';
import { formatNumberForDisplay } from '../../../utils/tracker-math';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { type TrackerRunDeltaResult, type TrackerDeltaStatKey, getDeltaAnnotationForStat } from '@tmrxjd/platform/tools';

export type ShareEmbedInput = {
  user: { username: string; displayName?: string; displayAvatarURL?: () => string | null };
  run: Record<string, unknown>;
  runTypeCounts: Record<string, number>;
  deltaResult?: TrackerRunDeltaResult;
  /** Collapsed shares only show tier/wave/coins; the rest is revealed by the Expand button. */
  collapsed?: boolean;
  options?: {
    includeNotes?: boolean;
    includeCoverage?: boolean;
    includeCoverageGoldenTower?: boolean;
    includeCoverageBlackHole?: boolean;
    includeCoverageSpotlight?: boolean;
    includeCoverageDeathWave?: boolean;
    includeCoverageOrbs?: boolean;
    includeCoverageGoldenBot?: boolean;
    includeCoverageAmpBot?: boolean;
    includeCoverageSummoned?: boolean;
    includeScreenshot?: boolean;
    includeTier?: boolean;
    includeWave?: boolean;
    includeDuration?: boolean;
    includeKilledBy?: boolean;
    includeTotalCoins?: boolean;
    includeTotalCells?: boolean;
    includeTotalDice?: boolean;
    includeTotalShards?: boolean;
    includeDeathDefy?: boolean;
    includeCoinsPerHour?: boolean;
    includeCellsPerHour?: boolean;
    includeDicePerHour?: boolean;
    includeShardsPerHour?: boolean;
    includeWavesPerHour?: boolean;
    includeEnemiesPerHour?: boolean;
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
    if (value !== null && value.trim()) return value;
  }
  return null;
}

function displayMetric(value: unknown): string {
  const parsed = readTrackerMetricValue(value);
  return parsed === null ? 'Unavailable' : formatNumberForDisplay(parsed);
}

function replaceTokens(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((output, [key, value]) => {
    return output.split(`{${key}}`).join(value);
  }, template);
}


function resolveModuleShardsTotal(run: Record<string, unknown>): string {
  const total = readTrackerModuleShardsTotal(run);
  return total === null ? 'Unavailable' : formatNumberForDisplay(total);
}

function buildDescription(
  run: Record<string, unknown>,
  options: NonNullable<ShareEmbedInput['options']>,
  hourlyRates: { coinsPerHour: string; cellsPerHour: string; dicePerHour: string; moduleShardsPerHour: string; wavesPerHour: string; enemiesPerHour: string },
  deltaResult?: TrackerRunDeltaResult,
  collapsed = false,
): string {
  const tierDisplayRaw = getRunString(run, 'tierDisplay');
  const tierDisplay = tierDisplayRaw && tierDisplayRaw.trim()
    ? tierDisplayRaw
    : displayMetric(firstAvailable(run, ['tier']));

  const wave = firstAvailable(run, ['wave']) ?? 'N/A';
  const duration = firstAvailable(run, ['duration', 'roundDuration']);
  const killedBy = firstAvailable(run, ['killedBy']) ?? 'Unavailable';
  const totalCoins = firstAvailable(run, ['totalCoins', 'coins']);
  const totalCells = firstAvailable(run, ['totalCells', 'cells']);
  const totalDice = firstAvailable(run, ['totalDice', 'rerollShards', 'dice']);
  const deathDefy = displayMetric(firstAvailable(run, ['deathDefy']));

  function delta(key: string): string {
    if (!deltaResult) return '';
    const annotation = getDeltaAnnotationForStat(run, key as TrackerDeltaStatKey, deltaResult.baseline, deltaResult.coverageBasis);
    return annotation ? ` ${annotation}` : '';
  }

  // Compact share: just tier/wave/coins, no comparison annotations, with coins/hour in ().
  if (collapsed) {
    const collapsedParts: string[] = [];
    if (options.includeTier !== false) collapsedParts.push(`🔢 Tier: **${tierDisplay}**`);
    if (options.includeWave !== false) collapsedParts.push(`🌊 Wave: **${wave}**`);
    if (options.includeTotalCoins !== false) {
      const coinsFormatted = displayMetric(totalCoins);
      collapsedParts.push(`🪙 Coins: **${coinsFormatted}** (${hourlyRates.coinsPerHour}/hr)`);
    }
    return collapsedParts.length
      ? collapsedParts.join('\n')
      : 'No primary share elements are enabled. Use Share Settings to enable fields.';
  }

  const parts: string[] = [];
  if (options.includeTier !== false) {
    const tierLabel = deltaResult?.comparisonLabel ? ` *(${deltaResult.comparisonLabel})*` : '';
    parts.push(`🔢 Tier: **${tierDisplay}**${tierLabel}`);
  }
  if (options.includeWave !== false) {
    parts.push(`🌊 Wave: **${wave}**${delta('wave')}`);
  }
  if (options.includeDuration !== false) {
    parts.push(`⏱️ Duration: **${duration === null ? 'Unavailable' : formatRunDuration(duration)}**${delta('duration')}`);
  }
  if (options.includeKilledBy !== false) {
    parts.push(`💀 Killed By: **${killedBy}**`);
  }
  if (options.includeTotalCoins !== false) {
    parts.push(`🪙 Coins: **${displayMetric(totalCoins)}**${delta('coins')}`);
  }
  if (options.includeTotalCells !== false) {
    parts.push(`🔋 Cells: **${displayMetric(totalCells)}**${delta('cells')}`);
  }
  if (options.includeTotalDice !== false) {
    parts.push(`🎲 Dice: **${displayMetric(totalDice)}**${delta('rerollShards')}`);
  }
  const totalShards = resolveModuleShardsTotal(run);
  if (options.includeTotalShards !== false) {
    parts.push(`🔼 Shards: **${totalShards}**${delta('moduleShards')}`);
  }
  if (options.includeDeathDefy !== false) {
    parts.push(`🍀 Death Defies: **${deathDefy}**${delta('deathDefy')}`);
  }
  if (!parts.length) {
    return 'No primary share elements are enabled. Use Share Settings to enable fields.';
  }

  const hourlyLines: string[] = [];
  if (options.includeCoinsPerHour !== false) hourlyLines.push(`🪙 Coins: **${hourlyRates.coinsPerHour}**${delta('coinsPerHour')}`);
  if (options.includeCellsPerHour !== false) hourlyLines.push(`🔋 Cells: **${hourlyRates.cellsPerHour}**${delta('cellsPerHour')}`);
  if (options.includeDicePerHour !== false) hourlyLines.push(`🎲 Dice: **${hourlyRates.dicePerHour}**${delta('rerollShardsPerHour')}`);
  if (options.includeShardsPerHour !== false) hourlyLines.push(`🔼 Shards: **${hourlyRates.moduleShardsPerHour}**${delta('moduleShardsPerHour')}`);
  if (options.includeWavesPerHour !== false) hourlyLines.push(`🌊 Waves: **${hourlyRates.wavesPerHour}**${delta('wavesPerHour')}`);
  if (options.includeEnemiesPerHour !== false) hourlyLines.push(`🔳 Enemies: **${hourlyRates.enemiesPerHour}**${delta('enemiesPerHour')}`);
  if (hourlyLines.length) {
    parts.push('\n**📊 Per Hour**\n' + hourlyLines.join('\n'));
  }

  return parts.join('\n');
}

export function buildShareEmbed({ user, run, runTypeCounts, deltaResult, options, collapsed = false }: ShareEmbedInput): EmbedBuilder {
  const config = getTrackUiConfig().share;
  const includeNotes = !collapsed && options?.includeNotes !== false;
  const includeCoverage = !collapsed && options?.includeCoverage !== false;
  const enabledCoverageMetrics: Set<string> | undefined = (() => {
    const keys: Record<string, string> = {
      goldenTower: 'includeCoverageGoldenTower',
      blackHole: 'includeCoverageBlackHole',
      spotlight: 'includeCoverageSpotlight',
      deathWave: 'includeCoverageDeathWave',
      orbs: 'includeCoverageOrbs',
      goldenBot: 'includeCoverageGoldenBot',
      ampBot: 'includeCoverageAmpBot',
      summoned: 'includeCoverageSummoned',
    };
    const hasAnyDisabled = Object.values(keys).some((k) => options?.[k as keyof typeof options] === false);
    if (!hasAnyDisabled) return undefined;
    return new Set(Object.entries(keys).filter(([, optKey]) => options?.[optKey as keyof typeof options] !== false).map(([k]) => k));
  })();
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
  const includeShardsPerHour = options?.includeShardsPerHour !== false;
  const includeWavesPerHour = options?.includeWavesPerHour !== false;
  const includeEnemiesPerHour = options?.includeEnemiesPerHour !== false;
  const includeTotalShards = options?.includeTotalShards !== false;
  const runTypeRaw = firstAvailable(run, ['type']) ?? 'Farming';
  const runType = runTypeRaw;
  const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1);
  const rawTypeCount = runTypeCounts[runType] ?? runTypeCounts[formattedType] ?? 0;
  const typeCount = Number(rawTypeCount);
  const hasVerifiedCount = Number.isSafeInteger(typeCount) && typeCount > 0;

  const durationRaw = firstAvailable(run, ['roundDuration', 'duration']);
  const coinsPerHour = computeHourlyRate(firstAvailable(run, ['totalCoins', 'coins']), durationRaw) || 'Unavailable';
  const cellsPerHour = computeHourlyRate(firstAvailable(run, ['totalCells', 'cells']), durationRaw) || 'Unavailable';
  const dicePerHour = computeHourlyRate(firstAvailable(run, ['totalDice', 'rerollShards', 'dice']), durationRaw) || 'Unavailable';
  const moduleShardsPerHour = computeHourlyRate(resolveModuleShardsTotal(run), durationRaw) || 'Unavailable';
  const wavesPerHour = computeHourlyRate(firstAvailable(run, ['wave']), durationRaw) || 'Unavailable';
  const enemiesPerHour = computeHourlyRate(firstAvailable(run, ['totalEnemies']), durationRaw) || 'Unavailable';

  const embed = new EmbedBuilder()
    .setAuthor({
      name: replaceTokens(config.authorTemplate, { username: user.displayName ?? user.username }),
      iconURL: user.displayAvatarURL?.() || undefined,
    })
    .setTitle(hasVerifiedCount
      ? replaceTokens(config.titleTemplate, { runType: formattedType, typeCount: String(typeCount) })
      : `${formattedType} Run (count unavailable)`)
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
      includeTotalShards,
      includeDeathDefy,
      includeCoinsPerHour,
      includeCellsPerHour,
      includeDicePerHour,
      includeShardsPerHour,
      includeWavesPerHour,
      includeEnemiesPerHour,
    }, { coinsPerHour, cellsPerHour, dicePerHour, moduleShardsPerHour, wavesPerHour, enemiesPerHour }, deltaResult, collapsed))
    .setFooter({ text: config.footer });

  const noteText = firstAvailable(run, ['notes', 'note']);
  if (includeNotes && noteText && noteText.trim() && noteText !== 'N/A') {
    embed.addFields({ name: config.notesFieldLabel, value: noteText });
  }

  const fullRunData = run.fullRunData;
  const coverageSource = typeof fullRunData === 'object' && fullRunData !== null
    ? { ...(fullRunData as Record<string, unknown>), ...run }
    : run;
  const deltaCallbackForCoverage = deltaResult
    ? (key: string) => {
        const annotation = getDeltaAnnotationForStat(coverageSource, key as TrackerDeltaStatKey, deltaResult.baseline, deltaResult.coverageBasis);
        return annotation ? ` ${annotation}` : '';
      }
    : undefined;
  const coverage = generateCoverageDescription(coverageSource, { getDeltaAnnotation: deltaCallbackForCoverage, enabledMetrics: enabledCoverageMetrics });
  if (includeCoverage && coverage) {
    embed.addFields({ name: config.coverageFieldLabel, value: coverage, inline: false });
  }

  const screenshotUrl = firstAvailable(run, ['screenshotUrl']);
  if (screenshotUrl) {
    embed.setThumbnail(screenshotUrl);
  }

  return embed;
}
