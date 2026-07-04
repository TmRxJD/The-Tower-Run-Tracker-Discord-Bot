import { randomUUID } from 'node:crypto';
import type { SaveImportTrackerDiscovery, SaveImportTrackerKey } from '@tmrxjd/platform/tools';

export type ImportTrackerOutcome = {
  key: SaveImportTrackerKey;
  label: string;
  status: 'imported' | 'skipped' | 'failed';
  message: string;
  importedCount?: number;
};

export type ImportPendingSession = {
  token: string;
  userId: string;
  parsedRoot: Record<string, unknown>;
  runs: Record<string, unknown>[];
  discoveries: SaveImportTrackerDiscovery[];
  selectedTrackerKeys: SaveImportTrackerKey[];
  skippedDuplicates: number;
  totalInSave: number;
  importOutcomes?: ImportTrackerOutcome[];
  createdAt: number;
};

const sessions = new Map<string, ImportPendingSession>();

export function createImportPendingSession(input: Omit<ImportPendingSession, 'token' | 'createdAt' | 'importOutcomes'>): ImportPendingSession {
  const token = randomUUID();
  const session: ImportPendingSession = {
    ...input,
    token,
    createdAt: Date.now(),
  };
  sessions.set(token, session);
  return session;
}

export function getImportPendingSession(token: string): ImportPendingSession | null {
  return sessions.get(token) ?? null;
}

export function updateImportPendingSession(
  token: string,
  patch: Partial<Pick<ImportPendingSession, 'selectedTrackerKeys' | 'importOutcomes'>>,
): ImportPendingSession | null {
  const current = sessions.get(token);
  if (!current) return null;
  const next = { ...current, ...patch };
  sessions.set(token, next);
  return next;
}

export function deleteImportPendingSession(token: string): void {
  sessions.delete(token);
}

export function purgeExpiredImportSessions(maxAgeMs = 30 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [token, session] of sessions.entries()) {
    if (session.createdAt < cutoff) {
      sessions.delete(token);
    }
  }
}
