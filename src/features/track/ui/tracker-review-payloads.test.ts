import { describe, expect, it } from 'vitest';
import { applyEditFieldValue, getCurrentEditFieldValue } from './tracker-review-payloads';
import { createDataReviewEmbed } from './tracker-ui';

describe('tracker-review-payloads', () => {
  it('returns tierDisplay when reading the tier field', () => {
    expect(getCurrentEditFieldValue({ tier: 11, tierDisplay: '11+' }, 'tier')).toBe('11+');
  });

  it('normalizes tier edits into tier fields', () => {
    expect(applyEditFieldValue({}, 'tier', '12+')).toMatchObject({
      tier: 12,
      tierDisplay: '12+',
      tierHasPlus: true,
    });
  });

  it('stores numeric resource edits as standardized notation', () => {
    expect(applyEditFieldValue({}, 'totalCoins', '1.5b')).toMatchObject({ totalCoins: '1.5B' });
  });

  it('renders canonical review fields once and ignores conflicting raw aliases', () => {
    const embed = createDataReviewEmbed({
      wave: '7676',
      Wave: '167963',
      duration: '9h54m5s',
      totalCoins: '76.37T',
      coins: '76.37T',
      totalCells: '128.82K',
      cells: '128.82K',
      totalDice: '16.80K',
      dice: '16.80K',
      rerollShards: '420',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      date: '2026-03-21',
      time: '13:47:00',
      type: 'Farming',
    });

    const fields = embed.data.fields ?? [];
    const values = fields.map(field => String(field.value));

    expect(values).toContain('7676');
    expect(values).toContain('Fast');
    expect(values).not.toContain('167963');
    expect(values).not.toContain('Apathy');
    expect(values.filter(value => value === '76.37T')).toHaveLength(1);
    expect(values.filter(value => value === '128.82K')).toHaveLength(1);
    expect(values.filter(value => value === '16.80K')).toHaveLength(1);
    expect(values).not.toContain('420');
  });
});