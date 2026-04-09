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

    const fields = embed.data.fields ?? [];
    const headingIndex = fields.findIndex(field => field.name === '📈 Earnings per Hour');
    const coinsIndex = fields.findIndex(field => String(field.name).includes('Coins'));

    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(coinsIndex).toBeGreaterThan(headingIndex);
  });
});