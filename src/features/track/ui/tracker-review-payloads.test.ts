import { describe, expect, it } from 'vitest';
import { applyEditFieldValue, getCurrentEditFieldValue } from './tracker-review-payloads';

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
});