import { logger } from './logger';

/**
 * Temporary instrumentation for the intermittent "command does nothing until you run it
 * again" reports. Every probe is read-only — nothing here changes control flow.
 *
 * These emit at `warn` on purpose. Prod runs with NODE_ENV=production, which defaults the
 * log level to `warn` (see logger.ts), so `info`/`debug` probes would never reach the pm2
 * logs the reports have to be diagnosed from.
 *
 * Grep the pm2 logs with `[diag]` to pull the whole picture; each event has a stable name
 * so the streams can be correlated by timestamp.
 */
export type DiagnosticEvent =
  /** An interaction was acknowledged (or failed to be) — carries how old it already was. */
  | 'interaction.ack'
  /** A component interaction matched no handler and was dropped without acknowledgement. */
  | 'interaction.dropped'
  /** The shared RxDB was wiped, taking every user's local cache with it. */
  | 'rxdb.destroy'
  /** A handle was handed out — used to size concurrency around a destroy. */
  | 'rxdb.grant'
  /** The menu summary hit the corrupt-cache path that triggers the wipe. */
  | 'rxdb.corrupt-read'
  /** A cached identity resolved to no cloud user, which is cached for the process lifetime. */
  | 'identity.unusable';

export function recordDiagnostic(event: DiagnosticEvent, meta: Record<string, unknown>): void {
  logger.warn(`[diag] ${event}`, meta);
}

/**
 * Discord invalidates an interaction token ~3s after it is created. Sampling how old an
 * interaction already is when we get to it separates "the bot was slow" from "the gateway
 * delivered it late" — the two have very different fixes.
 */
export const INTERACTION_ACK_BUDGET_MS = 3000;

/**
 * Rolling record of recent shared-RxDB handle grants, so a destroy can report how much
 * work was plausibly in flight when it wiped the database. A ring buffer keeps this from
 * growing without bound on a long-lived process.
 */
const GRANT_WINDOW_MS = 30_000;
const MAX_TRACKED_GRANTS = 512;
const recentGrants: { at: number; scopeId: string }[] = [];

export function recordRxDatabaseGrant(scopeId: string): void {
  const now = Date.now();
  recentGrants.push({ at: now, scopeId });
  if (recentGrants.length > MAX_TRACKED_GRANTS) {
    recentGrants.splice(0, recentGrants.length - MAX_TRACKED_GRANTS);
  }
}

export function summarizeRecentRxDatabaseGrants(): {
  grantsInWindow: number;
  distinctScopesInWindow: number;
  msSinceLastGrant: number | null;
} {
  const cutoff = Date.now() - GRANT_WINDOW_MS;
  const inWindow = recentGrants.filter(grant => grant.at >= cutoff);
  const last = recentGrants[recentGrants.length - 1];

  return {
    grantsInWindow: inWindow.length,
    distinctScopesInWindow: new Set(inWindow.map(grant => grant.scopeId)).size,
    msSinceLastGrant: last ? Date.now() - last.at : null,
  };
}
