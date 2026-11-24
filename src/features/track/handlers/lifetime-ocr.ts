import { parseLifetimeTrackerOcrText, type LifetimeTrackerOcrEntry } from '@tmrxjd/platform/tools'
import { normalizeOcrReportMetric } from '../shared/report-number'

export type LifetimeEntryData = LifetimeTrackerOcrEntry

export function parseLifetimeStatsFromOcrText(ocrText: string): LifetimeEntryData | null {
  // The shared parser owns field labels and dates, but otherwise strips all commas.
  const lines = ocrText.split(/\r?\n/).flatMap(line => {
    const start = line.search(/[\d$]/)
    if (start < 0) return [line]
    const label = line.slice(0, start)
    if (/game\s*started|games?started|games? played|total games/i.test(label)) return [line]
    const value = line.slice(start).trim()
    const currency = value.startsWith('$') ? '$' : ''
    const normalized = normalizeOcrReportMetric(value.slice(currency.length))
    return normalized === null ? [] : [label + currency + normalized]
  })
  return parseLifetimeTrackerOcrText(lines)
}
