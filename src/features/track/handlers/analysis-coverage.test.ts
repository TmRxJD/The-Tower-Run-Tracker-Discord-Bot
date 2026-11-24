import { expect, it } from 'vitest';
import { resolveAnalysisChartValue } from './analysis-handlers';

it('chart coverage uses the same canonical game report counts, including zero and missing values', () => {
  const run = { totalEnemies: '1 000', killsWithBlackHole: '0', taggedByDeathWave: '450',
    coverageOrbsPct: '97', coverageBhPct: '92', coverageDwPct: '50', enemiesHitByOrbs: '970',
    rawParseFields: { killsWithOrbs: '525[52,5%]' } };
  expect(resolveAnalysisChartValue('coverageBhPct', run)).toBe(0);
  expect(resolveAnalysisChartValue('coverageOrbsPct', run)).toBe(52.5);
  expect(resolveAnalysisChartValue('coverageDwPct', run)).toBe(45);
  expect(resolveAnalysisChartValue('coverageOrbsPct', { ...run, rawParseFields: {} })).toBeNull();
});
