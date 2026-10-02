import { describe, expect, it } from 'vitest';
import { assertTrackerRunSubmission } from '@tmrxjd/platform/tools';
const complete = { tier: '7+', wave: '321', roundDuration: '1h2m3s', totalCoins: '1.2Q', totalCells: '32K', totalDice: '0' };
describe('new submission validation without historical rewrites', () => {
  it.each(['tier', 'wave', 'roundDuration', 'totalCoins', 'totalCells', 'totalDice'])('rejects absent %s before defaults can invent it', field => {
    const value: Record<string, unknown> = { ...complete }; delete value[field];
    expect(() => assertTrackerRunSubmission(value)).toThrow('required fields');
  });
  it.each([0, '0'])('retains genuine zero currencies (%s)', zero => {
    const value = { ...complete, totalCoins: zero, totalCells: zero, totalDice: zero };
    const before = structuredClone(value);
    expect(() => assertTrackerRunSubmission(value)).not.toThrow();
    expect(value).toEqual(before);
  });
  it.each(['', 'Unknown', '-1', '1garbage', '9'.repeat(400), NaN, Infinity, null])('rejects invalid coins without echoing private input (%s)', value => {
    expect(() => assertTrackerRunSubmission({ ...complete, totalCoins: value })).toThrow('required fields');
  });
  it.each(['1Q', '1q', '1AA', '1ab', '1,234', '1.5K'])('accepts supported currency notation (%s)', totalCoins => {
    expect(() => assertTrackerRunSubmission({ ...complete, totalCoins })).not.toThrow();
  });
  it('accepts a valid duration whose shared parser has floating-point rounding', () => {
    expect(() => assertTrackerRunSubmission({ ...complete, roundDuration: '3h48m47s' })).not.toThrow();
  });
});
