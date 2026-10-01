import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTrackerRunDeltaBaseline, getDeltaAnnotationForStat } from '@tmrxjd/platform/tools';
import { generateCoverageDescription } from '../handlers/upload-helpers';
const key = 'hitByOrbsPercentage';
const now = Date.parse('2026-10-01T12:00:00Z');
const run = (id: string, hours: number, extra: Record<string, unknown> = {}) => ({ id, type: 'Farming', date: new Date(now - hours * 3600000).toISOString(), totalEnemies: '1000', coins: '100', ...extra });
const current = run('current', 0, { killsWithOrbs: '840' });
afterEach(() => vi.restoreAllMocks());
function compare(history: Record<string, unknown>[], mode: '1day' | 'last' = '1day', value = current) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const result = computeTrackerRunDeltaBaseline([value, ...history], 'Farming', mode, String(value.id))!;
  return { result, annotation: getDeltaAnnotationForStat(value, key, result.baseline, result.coverageBasis) };
}
describe('patched corrected Orbs comparisons', () => {
  it('uses compatible rolling references without changing other metric pools', () => {
    const history = [run('new', 1, { killsWithOrbs: '800', coins: '200' }), run('old', 2, { enemiesHitByOrbs: '500', coins: '400' })];
    const original = structuredClone(history);
    const { result, annotation } = compare(history);
    expect(result.baseline[key]).toBe(80);
    expect(result.baseline.coins).toBe(300);
    expect(annotation).toBe('(+5.00%)');
    expect(history).toEqual(original);
  });
  it('averages compatible-only values', () => {
    const { result } = compare([run('a', 1, { killsWithOrbs: '600' }), run('b', 2, { killsWithOrbs: '800' })]);
    expect(result.baseline[key]).toBe(70);
  });
  it('does not use out-of-window Orbs fallback while preserving other fallback metrics', () => {
    const { result, annotation } = compare([run('outside', 48, { killsWithOrbs: '800', coins: '200' })]);
    expect(result.baseline[key]).toBeUndefined();
    expect(result.baseline.coins).toBe(200);
    expect(annotation).toBe('(comparison unavailable)');
  });
  it('Last Run never skips an incompatible prior run', () => {
    expect(compare([run('previous', 1, { enemiesHitByOrbs: '500' }), run('older', 2, { killsWithOrbs: '800' })], 'last').annotation).toBe('(comparison unavailable)');
    expect(compare([run('previous', 1, { killsWithOrbs: '800' })], 'last').annotation).toBe('(+5.00%)');
  });
  it('uses only explicitly parsed raw kills and ignores obsolete stored percentages', () => {
    const { annotation } = compare([run('raw', 1, { rawParseFields: { killsWithOrbs: '800' }, hitByOrbsPercentage: 20 })]);
    expect(annotation).toBe('(+5.00%)');
    expect(compare([run('hits', 1, { rawParseFields: { enemiesHitByOrbs: '800' } })]).annotation).toBe('(comparison unavailable)');
  });
  it('preserves zeros and refuses undefined relative comparisons', () => {
    expect(compare([run('zero', 1, { killsWithOrbs: '0', enemiesHitByOrbs: '900' })]).annotation).toContain('zero baseline');
    expect(compare([run('previous', 1, { killsWithOrbs: '800' })], 'last', run('current', 0, { killsWithOrbs: '0' })).annotation).toBe('(-100.00%)');
  });
  it('missing, empty and legacy counts never become corrected zeros', () => {
    for (const extra of [{}, { killsWithOrbs: '' }, { enemiesHitByOrbs: '840' }]) {
      expect(compare([run('previous', 1, { killsWithOrbs: '800' })], 'last', run('current', 0, extra)).annotation).toBe('(comparison unavailable)');
    }
  });
  it('renders the comparison beside Orbs including raw-count and zero cases', () => {
    const value = run('current', 0, { rawParseFields: { killsWithOrbs: '840' } });
    const { annotation } = compare([run('previous', 1, { killsWithOrbs: '800' })], 'last', value);
    expect(generateCoverageDescription(value, { getDeltaAnnotation: () => ' ' + annotation })).toContain('Orbs: 84% (+5.00%)');
    expect(generateCoverageDescription(run('zero', 0, { killsWithOrbs: '0' }))).toContain('Orbs: 0%');
    expect(generateCoverageDescription(current, { getDeltaAnnotation: () => ' (comparison unavailable)' })).toContain('Orbs: 84% (comparison unavailable)');
  });
});

it('selected-run Orbs references leave existing other-metric selection unchanged', () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const previous = run('previous', 1, { killsWithOrbs: '800', coins: '200' });
  const result = computeTrackerRunDeltaBaseline([current, previous], 'Farming', 'last', undefined, current);
  expect(result.baseline.coins).toBe(100);
  expect(result.baseline.hitByOrbsPercentage).toBe(80);
  expect(getDeltaAnnotationForStat(current, key, result.baseline, result.coverageBasis)).toBe('(+5.00%)');
});
