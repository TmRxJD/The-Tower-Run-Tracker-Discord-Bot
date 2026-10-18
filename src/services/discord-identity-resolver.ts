import { Query, Users } from 'node-appwrite';
import {
  resolveTrackerDiscordAppwriteUserId,
  TrackerIdentityNotFoundError,
  TRACKER_IDENTITY_NOT_FOUND_CODE,
} from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../persistence/appwrite-client';
import { getTrackerKv, setTrackerKv } from './idb';
import { logger } from '../core/logger';

export { TrackerIdentityNotFoundError, TRACKER_IDENTITY_NOT_FOUND_CODE };

const KV_PREFIX = 'tracker:discord-appwrite-id:v1:';
const CACHE_TTL_MS = 60_000;
const runtimeCache = new Map<string, string | null>();
const runtimeCachedAt = new Map<string, number>();

type CachedEntry = {
  appwriteId: string | null;
  cachedAt: number;
};

/** Local display/recovery hint only; never authorizes cloud writes. */
export async function getStoredAppwriteIdForDiscordUser(discordId: string): Promise<string | null> {
  const entry = await getTrackerKv<CachedEntry>(KV_PREFIX + discordId.trim());
  return typeof entry?.appwriteId === 'string' && entry.appwriteId.trim() ? entry.appwriteId : null;
}

export async function resolveAppwriteIdForDiscordUser(
  discordId: string,
  options: { requireLinked?: boolean; failOnLookupError?: boolean } = {},
): Promise<string | null> {
  const normalized = discordId.trim();
  if (Date.now() - (runtimeCachedAt.get(normalized) ?? 0) >= CACHE_TTL_MS) {
    runtimeCache.delete(normalized);
    runtimeCachedAt.delete(normalized);
  }
  const { client } = createAppwriteClient();
  return resolveTrackerDiscordAppwriteUserId({
    discordUserId: discordId,
    requireLinked: options.requireLinked,
    usersApi: new Users(client),
    identityQueries: [
      Query.equal('provider', 'discord'),
      Query.equal('providerUid', discordId.trim()),
    ],
    runtimeCache,
    kvCache: {
      read: async (discordUserId) => {
        const entry = await getTrackerKv<CachedEntry>(`${KV_PREFIX}${discordUserId}`).catch(() => null);
        if (!entry) return undefined;
        if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return undefined;
        return entry.appwriteId;
      },
      write: async (discordUserId, appwriteUserId) => {
        await setTrackerKv(`${KV_PREFIX}${discordUserId}`, {
          appwriteId: appwriteUserId,
          cachedAt: Date.now(),
        } satisfies CachedEntry).catch(() => {});
      },
    },
    onResolved: ({ discordUserId, appwriteUserId }) => {
      runtimeCachedAt.set(discordUserId, Date.now());
      while (runtimeCache.size > 1_024) {
        const oldest = runtimeCache.keys().next().value;
        if (!oldest) break;
        runtimeCache.delete(oldest);
        runtimeCachedAt.delete(oldest);
      }
      if (appwriteUserId) {
        logger.info('[identity] Discord → Appwrite resolved', { discordUserId, appwriteUserId });
      } else {
        logger.debug('[identity] no Appwrite OAuth identity for Discord user', { discordUserId });
      }
    },
    onResolveFailed: ({ discordUserId, error }) => {
      logger.warn('[identity] failed to resolve Appwrite account for Discord user', { discordUserId, error });
      if (options.failOnLookupError) throw new Error('Run history identity lookup failed. Please retry.');
    },
  });
}

export async function refreshAppwriteIdForDiscordUser(discordId: string): Promise<string | null> {
  runtimeCache.delete(discordId.trim());
  runtimeCachedAt.delete(discordId.trim());
  await setTrackerKv(`${KV_PREFIX}${discordId.trim()}`, { appwriteId: null, cachedAt: 0 } satisfies CachedEntry).catch(() => {});
  return resolveAppwriteIdForDiscordUser(discordId);
}
