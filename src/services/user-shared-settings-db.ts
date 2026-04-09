import {
  buildSyncedStateReconcileResult,
  defaultSharedUserToolSettings,
  normalizeSharedUserToolSettings,
  sharedUserToolSettingsSchema,
  type SharedUserToolSettings,
} from '@tmrxjd/platform/tools';
import { logger } from '../core/logger';
import { getTrackerKv, setTrackerKv } from './idb';
import { loadUserSharedSettingsCloud, saveUserSharedSettingsCloud } from './user-shared-settings-cloud';
import { parseDiscordToAppwriteMapFromEnv, resolveCanonicalAppwriteUserId } from '@tmrxjd/platform/tools';

const DISCORD_TO_APPWRITE_MAP = parseDiscordToAppwriteMapFromEnv(process.env);
const SHARED_SETTINGS_PREFIX = 'tracker-shared-settings:';

type LocalSharedSettingsRecord = {
  state: SharedUserToolSettings;
  updatedAt: number;
};

export type SharedSettingsReconcileResult = {
  autoCloudEnabled: boolean;
  hasDifference: boolean;
  direction: 'cloud-newer' | 'local-newer' | 'unknown';
  localUpdatedAt: number | null;
  cloudUpdatedAt: number | null;
  localState: SharedUserToolSettings;
  cloudState: SharedUserToolSettings | null;
  applyCloudToLocal: () => Promise<SharedUserToolSettings | null>;
  applyLocalToCloud: () => Promise<void>;
};

function getStorageKey(userId: string): string {
  return `${SHARED_SETTINGS_PREFIX}${userId}`;
}

function resolveCanonicalSharedUserId(userId: string): string | null {
  const resolved = resolveCanonicalAppwriteUserId(userId, DISCORD_TO_APPWRITE_MAP);
  return typeof resolved === 'string' && resolved.trim().length > 0 ? resolved.trim() : null;
}

async function loadLocalSharedSettings(userId: string): Promise<{ state: SharedUserToolSettings; updatedAt: number | null }> {
  const stored = await getTrackerKv<LocalSharedSettingsRecord>(getStorageKey(userId));
  const normalized = stored?.state
    ? normalizeSharedUserToolSettings(stored.state)
    : { ...defaultSharedUserToolSettings };

  return {
    state: normalized,
    updatedAt: Number.isFinite(Number(stored?.updatedAt)) ? Number(stored?.updatedAt) : null,
  };
}

async function saveLocalSharedSettings(userId: string, settings: SharedUserToolSettings): Promise<void> {
  const normalized = normalizeSharedUserToolSettings(settings);
  await setTrackerKv(getStorageKey(userId), {
    state: normalized,
    updatedAt: Date.now(),
  } satisfies LocalSharedSettingsRecord);
}

function hasMeaningfulSharedSettings(candidate: SharedUserToolSettings): boolean {
  return candidate.cloudSyncEnabled !== defaultSharedUserToolSettings.cloudSyncEnabled
    || candidate.chartPalettePreset !== defaultSharedUserToolSettings.chartPalettePreset
    || candidate.chartDataAlignment !== defaultSharedUserToolSettings.chartDataAlignment
    || candidate.languagePreference !== defaultSharedUserToolSettings.languagePreference
    || candidate.dateFormatPreference !== defaultSharedUserToolSettings.dateFormatPreference
    || candidate.decimalSeparatorPreference !== defaultSharedUserToolSettings.decimalSeparatorPreference;
}

export async function getUserSharedSettings(userId: string): Promise<SharedUserToolSettings> {
  try {
    const local = await loadLocalSharedSettings(userId);
    return local.state;
  } catch (error) {
    logger.warn('Failed to read tracker shared user settings, using defaults', error);
    return { ...defaultSharedUserToolSettings };
  }
}

export async function getEffectiveUserSharedSettings(discordUserId: string): Promise<SharedUserToolSettings> {
  const primary = await getUserSharedSettings(discordUserId);
  const canonicalUserId = resolveCanonicalSharedUserId(discordUserId);

  if (!canonicalUserId || canonicalUserId === discordUserId) {
    return primary;
  }

  if (hasMeaningfulSharedSettings(primary)) {
    return primary;
  }

  const canonical = await getUserSharedSettings(canonicalUserId);
  if (hasMeaningfulSharedSettings(canonical)) {
    return canonical;
  }

  const cloud = await loadUserSharedSettingsCloud(discordUserId);
  if (cloud?.state.cloudSyncEnabled) {
    return cloud.state;
  }

  return primary;
}

export async function saveUserSharedSettings(userId: string, settings: SharedUserToolSettings): Promise<void> {
  try {
    const normalized = normalizeSharedUserToolSettings(settings);
    sharedUserToolSettingsSchema.parse(normalized);
    const [existingLocal, existingCloud] = await Promise.all([
      loadLocalSharedSettings(userId),
      loadUserSharedSettingsCloud(userId),
    ]);

    await saveLocalSharedSettings(userId, normalized);

    const shouldSyncCloud = normalized.cloudSyncEnabled
      || existingLocal.state.cloudSyncEnabled
      || existingCloud?.state.cloudSyncEnabled === true;

    if (!shouldSyncCloud) {
      return;
    }

    await saveUserSharedSettingsCloud(userId, normalized);
  } catch (error) {
    logger.warn('Failed saving tracker shared user settings', error);
  }
}

export async function reconcileUserSharedSettings(userId: string): Promise<SharedSettingsReconcileResult> {
  let local = await loadLocalSharedSettings(userId);
  const cloud = await loadUserSharedSettingsCloud(userId);

  if (local.updatedAt === null && cloud?.state.cloudSyncEnabled) {
    await saveLocalSharedSettings(userId, cloud.state);
    local = {
      state: cloud.state,
      updatedAt: cloud.updatedAt ?? Date.now(),
    };
  }

  return buildSyncedStateReconcileResult({
    local,
    cloud: {
      state: cloud?.state ?? null,
      updatedAt: cloud?.updatedAt ?? null,
    },
    autoCloudEnabled: local.state.cloudSyncEnabled,
    normalize: input => normalizeSharedUserToolSettings(input ?? defaultSharedUserToolSettings),
    saveLocal: async state => saveLocalSharedSettings(userId, state),
    queueCloudSync: async state => {
      await saveUserSharedSettingsCloud(userId, state);
    },
  });
}
