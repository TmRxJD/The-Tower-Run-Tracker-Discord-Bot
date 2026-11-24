import { computeHourlyRate as formatHourlyRate } from '@tmrxjd/platform/math';
import { readTrackerMetricValue } from './shared/report-number';
export {
  formatDateToISO,
  formatTimeTo24h,
  normalizeDecimalSeparators,
} from '@tmrxjd/platform/math'

export function computeHourlyRate(value: unknown, duration: Parameters<typeof formatHourlyRate>[1]): string | null {
  const parsed = readTrackerMetricValue(value);
  return parsed === null ? null : formatHourlyRate(parsed, duration);
}
