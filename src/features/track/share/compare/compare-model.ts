import { computeTrackerRunDeltaBaseline, readTrackerMetricValue, readTrackerModuleShardsTotal } from '@tmrxjd/platform/tools';
import { parseDurationToHours } from '@tmrxjd/platform/math';
import { getTrackUiConfig } from '../../../../config/tracker-ui-config';
import { buildShareEmbed, type ShareEmbedInput } from '../share-embed';
import { buildBattleReportSections } from '../../handlers/review-data-helpers';
import { resolveBattleReportSource } from '../battle-report-markdown';
import { paginateCompareRows, reportDifference, type ComparePage, type CompareRow } from './compare-rows';
import type { CompareRun, CompareShared } from './compare-data';

/** Preserve missing values where the canonical hourly formatter otherwise coerces them to zero. */
function hasHourlyValue(run: CompareRun, label: string): boolean {
  const first = (keys: string[]) => keys.map(key => run[key]).find(value => (typeof value === 'string' || typeof value === 'number') && String(value).trim());
  const keys: Record<string, string[]> = { Coins: ['totalCoins', 'coins'], Cells: ['totalCells', 'cells'], Dice: ['totalDice', 'rerollShards', 'dice'], Waves: ['wave'], Enemies: ['totalEnemies'] };
  const value = label === 'Shards' ? readTrackerModuleShardsTotal(run) : readTrackerMetricValue(first(keys[label] ?? []));
  return value !== null && parseDurationToHours(String(first(['roundDuration', 'duration']) ?? '')) > 0;
}

function embedRows(embed: ReturnType<typeof buildShareEmbed>, run: CompareRun): Map<string, { section: string; label: string; value: string; difference?: string }> {
  const rows = new Map<string, { section: string; label: string; value: string; difference?: string }>();
  let section = 'Run details';
  for (const line of (embed.data.description ?? '').split('\n')) {
    if (line.includes('Per Hour')) { section = 'Per hour'; continue; }
    const match = /([^:]+): \*\*(.*?)\*\*(?:\s*(\([+-]?[\d.]+%\)))?/.exec(line);
    if (!match) continue;
    const label = match[1].replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const missing = section === 'Per hour' && !hasHourlyValue(run, label);
    rows.set(section + ':' + label, { section, label, value: missing ? 'Unavailable' : match[2], difference: missing ? undefined : match[3] });
  }
  for (const field of embed.data.fields ?? []) {
    // Coverage and notes stay in the canonical formatter; the note is one paired text row.
    const lines = field.value.split('\n');
    const metrics = field.name === getTrackUiConfig().share.coverageFieldLabel
      ? lines.map(line => /^([^:]+):\s*([\d.]+%)\s*(\([+-]?[\d.]+%\))?$/.exec(line)).filter(Boolean) : [];
    if (metrics.length) {
      for (const match of metrics) {
        const label = match![1].replace(/^[^\p{L}\p{N}]+/u, '').trim();
        rows.set(field.name + ':' + label, { section: field.name, label, value: match![2], difference: match![3] });
      }
    } else rows.set(field.name, { section: 'Additional details', label: field.name, value: field.value });
  }
  return rows;
}

export function expandedComparePages(shared: CompareShared, mine: CompareRun, options: NonNullable<ShareEmbedInput['options']>): ComparePage[] {
  const baseline = computeTrackerRunDeltaBaseline([resolveBattleReportSource(shared.run)], String(shared.run.type ?? 'Farming'), 'last');
  baseline.comparisonLabel = 'vs shared run';
  const left = embedRows(buildShareEmbed({ user: { username: shared.sharerName }, run: shared.run, runTypeCounts: {}, options }), shared.run);
  const right = embedRows(buildShareEmbed({ user: { username: 'You' }, run: mine, runTypeCounts: {}, options, deltaResult: baseline }), mine);
  const rows: CompareRow[] = [...new Set([...left.keys(), ...right.keys()])].map(key => {
    const l = left.get(key), r = right.get(key), field = l ?? r!;
    return { key, section: field.section, label: field.label, shared: l?.value ?? null, mine: r?.value ?? null,
      // Stored hourly delta fields can be older than the displayed derived rate. Compare the displayed scalars together.
      difference: (field.section === 'Run details' || field.section === 'Per hour') && !['Tier', 'Duration', 'Killed By'].includes(field.label)
        ? reportDifference(field.label.toLowerCase(), r?.value ?? null, l?.value ?? null) : r?.difference };
  });
  return paginateCompareRows(rows);
}

export function battleReportComparePages(shared: CompareRun, mine: CompareRun): { pages: ComparePage[]; sharedAvailable: boolean; mineAvailable: boolean } {
  const a = resolveBattleReportSource(shared), b = resolveBattleReportSource(mine);
  const left = buildBattleReportSections(a), right = buildBattleReportSections(b);
  // Use canonical report ordering, retaining any legacy-only captured rows afterwards.
  const layout = buildBattleReportSections({ ...a, ...b, rawParseFields: { ...(a.rawParseFields as object ?? {}), ...(b.rawParseFields as object ?? {}) } });
  const collect = (sections: typeof left) => new Map(sections.flatMap(group => group.stats.map(stat => [stat.key, { ...stat, section: group.section }] as const)));
  const l = collect(left), r = collect(right), order = [...new Set([...layout.flatMap(group => group.stats.map(stat => stat.key)), ...l.keys(), ...r.keys()])];
  const groups = new Map(layout.flatMap(group => group.stats.map(stat => [stat.key, group.section] as const)));
  const rows = order.filter(key => l.has(key) || r.has(key)).map(key => {
    const one = l.get(key), two = r.get(key), field = one ?? two!;
    return { key, label: field.label, section: groups.get(key) ?? field.section, shared: one?.value ?? null, mine: two?.value ?? null,
      difference: reportDifference(key, two?.value ?? null, one?.value ?? null) };
  });
  const headline = new Set(['battleDate', 'roundDuration', 'tier', 'wave', 'killedBy', 'totalCoins', 'totalCells', 'totalDice', 'coinsPerHour', 'cellsPerHour']);
  return { pages: paginateCompareRows(rows), sharedAvailable: [...l.keys()].some(key => !headline.has(key)),
    mineAvailable: [...r.keys()].some(key => !headline.has(key)) };
}
