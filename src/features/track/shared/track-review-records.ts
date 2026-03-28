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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function toRunDataRecord(value: unknown): RunDataRecord {
  return isRecord(value) ? value : {}
}

export function toPendingRecord(value: unknown): PendingRecordLike | null {
  if (!isRecord(value)) return null
  const record = value
  if (typeof record.userId !== 'string' || typeof record.username !== 'string') return null
  const screenshot = isRecord(record.screenshot) && typeof record.screenshot.url === 'string' && record.screenshot.url.trim().length > 0
    ? {
        url: record.screenshot.url,
        name: typeof record.screenshot.name === 'string' ? record.screenshot.name : undefined,
        contentType: typeof record.screenshot.contentType === 'string' ? record.screenshot.contentType : undefined,
      }
    : null
  return {
    userId: record.userId,
    username: record.username,
    runData: canonicalizeTrackerRunData(toRunDataRecord(record.runData)),
    canonicalRunData: record.canonicalRunData ? canonicalizeTrackerRunData(toRunDataRecord(record.canonicalRunData)) : null,
    screenshot,
    decimalPreference: typeof record.decimalPreference === 'string' ? record.decimalPreference : undefined,
    isDuplicate: typeof record.isDuplicate === 'boolean' ? record.isDuplicate : undefined,
    defaultRunType: typeof record.defaultRunType === 'string' ? record.defaultRunType : undefined,
  }
}