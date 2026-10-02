import { describe, expect, it } from 'vitest';
import { buildShareEmbed } from './share-embed';

describe('share embed', () => {
  it('shows missing/invalid metrics as unavailable and preserves explicit zeros', () => {
    const input = { user: { username: 'fixture' }, runTypeCounts: {}, options: {} };
    const absent = buildShareEmbed({ ...input, run: {} }).data.description!;
    expect(absent).toContain('Coins: **Unavailable**');
    expect(absent).toContain('Death Defies: **Unavailable**');
    expect(absent).toContain('Shards: **Unavailable**');
    const invalid = buildShareEmbed({ ...input, run: {totalCoins: 'Unknown', cannonShardsFetched: 'Unknown'} }).data.description!;
    expect(invalid).toContain('Coins: **Unavailable**');
    expect(invalid).toContain('Shards: **Unavailable**');
    const zeros = buildShareEmbed({ ...input, run: {totalCoins: 0, totalCells: '0', totalDice: 0, deathDefy: 0, cannonShardsFetched: 0, armorShardsFetched: 0, generatorShardsFetched: 0, coreShardsFetched: 0} }).data.description!;
    expect(zeros).toContain('Coins: **0**');
    expect(zeros).toContain('Death Defies: **0**');
    expect(zeros).toContain('Shards: **0**');
  });
  it('adds the earnings per hour heading before hourly share fields', () => {
    const embed = buildShareEmbed({
      user: { username: 'jd', displayName: 'JD' },
      run: {
        tierDisplay: '18',
        wave: '5220',
        roundDuration: '4h4m34s',
        totalCoins: '1.18Q',
        totalCells: '464.92K',
        totalDice: '54.2K',
        killedBy: 'Basic',
        deathDefy: '0',
        type: 'Farming',
      },
      runTypeCounts: { Farming: 726 },
      options: {},
    });

    const description = embed.data.description ?? '';
    const headingIndex = description.indexOf('**📊 Per Hour**');
    const coinsIndex = description.indexOf('🪙 Coins:', headingIndex + 1);

    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(coinsIndex).toBeGreaterThan(headingIndex);
  });

  it('collapses to tier, wave, and coins with coins/hour in parentheses and no comparisons', () => {
    const embed = buildShareEmbed({
      user: { username: 'jd', displayName: 'JD' },
      run: {
        tierDisplay: '18',
        wave: '5220',
        roundDuration: '4h4m34s',
        totalCoins: '1.18Q',
        totalCells: '464.92K',
        totalDice: '54.2K',
        killedBy: 'Basic',
        deathDefy: '0',
        notes: 'nice run',
        type: 'Farming',
      },
      runTypeCounts: { Farming: 726 },
      options: {},
      // A comparison baseline that would annotate the expanded share; it must be dropped here.
      deltaResult: {
        mode: 'last',
        comparisonLabel: 'Last Run',
        baseline: { wave: 5000, coins: 1_000_000_000_000_000 },
      } as never,
      collapsed: true,
    });

    const description = embed.data.description ?? '';
    expect(description).toContain('🔢 Tier:');
    expect(description).toContain('🌊 Wave:');
    expect(description).toMatch(/🪙 Coins: \*\*.+\*\* \(.+\/hr\)/);
    expect(description).not.toContain('⏱️ Duration:');
    expect(description).not.toContain('💀 Killed By:');
    expect(description).not.toContain('🔋 Cells:');
    expect(description).not.toContain('**📊 Per Hour**');
    expect(description).not.toContain('Last Run');
    expect(description).not.toMatch(/📈|📉/);
    expect(embed.data.fields ?? []).toHaveLength(0);
  });
});
describe('unavailable share count', () => {
  it('never turns missing or invalid counts into #1', () => {
    for (const counts of [{}, { Farming: 0 }, { Farming: Number.NaN }, { Farming: -1 }] as Record<string, number>[]) {
      const embed = buildShareEmbed({ user: { username: 'fixture' }, run: { type: 'Farming' }, runTypeCounts: counts, options: {} });
      expect(embed.data.title).toBe('Farming Run (count unavailable)');
    }
  });
});
