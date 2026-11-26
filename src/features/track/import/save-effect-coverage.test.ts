import { expect, it } from 'vitest';
import { buildTrackerRunTableColumnValue, computeTrackerRunDeltaBaseline, getDeltaAnnotationForStat, planBattleReportImport, splitTrackerRunForCollections, stitchTrackerRunCollections } from '@tmrxjd/platform/tools';
import { generateCoverageDescription } from '../handlers/upload-helpers';
import { buildShareEmbed } from '../share/share-embed';
import { resolveAnalysisChartValue } from '../handlers/analysis-handlers';

const baseEntry = { tier: 22, wave: 8874, battleDate: '2026-11-26T00:00:00Z', realTime: 3600,
  coinsEarned: 100, cellsEarned: 10, rerollShardsEarned: 1,
  totalEnemiesDestroyedThisRound: 1000, orbHitsThisRound: 980, enemiesHitByBlackHoleThisRound: 990,
  enemiesDestryoedByOrbsThisRound: 80, destroyedByBlackHole: 90 };
const imported = (fields: Record<string, unknown>) => planBattleReportImport({
  battleHistory: { _items: [{ ...baseEntry, ...fields }], _size: 1 },
}, []).importable[0];

it('maps the documented effect-active current-round export names before coverage calculation', () => {
  const run = imported({ enemiesDestroyedInOrbsThisRound: 410, enemiesDestroyedInBlackholeThisRound: 740 });
  expect(run.killsWithOrbs).toBe('410');
  expect(run.killsWithBlackHole).toBe('740');
  expect(run.enemiesHitByOrbs).toBe('980');
  expect(run.enemiesHitByBlackHole).toBe('990');
  expect(run.destroyedByOrbs).toBe('80');
  const parts = splitTrackerRunForCollections({ ...run, id: 'export-fixture', runId: 'export-fixture', updatedAt: 1 });
  const stored = stitchTrackerRunCollections(parts.fieldsForPart1, parts.fieldsForPart2)!;
  expect(buildTrackerRunTableColumnValue(stored, 'Orbs')).toBe('41%');
  expect(buildTrackerRunTableColumnValue(stored, 'Black Hole')).toBe('74%');
  expect(resolveAnalysisChartValue('coverageOrbsPct', stored)).toBe(41);
  expect(resolveAnalysisChartValue('coverageBhPct', stored)).toBe(74);
  expect(generateCoverageDescription(stored)).toContain('Orbs: 41%');
  expect(generateCoverageDescription(stored)).toContain('Black Hole: 74%');
  const embed = buildShareEmbed({ user: { username: 'fixture' }, run: stored, runTypeCounts: {} });
  expect(embed.data.fields?.some(field => field.value.includes('Orbs: 41%'))).toBe(true);
  const previous = imported({ enemiesDestroyedInOrbsThisRound: 400, enemiesDestroyedInBlackholeThisRound: 700 });
  const baseline = computeTrackerRunDeltaBaseline([previous], 'Farming', 'last');
  expect(getDeltaAnnotationForStat(stored, 'hitByOrbsPercentage', baseline.baseline)).toBe('(+2.50%)');
});

it('preserves explicit zero effect counts despite nonzero hits and final blows', () => {
  const run = imported({ enemiesDestroyedInOrbsThisRound: 0, enemiesDestroyedInBlackholeThisRound: 0 });
  expect(run.killsWithOrbs).toBe('0');
  expect(run.killsWithBlackHole).toBe('0');
  expect(buildTrackerRunTableColumnValue(run, 'Orbs')).toBe('0%');
  expect(buildTrackerRunTableColumnValue(run, 'Black Hole')).toBe('0%');
});

it('keeps canonical and previously supported aliases ahead of added current-round aliases', () => {
  const canonical = imported({ killsWithOrbs: 0, killsWithBlackHole: 500,
    enemiesDestroyedInOrbsThisRound: 410, enemiesDestroyedInBlackholeThisRound: 740 });
  expect(canonical.killsWithOrbs).toBe('0');
  expect(canonical.killsWithBlackHole).toBe('500');
  const earlier = imported({ destroyedInOrbs: 300, destroyedInBlackhole: 600,
    enemiesDestroyedInOrbsThisRound: 410, enemiesDestroyedInBlackholeThisRound: 740 });
  expect(earlier.killsWithOrbs).toBe('300');
  expect(earlier.killsWithBlackHole).toBe('600');
});

it('never derives missing effect kills from hits, final blows, or the current player root', () => {
  const root = { enemiesDestroyedInOrbsThisRound: 410, enemiesDestroyedInBlackholeThisRound: 740,
    battleHistory: { _items: [baseEntry], _size: 1 } };
  const run = planBattleReportImport(root, []).importable[0];
  expect(run.killsWithOrbs).toBeUndefined();
  expect(run.killsWithBlackHole).toBeUndefined();
  expect(buildTrackerRunTableColumnValue(run, 'Orbs')).toBe('N/A');
  expect(buildTrackerRunTableColumnValue(run, 'Black Hole')).toBe('N/A');
});
