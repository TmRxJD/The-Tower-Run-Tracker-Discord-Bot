import { TRACKER_DELTA_STAT_KEYS, readTrackerMetricValue as readStrictMetric, readTrackerModuleShardsTotal as readStrictShards } from '@tmrxjd/platform/tools';
import { normalizeDecimalSeparator, standardizeNotation } from '../../../utils/tracker-math';

/** Adapt game-report numeric text at Discord input and display boundaries, not submission validation. */
export function normalizeReportMetric(value: string, preference?: string): string | null {

  // Reports can append the game's percentage, e.g. "653,35K[87,2%]".
  const count = value.trim().replace(/\s*\[\s*\d+(?:[.,]\d+)?\s*%\s*\]$/, '').trim();
  const match = count.match(/^([\d.,\s]+)([A-Za-z]*)$/);
  if (!match) return null;
  const numberText = match[1].trim();
  if (/\s/.test(numberText) && !/^\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/.test(numberText)) return null;
  const numeric = numberText.replace(/\s/g, '');
  // Preserve valid comma thousands; only interpret a single non-grouping comma
  // as a decimal separator. Mixed/malformed separator forms stay unavailable.
  const commaGrouping = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(numeric);
  const commaDecimal = !commaGrouping && /^\d+,\d+$/.test(numeric);
  const europeanMixed = /^\d{1,3}(?:\.\d{3})+,\d+$/.test(numeric);
  const ambiguous = /^\d{1,3}[.,]\d{3}$/.test(numeric);
  const europeanGrouping = /^\d{1,3}(?:\.\d{3}){2,}$/.test(numeric);
  const useComma = commaDecimal || europeanMixed || europeanGrouping || (ambiguous && preference === 'Comma (,)');
  const normalized = normalizeDecimalSeparator(numeric, useComma ? 'Comma (,)' : 'Period (.)');
  const canonical = standardizeNotation(normalized + match[2]);
  return readStrictMetric(canonical) === null ? null : canonical;
}

export function readTrackerMetricValue(value: unknown): number | null {
  return typeof value === 'string' ? readStrictMetric(normalizeReportMetric(value)) : readStrictMetric(value);
}

export const readCoverageCount = readTrackerMetricValue;

export function readTrackerModuleShardsTotal(run: Record<string, unknown>): number | null {
  const canonical: Record<string, unknown> = {};
  for (const key of ['totalModuleShards', 'moduleShards', 'cannonShardsFetched', 'armorShardsFetched', 'generatorShardsFetched', 'coreShardsFetched']) {
    const value = run[key];
    canonical[key] = typeof value === 'string' ? normalizeReportMetric(value) ?? value : value;
  }
  return readStrictShards(canonical);
}

const runMetricKeys = new Set([...TRACKER_DELTA_STAT_KEYS.filter(key => key !== 'duration'),
  'totalCoins', 'totalCells', 'totalDice', 'totalModuleShards', 'dice', 'wave']);

/** Normalize allowlisted values before persistence, never IDs, notes or original report evidence. */
export function normalizeKnownRunMetrics<T extends Record<string, unknown>>(run: T, forPresentation = false): T {
  let normalized: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(run)) {
    if (!runMetricKeys.has(key) || typeof value !== 'string' || !/[,\s\[]|\..*\./.test(value)) continue;
    if (!forPresentation && value.includes('[')) continue;
    const next = normalizeReportMetric(value);
    if (next !== null && next !== value) (normalized ??= { ...run })[key] = next;
  }
  return normalized ? normalized as T : run;
}

/** Numeric OCR rows may end in sentence punctuation, but never parse just a prefix. */
export function normalizeOcrReportMetric(value: string, preference?: string): string | null {
  const token = value.trim().replace(/[.;:]$/, '');
  return normalizeReportMetric(token, preference);
}
