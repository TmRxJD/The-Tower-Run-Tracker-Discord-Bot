import { readTrackerMetricValue } from '@tmrxjd/platform/tools';
import { normalizeDecimalSeparator } from '../../../utils/tracker-math';

/** Adapt game-report count text for coverage presentation, not submission validation. */
export function readCoverageCount(value: unknown): number | null {
  if (typeof value === 'number') return readTrackerMetricValue(value);
  if (typeof value !== 'string') return null;
  // Reports can append the game's percentage, e.g. "653,35K[87,2%]".
  const count = value.trim().replace(/\s*\[\s*\d+(?:[.,]\d+)?\s*%\s*\]$/, '').trim();
  const match = count.match(/^([\d.,\s]+)([A-Za-z]*)$/);
  if (!match) return null;
  const numeric = match[1].replace(/\s/g, '');
  // Preserve valid comma thousands; only interpret a single non-grouping comma
  // as a decimal separator. Mixed/malformed separator forms stay unavailable.
  const grouped = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(numeric);
  const commaDecimal = !grouped && /^\d+,\d+$/.test(numeric);
  const normalized = normalizeDecimalSeparator(numeric, commaDecimal ? 'Comma (,)' : 'Period (.)');
  return readTrackerMetricValue(normalized + match[2]);
}
