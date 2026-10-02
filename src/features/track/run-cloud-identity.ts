import {
  buildTrackerRunIdentityContext,
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
const IDENTITY_CACHE_TTL_MS = 60_000;
const MAX_IDENTITY_CACHE_ENTRIES = 1_024;

/**
 * Canonical bot run identity resolution.
 *
 * - Local persistence (RxDB scope, SQLite buckets): Discord snowflake only.
 * - Cloud run documents: Appwrite account ID from OAuth identity link (no env user maps).
 * - Cloud reads: `lookupUserIds` includes Appwrite + Discord for legacy rows.
 */
export async function resolveBotRunCloudIdentity(discordUserId: string): Promise<BotRunCloudIdentity> {
  const normalized = discordUserId.trim();
  if (Date.now() - (cachedAtByDiscordUser.get(normalized) ?? 0) >= IDENTITY_CACHE_TTL_MS) {
    invalidateBotRunCloudIdentityCache(normalized);
  }
  const existing = identityPromiseByDiscordUser.get(normalized);
  if (existing) {
    // Keep misses observable while the bounded cache entry is valid.
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
    // A process-wide JWT does not prove which Discord caller owns that account.
    const appwriteUserId = await resolveAppwriteIdForDiscordUser(normalized, { failOnLookupError: true });

    const identity = buildTrackerRunIdentityContext({
      appwriteUserId,
      permissionAppwriteUserId: appwriteUserId,
      discordUserId: normalized,
      extraUserIds: [appwriteUserId, normalized],
    });

    const cloudWriteUserId = identity.activeUserId ?? appwriteUserId;
    if (!cloudWriteUserId) {
      // Preserve an observable miss without retaining it for the process lifetime.
      recordDiagnostic('identity.unusable', {
        discordUserId: normalized,
        source: 'fresh',
        hadLinkedAppwriteUserId: Boolean(appwriteUserId),
      });
    }

    return {
      ...identity,
      cloudWriteUserId,
    };
  })();

  identityPromiseByDiscordUser.set(normalized, pending);
  cachedAtByDiscordUser.set(normalized, Date.now());
  while (identityPromiseByDiscordUser.size > MAX_IDENTITY_CACHE_ENTRIES) {
    const oldest = identityPromiseByDiscordUser.keys().next().value;
    if (oldest) invalidateBotRunCloudIdentityCache(oldest);
    else break;
  }
  try { return await pending; }
  catch (error) {
    // A transient lookup failure must neither look like an unlinked account nor poison retries.
    if (identityPromiseByDiscordUser.get(normalized) === pending) {
      identityPromiseByDiscordUser.delete(normalized);
      cachedAtByDiscordUser.delete(normalized);
    }
    throw error;
  }
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
