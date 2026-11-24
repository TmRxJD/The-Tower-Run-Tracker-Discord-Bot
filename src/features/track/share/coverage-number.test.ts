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

  it('keeps corrected zero authoritative and legacy hit-count fallbacks localized', () => {
    const corrected = generateCoverageDescription({ totalEnemies: '1,000', killsWithOrbs: '0[0,0%]',
      killsWithBlackHole: 0, enemiesHitByOrbs: '900', enemiesHitByBlackHole: '900' });
    expect(corrected).toContain('Orbs: 0%');
    expect(corrected).toContain('Black Hole: 0%');
    const legacy = generateCoverageDescription({ totalEnemies: '1,00K', enemiesHitByOrbs: '500',
      enemiesHitByBlackHole: '600' });
    expect(legacy).toContain('Orbs: 50%');
    expect(legacy).toContain('Black Hole: 60%');
  });
});
