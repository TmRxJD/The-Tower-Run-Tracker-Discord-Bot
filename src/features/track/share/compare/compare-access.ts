import { getUserSettings } from '../../tracker-api-client';
import { getTrackUiConfig } from '../../../../config/tracker-ui-config';
import { resolveShareEmbedOptions } from '../share-embed-options';
import { parseShareRunRef } from '../share-run-ref';
import { TRACKER_IDS } from '../../track-custom-ids';
import type { ShareEmbedInput } from '../share-embed';

type Options = NonNullable<ShareEmbedInput['options']>;
export interface SourceSharePresentation { description?: string | null; fields?: readonly { name: string; value: string }[] }

export function sourceHasShareAction(rows: unknown, expectedId: string): boolean {
  return Array.isArray(rows) && rows.some(value => {
    if (typeof value !== 'object' || value === null) return false;
    return ('customId' in value && value.customId === expectedId) || ('custom_id' in value && value.custom_id === expectedId)
      || ('components' in value && sourceHasShareAction(value.components, expectedId));
  });
}

/** Fallback for a source with no Expand capability: retain only its actually displayed details. */
export function visibleCompareOptions(description: string, fields: SourceSharePresentation['fields'] = []): Options {
  const hourlyIndex = description.indexOf('Per Hour');
  const primary = hourlyIndex < 0 ? description : description.slice(0, hourlyIndex);
  const hourly = hourlyIndex < 0 ? '' : description.slice(hourlyIndex);
  const has = (text: string, label: string) => new RegExp(`(?:^|\\n)[^\\n:]*${label}: \\*\\*`).test(text);
  const compactRate = /Coins: \*\*[^\n]+\*\* \([^\n]+\/hr\)/.test(primary);
  const config = getTrackUiConfig().share;
  const coverage = fields?.find(field => field.name === config.coverageFieldLabel)?.value ?? '';
  return {
    includeTier: has(primary, 'Tier'), includeWave: has(primary, 'Wave'), includeDuration: has(primary, 'Duration'),
    includeKilledBy: has(primary, 'Killed By'), includeTotalCoins: has(primary, 'Coins'), includeTotalCells: has(primary, 'Cells'),
    includeTotalDice: has(primary, 'Dice'), includeTotalShards: has(primary, 'Shards'), includeDeathDefy: has(primary, 'Death Defies'),
    includeCoinsPerHour: has(hourly, 'Coins') || compactRate, includeCellsPerHour: has(hourly, 'Cells'), includeDicePerHour: has(hourly, 'Dice'),
    includeShardsPerHour: has(hourly, 'Shards'), includeWavesPerHour: has(hourly, 'Waves'), includeEnemiesPerHour: has(hourly, 'Enemies'),
    includeNotes: fields?.some(field => field.name === config.notesFieldLabel) ?? false,
    includeCoverage: Boolean(coverage), includeScreenshot: false,
    includeCoverageGoldenTower: coverage.includes('Golden Tower'), includeCoverageBlackHole: coverage.includes('Black Hole'),
    includeCoverageSpotlight: coverage.includes('Spotlight'), includeCoverageDeathWave: coverage.includes('Death Wave'),
    includeCoverageOrbs: coverage.includes('Orbs'), includeCoverageGoldenBot: coverage.includes('Golden Bot'),
    includeCoverageAmpBot: coverage.includes('Amp Bot'), includeCoverageSummoned: coverage.includes('Summoned'),
  };
}

export async function resolveCompareAccess(ref: string, presentation: SourceSharePresentation, rows: unknown): Promise<{ options: Options; canCompareReports: boolean }> {
  const parsed = parseShareRunRef(ref);
  if (!parsed) throw new Error('Invalid source share reference');
  const canExpand = sourceHasShareAction(rows, TRACKER_IDS.share.expandPrefix + ref);
  const options = canExpand
    ? resolveShareEmbedOptions(await getUserSettings(parsed.userId))
    : visibleCompareOptions(presentation.description ?? '', presentation.fields);
  // Report capability is independent of summary share toggles, matching the original Report action.
  return { options, canCompareReports: sourceHasShareAction(rows, TRACKER_IDS.share.reportPrefix + ref) };
}
