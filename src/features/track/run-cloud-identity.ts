import {
  buildTrackerRunIdentityContext,
  type TrackerRunIdentityContext,
} from '@tmrxjd/platform/tools';
import { resolveAppwriteIdForDiscordUser } from '../../services/discord-identity-resolver';

export type BotRunCloudIdentity = TrackerRunIdentityContext & {
  /** Appwrite account ID used for cloud document `userId` on writes. */
  cloudWriteUserId: string | null;
};

const identityPromiseByDiscordUser = new Map<string, Promise<BotRunCloudIdentity>>();

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
    return existing;
  }

  const pending = (async () => {
    const appwriteUserId = await resolveAppwriteIdForDiscordUser(normalized);
    const identity = buildTrackerRunIdentityContext({
      appwriteUserId,
      permissionAppwriteUserId: appwriteUserId,
      discordUserId: normalized,
      extraUserIds: [appwriteUserId, normalized],
    });

    return {
      ...identity,
      cloudWriteUserId: identity.activeUserId ?? appwriteUserId,
    };
  })();

  identityPromiseByDiscordUser.set(normalized, pending);
  return pending;
}

export function invalidateBotRunCloudIdentityCache(discordUserId?: string): void {
  if (discordUserId) {
    identityPromiseByDiscordUser.delete(discordUserId.trim());
    return;
  }
  identityPromiseByDiscordUser.clear();
}
