import { z } from 'zod';
import { getTrackerKv, setTrackerKv } from '../../services/idb';
const schema = z.object({ version: z.literal(1), checkedAt: z.number().positive(), documents: z.array(z.record(z.string(), z.unknown())) });
const key = (userId: string) => 'tracker-verified-history:v1:' + userId;
export async function readVerifiedHistorySnapshot(userId: string) {
  const parsed = schema.safeParse(await getTrackerKv(key(userId)));
  return parsed.success && parsed.data.documents.every(row => typeof row.$id === 'string' && typeof row.userId === 'string') ? parsed.data : null;
}
/** Only full, validated cloud observations enter this fallback snapshot; it is never a fresh-online cache. */
export async function saveVerifiedHistorySnapshot(userId: string, documents: Record<string, unknown>[]) {
  await setTrackerKv(key(userId), { version: 1, checkedAt: Date.now(), documents }, { requirePersistent: true });
}
