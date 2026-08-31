import { Query } from 'node-appwrite';
import {
  altIndexForProfileId,
  orderedAltProfiles,
  resolveAltProfileIdByIndex,
  type ProfileIndexEntry,
} from '@tmrxjd/platform/tools';
import { createAppwriteClient } from '../../persistence/appwrite-client';
import { resolveBotRunCloudIdentity } from './run-cloud-identity';

const PROFILES_DATABASE_ID = 'users';
const PROFILES_COLLECTION_ID = 'account-profiles';

/**
 * Per-user upload target for the CURRENT `/track` command (null = Main). Set on every
 * command entry so it is never stale, and READ (not consumed) at the single run-write
 * choke point so a multi-run savefile import stamps every run with the same target.
 *
 * Existing-run re-writes (migration/backfill) are unaffected even if a stale target
 * were present, because the platform pair-writer never re-stamps an existing run's
 * profileId — so a Main run can never be dragged onto an alt by this carrier.
 */
const pendingTargetByDiscordUser = new Map<string, string | null>();

export function setPendingUploadProfile(discordUserId: string, profileId: string | null): void {
  pendingTargetByDiscordUser.set(discordUserId.trim(), profileId ?? null);
}

export function peekPendingUploadProfile(discordUserId: string): string | null {
  return pendingTargetByDiscordUser.get(discordUserId.trim()) ?? null;
}

/** A profile the bot can target, as shown in the interactive UI. index 0 = Main, 1-4 = alt slot. */
export type BotProfileOption = {
  id: string;
  name: string;
  isPrimary: boolean;
  index: number;
  /** The stored cross-platform default-upload flag (only ever set on an alt). */
  isDefault: boolean;
};

/** Raw account-profiles document, narrowed to the fields the bot reads. */
type ProfileDoc = ProfileIndexEntry & { name: string; isDefault: boolean };

/** Fetch the caller's Appwrite id + account-profiles, or an error the caller can surface. */
async function fetchProfileDocs(discordUserId: string): Promise<{
  appwriteUserId: string | null;
  profiles: ProfileDoc[];
  error?: string;
}> {
  const identity = await resolveBotRunCloudIdentity(discordUserId);
  const appwriteUserId = identity.cloudWriteUserId ?? identity.activeUserId ?? null;
  if (!appwriteUserId) {
    return {
      appwriteUserId: null,
      profiles: [],
      error: 'Link your Discord account on the Tower Run Tracker website first.',
    };
  }

  const { databases } = createAppwriteClient();
  const res = await databases.listDocuments(PROFILES_DATABASE_ID, PROFILES_COLLECTION_ID, [
    Query.equal('userId', appwriteUserId),
    Query.limit(100),
  ]);
  const profiles: ProfileDoc[] = res.documents.map(doc => ({
    id: String((doc as { $id?: unknown }).$id ?? ''),
    name: String((doc as { name?: unknown }).name ?? '').trim() || 'Profile',
    isPrimary: (doc as { isPrimary?: unknown }).isPrimary === true,
    isDefault: (doc as { isDefault?: unknown }).isDefault === true,
    createdAt: String((doc as { createdAt?: unknown }).createdAt ?? ''),
  }));
  return { appwriteUserId, profiles };
}

/**
 * List a user's profiles for the interactive UI, Main first (index 0) then alts in the
 * same creation order the site and the `/track alt:N` option use (index 1..4).
 * Returns an empty list when the account is unlinked or the lookup fails.
 */
export async function listBotUserProfiles(discordUserId: string): Promise<BotProfileOption[]> {
  try {
    const { profiles } = await fetchProfileDocs(discordUserId);
    if (!profiles.length) return [];
    const primary = profiles.find(profile => profile.isPrimary) ?? null;
    const alts = orderedAltProfiles(profiles);
    const options: BotProfileOption[] = [];
    if (primary) {
      options.push({ id: primary.id, name: primary.name, isPrimary: true, index: 0, isDefault: false });
    }
    alts.forEach((alt, i) => {
      const doc = alt as ProfileDoc;
      options.push({ id: doc.id, name: doc.name, isPrimary: false, index: i + 1, isDefault: doc.isDefault });
    });
    return options;
  } catch {
    return [];
  }
}

/**
 * The user's default upload profile. null = Main. Stored cross-platform (site + bot share
 * it) as the `isDefault` flag on the account-profiles collection — only ever set on an
 * alt, so "no alt flagged" transparently means Main.
 */
export async function resolveDefaultUploadProfileId(discordUserId: string): Promise<string | null> {
  try {
    const { profiles } = await fetchProfileDocs(discordUserId);
    const flagged = profiles.find(profile => profile.isDefault && !profile.isPrimary);
    return flagged ? flagged.id : null;
  } catch {
    return null;
  }
}

/**
 * Set the user's default upload profile cross-platform: flag the chosen ALT's
 * account-profiles doc `isDefault=true` and clear it on every other doc. Passing null
 * (Main) clears the flag on all docs. All writes go through the bot's admin Appwrite
 * client. Main is never flagged, so this can never make Main "an alt".
 */
export async function setDefaultUploadProfileId(discordUserId: string, profileId: string | null): Promise<ProfileRenameResult> {
  const { profiles, error } = await fetchProfileDocs(discordUserId);
  if (error) return { ok: false, error };

  if (profileId) {
    const target = profiles.find(profile => profile.id === profileId);
    if (!target) return { ok: false, error: 'That profile no longer exists.' };
    if (target.isPrimary) return { ok: false, error: 'Main is the default when no alt is selected.' };
  }

  const { databases } = createAppwriteClient();
  // Clear every other profile's flag FIRST, then set the chosen one LAST. If any write
  // throws mid-way, the worst case is "no alt flagged yet" — which reads back as Main
  // (safe) — never two simultaneous defaults. Doing it in the other order could leave the
  // new flag set alongside a stale one and make the default ambiguous.
  const target = profileId != null ? profiles.find(profile => profile.id === profileId && !profile.isPrimary) ?? null : null;
  for (const profile of profiles) {
    if (target && profile.id === target.id) continue; // handled last
    if (profile.isDefault === false) continue; // already cleared, no-op write avoided
    await databases.updateDocument(PROFILES_DATABASE_ID, PROFILES_COLLECTION_ID, profile.id, {
      isDefault: false,
    });
  }
  if (target && target.isDefault !== true) {
    await databases.updateDocument(PROFILES_DATABASE_ID, PROFILES_COLLECTION_ID, target.id, {
      isDefault: true,
    });
  }
  return { ok: true };
}

export type UploadProfileResolution = { profileId: string | null; error?: string };

/**
 * Resolve which profile a `/track` upload targets. `altIndex` (1-4) picks that alt.
 * When `altIndex` is null (option omitted) the user's stored default upload profile is
 * used, falling back to Main when unset or no longer valid. Returns an `error` when an
 * explicit alt index has no matching alt so the caller can refuse rather than silently
 * write to Main.
 */
export async function resolveBotUploadProfileId(
  discordUserId: string,
  altIndex: number | null,
): Promise<UploadProfileResolution> {
  if (altIndex == null) {
    // No explicit alt on the command → honour the stored default (validated; Main if unset).
    const defaultProfileId = await resolveDefaultUploadProfileId(discordUserId);
    return { profileId: defaultProfileId };
  }

  const { profiles, error } = await fetchProfileDocs(discordUserId);
  if (error) {
    return { profileId: null, error };
  }

  const profileId = resolveAltProfileIdByIndex(profiles, altIndex);
  if (!profileId) {
    const altCount = profiles.filter(profile => !profile.isPrimary).length;
    return {
      profileId: null,
      error: altCount === 0
        ? 'You have no alt profiles yet — create one on the Tower Run Tracker website.'
        : `You don't have an alt #${altIndex}. You currently have ${altCount} alt${altCount === 1 ? '' : 's'} (use 1-${altCount}).`,
    };
  }
  return { profileId };
}

export type ProfileRenameResult = { ok: boolean; error?: string; name?: string };

/**
 * Rename one of the user's ALT profiles via the bot's admin Appwrite client. Refuses to
 * touch the primary/Main profile or a profile that does not belong to the caller, so the
 * bot can never rename another account's data or disturb Main.
 */
export async function renameBotUserProfile(
  discordUserId: string,
  profileId: string,
  rawName: string,
): Promise<ProfileRenameResult> {
  const name = rawName.trim().slice(0, 60);
  if (!name) return { ok: false, error: 'Please provide a non-empty name.' };

  const { profiles, error } = await fetchProfileDocs(discordUserId);
  if (error) return { ok: false, error };

  const target = profiles.find(profile => profile.id === profileId);
  if (!target) return { ok: false, error: 'That profile no longer exists.' };
  if (target.isPrimary) {
    return { ok: false, error: 'Main cannot be renamed from the bot. Manage it on the website.' };
  }

  const { databases } = createAppwriteClient();
  await databases.updateDocument(PROFILES_DATABASE_ID, PROFILES_COLLECTION_ID, profileId, { name });
  return { ok: true, name };
}

/** Human-readable name for a stored profile id (Main when null / unknown). */
export function formatProfileDisplayName(
  options: readonly BotProfileOption[],
  profileId: string | null | undefined,
): string {
  if (!profileId) return 'Main';
  const match = options.find(option => option.id === profileId);
  if (!match) return 'Main';
  return match.isPrimary ? 'Main' : match.name;
}

/** Re-export so callers can map a profile id back to its 1-based alt slot without another import. */
export { altIndexForProfileId };
