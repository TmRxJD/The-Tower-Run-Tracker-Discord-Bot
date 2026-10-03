import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTrackerRunDeltaBaseline, getDeltaAnnotationForStat, buildTrackerRunTableColumnValue, buildTrackerRunDeltaCellMap, buildTrackerRunDeltaCellKey } from '@tmrxjd/platform/tools';
import { generateCoverageDescription } from '../handlers/upload-helpers';
import { buildShareEmbed } from '../share/share-embed';
import { buildSubmissionResultEmbed } from '../ui/tracker-submission-embeds';
const key = 'destroyedByBlackHolePercentage';
const now = Date.parse('2026-10-01T12:00:00Z');
const run = (id: string, hours: number, extra: Record<string, unknown> = {}) => ({ id, type: 'Farming', date: new Date(now - hours * 3600000).toISOString(), totalEnemies: '1000', coins: '100', ...extra });
const current = run('current', 0, { killsWithBlackHole: '840' });
afterEach(() => vi.restoreAllMocks());
function compare(history: Record<string, unknown>[], mode: '1day' | 'last' = '1day', value = current) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const result = computeTrackerRunDeltaBaseline([value, ...history], 'Farming', mode, String(value.id))!;
  return { result, annotation: getDeltaAnnotationForStat(value, key, result.baseline, result.coverageBasis) };
}
describe('patched corrected Black Hole comparisons', () => {
  it('uses compatible rolling references without changing other metric pools', () => {
    const history = [run('new', 1, { killsWithBlackHole: '800', coins: '200' }), run('old', 2, { enemiesHitByBlackHole: '500', coins: '400' })];
    const original = structuredClone(history);
    const { result, annotation } = compare(history);
    expect(result.baseline[key]).toBe(80);
    expect(result.baseline.coins).toBe(300);
    expect(annotation).toBe('(+5.00%)');
    expect(history).toEqual(original);
  });
  it('averages compatible-only values', () => {
    const { result } = compare([run('a', 1, { killsWithBlackHole: '600' }), run('b', 2, { killsWithBlackHole: '800' })]);
    expect(result.baseline[key]).toBe(70);
  });
  it('does not use out-of-window Black Hole fallback while preserving other fallback metrics', () => {
    const { result, annotation } = compare([run('outside', 48, { killsWithBlackHole: '800', coins: '200' })]);
    expect(result.baseline[key]).toBeUndefined();
    expect(result.baseline.coins).toBe(200);
    expect(annotation).toBe('(comparison unavailable)');
  });
  it('Last Run never skips an incompatible prior run', () => {
    expect(compare([run('previous', 1, { enemiesHitByBlackHole: '500' }), run('older', 2, { killsWithBlackHole: '800' })], 'last').annotation).toBe('(comparison unavailable)');
    expect(compare([run('previous', 1, { killsWithBlackHole: '800' })], 'last').annotation).toBe('(+5.00%)');
  });
  it('uses only explicitly parsed raw kills and ignores obsolete stored percentages', () => {
    const { annotation } = compare([run('raw', 1, { rawParseFields: { killsWithBlackHole: '800' }, destroyedByBlackHolePercentage: 20 })]);
    expect(annotation).toBe('(+5.00%)');
    expect(compare([run('hits', 1, { rawParseFields: { enemiesHitByBlackHole: '800' } })]).annotation).toBe('(comparison unavailable)');
  });
  it('preserves zeros and refuses undefined relative comparisons', () => {
    expect(compare([run('zero', 1, { killsWithBlackHole: '0', enemiesHitByBlackHole: '900' })]).annotation).toContain('zero baseline');
    expect(compare([run('previous', 1, { killsWithBlackHole: '800' })], 'last', run('current', 0, { killsWithBlackHole: '0' })).annotation).toBe('(-100.00%)');
  });
  it('missing, empty and legacy counts never become corrected zeros', () => {
    for (const extra of [{}, { killsWithBlackHole: '' }, { enemiesHitByBlackHole: '840' }]) {
      expect(compare([run('previous', 1, { killsWithBlackHole: '800' })], 'last', run('current', 0, extra)).annotation).toBe('(comparison unavailable)');
    }
  });
  it('renders the comparison beside Black Hole including raw-count and zero cases', () => {
    const value = run('current', 0, { rawParseFields: { killsWithBlackHole: '840' } });
    const { annotation } = compare([run('previous', 1, { killsWithBlackHole: '800' })], 'last', value);
    expect(generateCoverageDescription(value, { getDeltaAnnotation: () => ' ' + annotation })).toContain('Black Hole: 84% (+5.00%)');
    expect(generateCoverageDescription(run('zero', 0, { killsWithBlackHole: '0' }))).toContain('Black Hole: 0%');
    expect(generateCoverageDescription(current, { getDeltaAnnotation: () => ' (comparison unavailable)' })).toContain('Black Hole: 84% (comparison unavailable)');
  });
});

it('keeps hit counts, weapon kills and corrected effect-active kills distinct in all coverage values', () => {
  const value = run('current', 0, { killsWithBlackHole: '840', enemiesHitByBlackHole: '970', destroyedByBlackHole: '120', destroyedByBlackHolePercentage: 12 });
  const { result, annotation } = compare([run('previous', 1, { killsWithBlackHole: '800', destroyedByBlackHolePercentage: 50 })], 'last', value);
  expect(annotation).toBe('(+5.00%)'); expect(buildTrackerRunTableColumnValue(value, 'Black Hole')).toBe('84%');
  expect(generateCoverageDescription(value)).toContain('Black Hole: 84%');
  const share = buildShareEmbed({ user: { username: 'fixture' }, run: value, runTypeCounts: { Farming: 2 }, deltaResult: result });
  expect(JSON.stringify(share.data)).toContain('Black Hole: 84% (+5.00%)');
  expect(JSON.stringify(buildShareEmbed({ user: { username: 'fixture' }, run: value, runTypeCounts: { Farming: 2 }, options: { includeCoverageBlackHole: false } }).data)).not.toContain('Black Hole:');
  const submission = buildSubmissionResultEmbed({ data: value, isUpdate: false, runTypeCounts: { Farming: 2 }, hasScreenshot: false, deltaResult: result });
  expect(JSON.stringify(submission.data)).toContain('Black Hole: 84% (+5.00%)');
});
it('table/chart values recover only explicit raw corrected fields and preserve zero/unavailable denominators', () => {
  expect(buildTrackerRunTableColumnValue(run('raw', 0, { rawParseFields: { killsWithBlackHole: '840', totalEnemies: '1000' }, destroyedByBlackHolePercentage: 10 }), 'Black Hole')).toBe('84%');
  expect(buildTrackerRunTableColumnValue(run('zero', 0, { killsWithBlackHole: '0', enemiesHitByBlackHole: '900', destroyedByBlackHolePercentage: 90 }), 'Black Hole')).toBe('0%');
  expect(buildTrackerRunTableColumnValue(run('invalid', 0, { killsWithBlackHole: '0', totalEnemies: '0', destroyedByBlackHolePercentage: 90 }), 'Black Hole')).toBe('N/A');
  expect(compare([run('weapon', 1, { destroyedByBlackHole: '800' })]).annotation).toBe('(comparison unavailable)');
});
it.each(['1day', '3day', '7day', 'last'] as const)('chart delta cells use compatible Black Hole references for %s', mode => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const previous = run('previous', 1, { killsWithBlackHole: '800' });
  const cells = buildTrackerRunDeltaCellMap([current, previous, run('legacy', 2, { enemiesHitByBlackHole: '500' })], mode, new Set(['current']));
  // Rolling chart cells preserve the established whole-window average (84+80)/2.
  // Selected-run share references and Last Run exclude current: 84 versus80.
  expect(cells.get(buildTrackerRunDeltaCellKey('current', key))?.annotation).toBe(mode === 'last' ? '(+5.00%)' : '(+2.44%)');
});

it('selected-run Black Hole references leave existing other-metric selection unchanged', () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const previous = run('previous', 1, { killsWithBlackHole: '800', coins: '200' });
  const result = computeTrackerRunDeltaBaseline([current, previous], 'Farming', 'last', undefined, current);
  expect(result.baseline.coins).toBe(100);
  expect(result.baseline.destroyedByBlackHolePercentage).toBe(80);
  expect(getDeltaAnnotationForStat(current, key, result.baseline, result.coverageBasis)).toBe('(+5.00%)');
});
