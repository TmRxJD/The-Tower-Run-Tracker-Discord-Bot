import { expect, it } from 'vitest';
import { Query } from 'node-appwrite';
import { buildCompleteHistoryExtendedBatches } from './complete-history-batches';

it.each([20, 36])('packs every %i-character cloud ID in bounded queries without reordering', length => {
  const ids = Array.from({ length: 1363 }, (_, i) => String(i).padStart(length, 'a'));
  const batches = buildCompleteHistoryExtendedBatches(ids);
  expect(batches.flat()).toEqual(ids);
  for (const batch of batches) {
    expect(Query.equal('$id', batch).length).toBeLessThanOrEqual(4000);
    expect(batch.length).toBeLessThanOrEqual(500);
  }
  expect(batches.length).toBeLessThanOrEqual(length === 20 ? 8 : 14);
});
it('handles an empty observation and refuses an unrepresentable ID', () => {
  expect(buildCompleteHistoryExtendedBatches([])).toEqual([]);
  expect(() => buildCompleteHistoryExtendedBatches(['a'.repeat(4000)])).toThrow('bounded query');
});
