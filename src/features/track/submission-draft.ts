import { createHash } from 'node:crypto';

export const PENDING_RUN_INACTIVITY_MS = 5 * 60 * 1000;
export function submissionDraftVersion(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 32);
}
export function isOwnedLiveSubmissionDraft(record: { token?: unknown; userId?: unknown; createdAt?: unknown; lastActivity?: unknown } | null,
  token: string, userId: string, now = Date.now()): boolean {
  if (!record || record.token !== token || record.userId !== userId) return false;
  const activity = record.lastActivity ?? record.createdAt;
  return typeof activity === 'number' && Number.isSafeInteger(activity) && now - activity <= PENDING_RUN_INACTIVITY_MS;
}
