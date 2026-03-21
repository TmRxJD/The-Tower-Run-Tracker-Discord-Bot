import { canonicalizeTrackerRunData } from './run-data-normalization'

export type RunDataRecord = Record<string, unknown> & {
  localId?: unknown
  tier?: unknown
  tierDisplay?: unknown
  tierHasPlus?: unknown
  wave?: unknown
  roundDuration?: unknown
  duration?: unknown
  totalCoins?: unknown
  totalCells?: unknown
  totalDice?: unknown
  rerollShards?: unknown
  dice?: unknown
  coins?: unknown
  cells?: unknown
  killedBy?: unknown
  date?: unknown
  time?: unknown
  type?: unknown
  notes?: unknown
  note?: unknown
  runId?: unknown
}

export type PendingRecordScreenshot = {
  url: string
  name?: string
  contentType?: string
} | null

export type PendingRecordLike = {
  userId: string
  username: string
  runData: RunDataRecord
  canonicalRunData?: RunDataRecord | null
  screenshot?: PendingRecordScreenshot
  decimalPreference?: string
  isDuplicate?: boolean
  defaultRunType?: string
}

export function toRunDataRecord(value: unknown): RunDataRecord {
  return (typeof value === 'object' && value !== null ? value : {}) as RunDataRecord
}

export function toPendingRecord(value: unknown): PendingRecordLike | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.userId !== 'string' || typeof record.username !== 'string') return null
  return {
    userId: record.userId,
    username: record.username,
    runData: canonicalizeTrackerRunData(toRunDataRecord(record.runData)),
    canonicalRunData: record.canonicalRunData ? canonicalizeTrackerRunData(toRunDataRecord(record.canonicalRunData)) : null,
    screenshot: (record.screenshot ?? null) as PendingRecordScreenshot,
    decimalPreference: typeof record.decimalPreference === 'string' ? record.decimalPreference : undefined,
    isDuplicate: typeof record.isDuplicate === 'boolean' ? record.isDuplicate : undefined,
    defaultRunType: typeof record.defaultRunType === 'string' ? record.defaultRunType : undefined,
  }
}