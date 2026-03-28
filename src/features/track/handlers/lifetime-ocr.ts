import { parseLifetimeTrackerOcrText, type LifetimeTrackerOcrEntry } from '@tmrxjd/platform/tools'

export type LifetimeEntryData = LifetimeTrackerOcrEntry

export function parseLifetimeStatsFromOcrText(ocrText: string): LifetimeEntryData | null {
  return parseLifetimeTrackerOcrText(ocrText)
}