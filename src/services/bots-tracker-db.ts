import {
  buildBotsTrackerLocalPersistPayload,
  buildSyncedStateReconcileResult,
  applyAutoCloudReconcile,
  normalizeBotsTrackerLocalSnapshot,
  type SyncedStateReconcileResult,
} from '@tmrxjd/platform/tools';
import { logger } from '../core/logger';
import { getEffectiveUserSharedSettings } from './user-shared-settings-db';
import { getTrackerKv, setTrackerKv } from './idb';
import { loadBotsTrackerCloud, saveBotsTrackerCloud } from './bots-tracker-cloud';

const BOTS_TRACKER_PREFIX = 'tracker-bots-tracker:';

type LocalBotsTrackerRecord = {
  state: Record<string, unknown>;
  updatedAt: number;
};

export type BotsTrackerReconcileResult = SyncedStateReconcileResult<Record<string, unknown>>;

function getStorageKey(userId: string): string {
  return `${BOTS_TRACKER_PREFIX}${userId}`;
}

function defaultBotsTrackerState(): Record<string, unknown> {
  return buildBotsTrackerLocalPersistPayload({});
}

async function loadLocalBotsTracker(userId: string): Promise<{ state: Record<string, unknown>; updatedAt: number | null }> {
  const stored = await getTrackerKv<LocalBotsTrackerRecord>(getStorageKey(userId));
  const normalized = stored?.state
    ? normalizeBotsTrackerLocalSnapshot(stored.state)
    : defaultBotsTrackerState();

  return {
    state: normalized,
    updatedAt: stored && Number.isFinite(Number(stored.updatedAt)) ? Number(stored.updatedAt) : null,
  };
}

async function saveLocalBotsTracker(userId: string, state: Record<string, unknown>): Promise<void> {
  const normalized = buildBotsTrackerLocalPersistPayload(state);
  await setTrackerKv(getStorageKey(userId), {
    state: normalized,
    updatedAt: Date.now(),
  } satisfies LocalBotsTrackerRecord);
}

function hasMeaningfulBotsTrackerState(candidate: Record<string, unknown>): boolean {
  const levels = candidate.levels;
  if (levels && typeof levels === 'object' && !Array.isArray(levels)) {
    for (const values of Object.values(levels as Record<string, unknown>)) {
      if (!Array.isArray(values)) continue;
      if (values.some(value => Number(value) > 0)) {
        return true;
      }
    }
  }

  const towerRange = Number(candidate.towerRange ?? 0);
  if (Number.isFinite(towerRange) && towerRange > 0) {
    return true;
  }

  const labLevels = candidate.labLevels;
  if (labLevels && typeof labLevels === 'object' && !Array.isArray(labLevels)) {
    for (const botLabs of Object.values(labLevels as Record<string, unknown>)) {
      if (!botLabs || typeof botLabs !== 'object' || Array.isArray(botLabs)) continue;
      if (Object.values(botLabs as Record<string, unknown>).some(value => Number(value) > 0)) {
        return true;
      }
    }
  }

  return false;
}

export async function getBotsTrackerLocalState(userId: string): Promise<Record<string, unknown>> {
  try {
    const local = await loadLocalBotsTracker(userId);
    return local.state;
  } catch (error) {
    logger.warn('Failed to read bots tracker local state, using defaults', error);
    return defaultBotsTrackerState();
  }
}

export async function saveBotsTrackerLocalState(userId: string, state: Record<string, unknown>): Promise<void> {
  try {
    const normalized = buildBotsTrackerLocalPersistPayload(state);
    const [existingLocal, existingCloud, sharedSettings] = await Promise.all([
      loadLocalBotsTracker(userId),
      loadBotsTrackerCloud(userId),
      getEffectiveUserSharedSettings(userId),
    ]);

    await saveLocalBotsTracker(userId, normalized);

    const shouldSyncCloud = sharedSettings.cloudSyncEnabled
      || hasMeaningfulBotsTrackerState(existingLocal.state)
      || hasMeaningfulBotsTrackerState(existingCloud?.state ?? {});

    if (!shouldSyncCloud) {
      return;
    }

    await saveBotsTrackerCloud(userId, normalized);
  } catch (error) {
    logger.warn('Failed saving bots tracker local state', error);
  }
}

export async function reconcileBotsTrackerState(userId: string): Promise<BotsTrackerReconcileResult> {
  let local = await loadLocalBotsTracker(userId);
  const cloud = await loadBotsTrackerCloud(userId);
  const sharedSettings = await getEffectiveUserSharedSettings(userId);

  if (local.updatedAt === null && cloud && hasMeaningfulBotsTrackerState(cloud.state)) {
    await saveLocalBotsTracker(userId, cloud.state);
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
    autoCloudEnabled: sharedSettings.cloudSyncEnabled,
    normalize: input => normalizeBotsTrackerLocalSnapshot(input ?? defaultBotsTrackerState()),
    saveLocal: async state => saveLocalBotsTracker(userId, state),
    queueCloudSync: async state => {
      await saveBotsTrackerCloud(userId, state);
    },
  });
}

export async function syncBotsTrackerState(userId: string): Promise<void> {
  try {
    const sharedSettings = await getEffectiveUserSharedSettings(userId);
    if (!sharedSettings.cloudSyncEnabled) {
      return;
    }

    const result = await reconcileBotsTrackerState(userId);
    await applyAutoCloudReconcile(result);
  } catch (error) {
    logger.warn('Bots tracker cloud sync skipped', error);
  }
}
