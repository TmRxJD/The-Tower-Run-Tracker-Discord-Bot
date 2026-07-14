import { describe, expect, it } from 'vitest';
import { buildShareEmbed } from './share-embed';

describe('share embed', () => {
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

  it('collapses to tier, wave, and coins only', () => {
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
      collapsed: true,
    });

    const description = embed.data.description ?? '';
    expect(description).toContain('🔢 Tier:');
    expect(description).toContain('🌊 Wave:');
    expect(description).toContain('🪙 Coins:');
    expect(description).not.toContain('⏱️ Duration:');
    expect(description).not.toContain('💀 Killed By:');
    expect(description).not.toContain('🔋 Cells:');
    expect(description).not.toContain('**📊 Per Hour**');
    expect(embed.data.fields ?? []).toHaveLength(0);
  });
});