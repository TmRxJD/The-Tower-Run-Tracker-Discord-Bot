/**
 * Resolves the Appwrite account ID for a Discord user by looking up the
 * Discord OAuth identity stored in Appwrite.
 *
 * This is the single authoritative resolver for the Discord → Appwrite mapping.
 * It replaces the old manual DISCORD_TO_APPWRITE_MAP env-var approach.
 *
 * Resolution order:
 *  1. In-memory cache (per process lifetime)
 *  2. SQLite KV cache (24-hour TTL, survives bot restarts)
 *  3. Appwrite Users API — `listIdentities` query by (provider=discord, providerUid=<snowflake>)
 *
 * Returns null if the user has no Discord OAuth identity linked in Appwrite
 * (e.g. they signed up with email/password). In that case, callers fall back to
 * querying runs by the Discord snowflake only.
 */

import { Users, Query } from 'node-appwrite';
import { isTrackerAppwriteUserId, isTrackerDiscordSnowflake } from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../persistence/appwrite-client';
import { getTrackerKv, setTrackerKv } from './idb';
import { logger } from '../core/logger';

const KV_PREFIX = 'tracker:discord-appwrite-id:v1:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type CachedEntry = {
  appwriteId: string | null;
  cachedAt: number;
};

// In-memory runtime cache. Populated on first lookup; survives for process lifetime.
const memCache = new Map<string, string | null>();

async function readKv(discordId: string): Promise<string | null | undefined> {
  const entry = await getTrackerKv<CachedEntry>(`${KV_PREFIX}${discordId}`).catch(() => null);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return undefined; // stale
  return entry.appwriteId; // may be null (confirmed no match)
}

async function writeKv(discordId: string, appwriteId: string | null): Promise<void> {
  await setTrackerKv(`${KV_PREFIX}${discordId}`, { appwriteId, cachedAt: Date.now() } satisfies CachedEntry).catch(() => {});
}

/**
 * Resolves the Appwrite account ID for a Discord user.
 * Returns null if no linked Appwrite account is found.
 */
export async function resolveAppwriteIdForDiscordUser(discordId: string): Promise<string | null> {
  if (!isTrackerDiscordSnowflake(discordId)) return null;

  // 1. In-memory cache
  if (memCache.has(discordId)) {
    return memCache.get(discordId) ?? null;
  }

  // 2. KV cache
  const kv = await readKv(discordId);
  if (kv !== undefined) {
    memCache.set(discordId, kv);
    return kv;
  }

  // 3. Appwrite Users API
  try {
    const { client } = createAppwriteClient();
    const usersApi = new Users(client);
    const result = await usersApi.listIdentities([
      Query.equal('provider', 'discord'),
      Query.equal('providerUid', discordId),
    ]);
    const identity = result.identities?.find(
      (i) => i.provider === 'discord' && i.providerUid === discordId,
    );
    const appwriteId =
      identity?.userId && isTrackerAppwriteUserId(identity.userId)
        ? identity.userId
        : null;

    memCache.set(discordId, appwriteId);
    await writeKv(discordId, appwriteId);

    if (appwriteId) {
      logger.info('[identity] Discord → Appwrite resolved', { discordId, appwriteId });
    } else {
      logger.debug('[identity] no Appwrite OAuth identity for Discord user', { discordId });
    }

    return appwriteId;
  } catch (error) {
    logger.warn('[identity] failed to resolve Appwrite account for Discord user', { discordId, error });
    return null;
  }
}

/**
 * Forces a fresh resolution bypassing both caches (e.g. after a user links
 * their Discord account). Updates the caches with the new result.
 */
export async function refreshAppwriteIdForDiscordUser(discordId: string): Promise<string | null> {
  // Evict in-memory and expire KV so the next call does a live query
  memCache.delete(discordId);
  await setTrackerKv(`${KV_PREFIX}${discordId}`, { appwriteId: null, cachedAt: 0 } satisfies CachedEntry).catch(() => {});
  return resolveAppwriteIdForDiscordUser(discordId);
}
