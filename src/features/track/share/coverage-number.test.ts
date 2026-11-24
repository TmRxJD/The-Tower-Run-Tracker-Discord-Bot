import { buildTrackerRunTableColumnValue, computeTrackerRunDeltaBaseline, getDeltaAnnotationForStat } from '@tmrxjd/platform/tools';
import { describe, expect, it } from 'vitest';
import { readCoverageCount } from './coverage-number';
import { generateCoverageDescription } from '../handlers/upload-helpers';
import { buildShareEmbed } from './share-embed';

describe('game-report coverage number presentation', () => {
  it.each([
    ['653,35K', 653350], ['653.35K', 653350], ['653,35K[87,2%]', 653350],
    ['653.35K [87.2%]', 653350], ['675255[90,1%]', 675255], ['749,283', 749283],
    ['1,234,567', 1234567], ['1,234.5K', 1234500], ['1 234 567', 1234567],
    ['0', 0], [0, 0], ['0[0,0%]', 0], ['.5K', 500],
    ['bad', null], ['123garbage', null], ['1,2,3K', null], ['1.2.3K', null],
    ['653K[bad]', null], ['653Kjunk', null], ['', null], [null, null], [-1, null],
    [Infinity, null],
  ])('reads %j as %j without partial numeric fallback', (input, expected) => {
    expect(readCoverageCount(input)).toBe(expected);
  });

  it('uses localized counts for every coverage metric and the denominator', () => {
    const coverage = generateCoverageDescription({ totalEnemies: '1,000,000',
      killsWithGoldenTower: '900,00K[90,0%]', killsWithBlackHole: '800,00K[80,0%]',
      destroyedInSpotlight: '700,00K[70,0%]', taggedByDeathWave: '600,00K',
      killsWithOrbs: '500,00K[50,0%]', destroyedInGoldenBot: '400,00K',
      killsWithAmplifyBot: '300,00K', guardianSummonedEnemies: '200,00K' });
    for (const line of ['Golden Tower: 90%', 'Black Hole: 80%', 'Spotlight: 70%',
      'Death Wave: 60%', 'Orbs: 50%', 'Golden Bot: 40%', 'Amp Bot: 30%', 'Summoned: 20%']) {
      expect(coverage).toContain(line);
    }
  });

  it('renders the reported DW case through the real share embed entry point', () => {
    const run = { totalEnemies: '749283', taggedByDeathWave: '653,35K',
      destroyedInSpotlight: '675255[90,1%]', killsWithOrbs: '670407[89,5%]',
      destroyedInGoldenBot: '429378[57,3%]', tier: '20', wave: '5558' };
    const embed = buildShareEmbed({ user: { username: 'test' }, run, runTypeCounts: {},
      deltaResult: { mode: '7day', baseline: { taggedByDeathWavePercentage: 87.54181990577835 },
        coverageBasis: {}, comparisonLabel: 'vs 7-Day Avg' } });
    const coverage = embed.toJSON().fields?.find(field => field.value.includes('Death Wave:'))?.value;
    expect(coverage).toContain('Death Wave: 87% (-0.39%)');
    expect(coverage).toContain('Spotlight: 90%');
    expect(coverage).toContain('Orbs: 89%');
    expect(coverage).toContain('Golden Bot: 57%');
  });

  it('preserves genuine zeros and never uses legacy hit counts as coverage', () => {
    const corrected = generateCoverageDescription({ totalEnemies: '1,000', killsWithOrbs: '0[0,0%]',
      killsWithBlackHole: 0, enemiesHitByOrbs: '900', enemiesHitByBlackHole: '900' });
    expect(corrected).toContain('Orbs: 0%');
    expect(corrected).toContain('Black Hole: 0%');
    const legacy = generateCoverageDescription({ totalEnemies: '1,00K', enemiesHitByOrbs: '500',
      enemiesHitByBlackHole: '600' });
    expect(legacy).not.toContain('Orbs:');
    expect(legacy).not.toContain('Black Hole:');
  });
});

it('uses the same report counts in embeds, tables and comparison for corrected and other coverage', () => {
  const prior = { id: 'prior', type: 'Farming', totalEnemies: '1.000,00',
    killsWithOrbs: '500,00', killsWithBlackHole: '500,00', taggedByDeathWave: '500,00',
    enemiesHitByOrbs: '990', destroyedByOrbs: '10', hitByOrbsPercentage: '99%' };
  const current = { ...prior, rawParseFields: {
    killsWithOrbs: '600[60,0%]', killsWithBlackHole: '600[60,0%]', taggedByDeathWave: '600[60,0%]',
  }, killsWithOrbs: null, killsWithBlackHole: null, taggedByDeathWave: null };
  const result = computeTrackerRunDeltaBaseline([prior], 'Farming', 'last');
  const keys = ['hitByOrbsPercentage', 'destroyedByBlackHolePercentage', 'taggedByDeathWavePercentage'] as const;
  const labels = ['Orbs', 'Black Hole', 'Death Wave'] as const;
  for (const [i, key] of keys.entries()) {
    expect(result.baseline[key]).toBe(50);
    expect(getDeltaAnnotationForStat(current, key, result.baseline)).toBe('(+20.00%)');
    expect(buildTrackerRunTableColumnValue(current, labels[i])).toBe('60%');
    expect(generateCoverageDescription(current)).toContain(labels[i] + ': 60%');
  }
  expect(buildTrackerRunTableColumnValue({ ...prior, killsWithOrbs: null }, 'Orbs')).toBe('N/A');
});

it('preserves authoritative stored-only coverage but refuses superseded hit-derived percentages', () => {
  const run = { type: 'Farming', destroyedInSpotlightPercentage: '89,125%', hitByOrbsPercentage: '96%',
    destroyedByBlackHolePercentage: '95%', taggedByDeathWavePercentage: '0%' };
  const result = computeTrackerRunDeltaBaseline([run], 'Farming', 'last');
  expect(result.baseline).toMatchObject({ destroyedInSpotlightPercentage: 89.125, taggedByDeathWavePercentage: 0 });
  expect(result.baseline).not.toHaveProperty('hitByOrbsPercentage');
  expect(result.baseline).not.toHaveProperty('destroyedByBlackHolePercentage');
  expect(buildTrackerRunTableColumnValue(run, 'Spotlight')).toBe('89.13%');
  expect(generateCoverageDescription(run)).toContain('Spotlight: 89%');
  expect(generateCoverageDescription(run)).toContain('Death Wave: 0%');
  expect(generateCoverageDescription(run)).not.toContain('Orbs:');
});
