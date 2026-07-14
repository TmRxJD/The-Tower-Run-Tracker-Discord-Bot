/**
 * Share buttons must survive bot restarts, so they carry the sharer + run identity in
 * the custom id rather than pointing at an in-memory cache entry.
 */

const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function buildShareRunRef(userId: string, run: Record<string, unknown>): string | null {
  const owner = readTrimmedString(userId);
  const target = readTrimmedString(run.localId) || readTrimmedString(run.runId);
  if (!owner || !target) return null;
  if (owner.includes(':') || target.includes(':')) return null;
  return `${owner}:${target}`;
}

export function parseShareRunRef(ref: string): { userId: string; runRef: string } | null {
  const separatorIndex = ref.indexOf(':');
  if (separatorIndex <= 0) return null;

  const userId = ref.slice(0, separatorIndex).trim();
  const runRef = ref.slice(separatorIndex + 1).trim();
  if (!userId || !runRef) return null;

  return { userId, runRef };
}

/** Discord rejects custom ids over 100 chars; drop the button instead of failing the send. */
export function fitsShareCustomId(prefix: string, ref: string): boolean {
  return `${prefix}${ref}`.length <= DISCORD_CUSTOM_ID_MAX_LENGTH;
}
