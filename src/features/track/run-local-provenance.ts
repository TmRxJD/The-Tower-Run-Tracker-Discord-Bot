import { getTrackerKv, setTrackerKv } from '../../services/idb';

type OriginalTarget = { profileId: string | null };
const tails = new Map<string, Promise<unknown>>();
const key = (userId: string, localId: string) => `tracker-original-target:v1:${userId}:${localId}`;

export async function getOriginalRunTarget(userId: string, localId: unknown): Promise<OriginalTarget | null> {
  if (typeof localId !== 'string' || !localId.trim()) return null;
  const value = await getTrackerKv<OriginalTarget>(key(userId, localId));
  return value && (value.profileId === null || typeof value.profileId === 'string') ? value : null;
}

/** Future offline provenance only: absence remains unknown; never restamp an original target. */
export async function rememberOriginalRunTarget(userId: string, localId: string, profileId: string | null | undefined): Promise<void> {
  if (profileId === undefined) return;
  const storageKey = key(userId, localId);
  const pending = (tails.get(storageKey) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (await getOriginalRunTarget(userId, localId)) return;
    await setTrackerKv(storageKey, { profileId }, { requirePersistent: true });
  });
  tails.set(storageKey, pending);
  try { await pending; }
  finally { if (tails.get(storageKey) === pending) tails.delete(storageKey); }
}
