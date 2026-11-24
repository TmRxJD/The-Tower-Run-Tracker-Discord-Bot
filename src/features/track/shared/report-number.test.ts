import { parseLifetimeStatsFromOcrText } from '../handlers/lifetime-ocr';
import { describe, expect, it } from 'vitest';
import { normalizeKnownRunMetrics, normalizeReportMetric, readTrackerMetricValue } from './report-number';
import { computeTrackerRunDeltaBaseline } from './report-number-deltas';
import { buildShareEmbed } from '../share/share-embed';
import { expandedComparePages } from '../share/compare/compare-model';
import { computeHourlyRate } from '../tracker-helpers';
import { applyEditFieldValue } from '../ui/tracker-review-payloads';
import { formatOCRExtraction, parseRunDataFromText } from '../handlers/upload-helpers';

describe('localized report numbers', () => {
  it('supports both grouping conventions and lets explicit input preference resolve ambiguous notation', () => {
    expect(normalizeReportMetric('1.234,56K')).toBe('1234.56K');
    expect(normalizeReportMetric('1,234.56K')).toBe('1234.56K');
    expect(normalizeReportMetric('1.234.567')).toBe('1234567');
    expect(normalizeReportMetric('1,234K', 'Comma (,)')).toBe('1.234K');
    expect(normalizeReportMetric('1.234K', 'Comma (,)')).toBe('1234K');
    expect(normalizeReportMetric('1,234K', 'Period (.)')).toBe('1234K');
    expect(readTrackerMetricValue(1.234)).toBe(1.234);
    expect(normalizeReportMetric('12 34K')).toBeNull();
    expect(normalizeReportMetric('1,234,56K')).toBeNull();
  });

  it('canonicalizes edits without reinterpreting unchanged prefilled data', () => {
    const run = { totalCoins: '1.234K', localId: '01.234' };
    expect(applyEditFieldValue(run, 'totalCoins', '1.234K', 'Comma (,)').totalCoins).toBe('1.234K');
    const edited = applyEditFieldValue(run, 'totalCoins', '2,34K', 'Comma (,)');
    expect(edited.totalCoins).toBe('2.34K');
    expect(edited.localId).toBe('01.234');
  });

  it('renders the same localized coin values for share, hourly and compare', () => {
    const left = { tier: '11', wave: '1000', roundDuration: '2h', totalCoins: '12,34K', type: 'Farming' };
    const right = { ...left, totalCoins: '24.68K' };
    const embed = buildShareEmbed({ user: { username: 'test' }, run: left, runTypeCounts: {} });
    expect(embed.data.description).toContain('Coins: **12.34K**');
    expect(embed.data.description).toContain('Coins: **6.17K**');
    expect(computeHourlyRate(left.totalCoins, left.roundDuration)).toBe('6.17K');
    const compared = expandedComparePages({ run: left, sharerName: 'test' }, right, {}).map(page => page.text).join('\n');
    expect(compared).toContain('S **12.34K** | Y **24.68K**');
    expect(compared).toContain('S **6.17K** | Y **12.34K**');
  });
});

it('normalizes copied report counts before shared submission validation', () => {
  const raw = 'Battle Report\nBattle Date Mar 21, 2026 13:47\nTier 11\nWave 10\nReal Time 1h\nCoins Earned 1.234,56K\nCells Earned 1,234\nReroll Shards Earned 12,34K';
  expect(parseRunDataFromText(raw)).toMatchObject({ totalCoins: '1234.56K', coins: '1234.56K',
    totalCells: '1234', totalDice: '12.34K', rawParseFields: { totalCoins: '1.234,56K', totalCells: '1,234' } });
});

it('normalizes only known writable metrics, without touching IDs, notes, JSON numbers or raw report data', () => {
  const rawParseFields = { totalCoins: '12,34K' };
  const run = { runId: 'id-01,234', note: 'wave 1,234', totalCoins: '12,34K', totalCells: 1.234,
    rawParseFields, killedBy: 'Boss', killsWithOrbs: '8,00K[92,0%]' };
  expect(normalizeKnownRunMetrics(run)).toEqual({ ...run, totalCoins: '12.34K' });
});

it('uses the same grouped baseline and current metrics for the delta and displayed values', () => {
  const shared = { type: 'Farming', totalCoins: '1,234.56K', roundDuration: '2h', taggedByDeathWave: '500,00K', totalEnemies: '1,000,000' };
  const current = { ...shared, totalCoins: '2.469,12K', taggedByDeathWave: '600,00K' };
  const baseline = computeTrackerRunDeltaBaseline([shared], 'Farming', 'last');
  expect(baseline.baseline.coins).toBe(1234560);
  const embed = buildShareEmbed({ user: { username: 'test' }, run: current, runTypeCounts: {}, deltaResult: baseline });
  expect(embed.data.description).toMatch(/Coins: \*\*2.469M\*\*.*\(\+100.00%\)/);
  const coverage = embed.data.fields?.find(field => field.value.includes('Death Wave:'))?.value;
  expect(coverage).toContain('Death Wave: 60% (+20.00%)');
});

it('retains precision in the local OCR fallback instead of stripping decimals', () => {
  expect(formatOCRExtraction(['Tier 11', 'Wave 1000', 'Coins earned 12,34K',
    'Cells Earned 1 234,56K', 'Reroll Shards Earned 1,234'], null, '')).toMatchObject({
    totalCoins: '12.34K', totalCells: '1234.56K', totalDice: 1234,
  });
});

it('normalizes lifetime OCR counts before upstream comma stripping and preserves dates and currency', () => {
  expect(parseLifetimeStatsFromOcrText('Game Started August 30 2023\nCoins Earned 12,34K\nCells Earned 1.234,56K\nCash Earned $1,234.56K\nWaves Completed 1,234')).toMatchObject({
    gameStarted: '2023-08-30', coinsEarned: '12.34K', cellsEarned: '1234.56K',
    cashEarned: '$1234.56K', wavesCompleted: '1234',
  });
});

it('OCR consumes complete grouped Unicode tokens and never accepts a malformed prefix', () => {
  const vals = formatOCRExtraction(['Tier 11', 'Wave 1000', 'Coins earned 1\u202f234,56K.',
    'Cells Earned 1\u00a0234,56K', 'Reroll Shards Earned 12 34K'], null, '');
  expect(vals).toMatchObject({ totalCoins: '1234.56K', totalCells: '1234.56K', totalDice: '' });
  expect(parseLifetimeStatsFromOcrText('Game Started August 30 2023\nCoins Earned 1,25T.\nCells Earned 12,34K junk')).toMatchObject({
    coinsEarned: '1.25T', cellsEarned: '0', gameStarted: '2023-08-30',
  });
});
