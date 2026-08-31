import { randomUUID } from 'node:crypto';
import type { SaveImportDiscovery, SaveImportTargetKey } from '@tmrxjd/platform/tools';
import type { BotProfileOption } from '../upload-target-profile';

export type ImportTrackerOutcome = {
  key: SaveImportTargetKey;
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
  discoveries: SaveImportDiscovery[];
  selectedTrackerKeys: SaveImportTargetKey[];
  skippedDuplicates: number;
  totalInSave: number;
  importOutcomes?: ImportTrackerOutcome[];
  /** Profiles the imported runs can target (Main + alts). Empty/1-entry = no selector. */
  profileOptions?: BotProfileOption[];
  /** Selected upload target for the imported runs (null = Main). */
  selectedProfileId?: string | null;
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
  patch: Partial<Pick<ImportPendingSession, 'selectedTrackerKeys' | 'importOutcomes' | 'selectedProfileId'>>,
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
