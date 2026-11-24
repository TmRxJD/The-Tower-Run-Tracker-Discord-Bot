import { expect, it } from 'vitest';
import { buildTrackColumnValue } from './view-runs-table-image';

it('normalizes historical metric text for table rendering without changing source values', () => {
  const run = { totalCoins: '12,34K', totalCells: '1.234,56', roundDuration: '2h',
    localId: '01,234', note: 'Farm 01,234', type: 'Farming' };
  expect(buildTrackColumnValue(run, 'Coins')).toBe('12.34K');
  expect(buildTrackColumnValue(run, 'Coins/Hr')).toBe('6.17K');
  expect(buildTrackColumnValue(run, 'Type')).toBe('Farming');
  expect(run).toMatchObject({ totalCoins: '12,34K', localId: '01,234', note: 'Farm 01,234' });
});
