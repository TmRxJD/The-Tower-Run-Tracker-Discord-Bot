import {
  buildTrackerRunIdentityContext,
  extractTrackerAppwriteUserIdFromJwt,
  type TrackerRunIdentityContext,
} from '@tmrxjd/platform/tools';
import { resolveAppwriteIdForDiscordUser } from '../../services/discord-identity-resolver';
import { recordDiagnostic } from '../../core/diagnostics';

export type BotRunCloudIdentity = TrackerRunIdentityContext & {
  /** Appwrite account ID used for cloud document `userId` on writes. */
  cloudWriteUserId: string | null;
};

const identityPromiseByDiscordUser = new Map<string, Promise<BotRunCloudIdentity>>();
/** Diagnostics only: when each cache entry was created, to age a poisoned entry. */
const cachedAtByDiscordUser = new Map<string, number>();

/**
 * Canonical bot run identity resolution.
 *
 * - Local persistence (RxDB scope, SQLite buckets): Discord snowflake only.
 * - Cloud run documents: Appwrite account ID from OAuth identity link (no env user maps).
 * - Cloud reads: `lookupUserIds` includes Appwrite + Discord for legacy rows.
 */
export async function resolveBotRunCloudIdentity(discordUserId: string): Promise<BotRunCloudIdentity> {
  const normalized = discordUserId.trim();
  const existing = identityPromiseByDiscordUser.get(normalized);
  if (existing) {
    // This cache has no TTL and is never invalidated in production, so an entry that
    // resolved to no cloud user during a transient Appwrite failure keeps failing for
    // the life of the process. Flag served-from-cache misses to size that.
    return existing.then((identity) => {
      if (!identity.cloudWriteUserId) {
        recordDiagnostic('identity.unusable', {
          discordUserId: normalized,
          source: 'cache',
          cachedAgeMs: Date.now() - (cachedAtByDiscordUser.get(normalized) ?? Date.now()),
        });
      }
      return identity;
    });
  }

  const pending = (async () => {
    // The identity link is the primary source. When it yields nothing — a user
    // whose Discord account is not linked yet, or a dev run against a single
    // account — fall back to the Appwrite id carried by the session JWT.
    // Without this the run is written with an empty permission set, leaving it
    // unreadable by the very user who created it.
    const linkedAppwriteUserId = await resolveAppwriteIdForDiscordUser(normalized);
    const appwriteUserId = linkedAppwriteUserId
      ?? extractTrackerAppwriteUserIdFromJwt(process.env.APPWRITE_JWT);

    const identity = buildTrackerRunIdentityContext({
      appwriteUserId,
      permissionAppwriteUserId: appwriteUserId,
      discordUserId: normalized,
      extraUserIds: [appwriteUserId, normalized],
    });

    const cloudWriteUserId = identity.activeUserId ?? appwriteUserId;
    if (!cloudWriteUserId) {
      // About to be cached for the process lifetime — record whether the link lookup
      // came back empty or the JWT fallback was simply absent.
      recordDiagnostic('identity.unusable', {
        discordUserId: normalized,
        source: 'fresh',
        hadLinkedAppwriteUserId: Boolean(linkedAppwriteUserId),
        hadJwtFallback: Boolean(process.env.APPWRITE_JWT),
      });
    }

    return {
      ...identity,
      cloudWriteUserId,
    };
  })();

  identityPromiseByDiscordUser.set(normalized, pending);
  cachedAtByDiscordUser.set(normalized, Date.now());
  return pending;
}

export function invalidateBotRunCloudIdentityCache(discordUserId?: string): void {
  if (discordUserId) {
    identityPromiseByDiscordUser.delete(discordUserId.trim());
    cachedAtByDiscordUser.delete(discordUserId.trim());
    return;
  }
  identityPromiseByDiscordUser.clear();
  cachedAtByDiscordUser.clear();
}
