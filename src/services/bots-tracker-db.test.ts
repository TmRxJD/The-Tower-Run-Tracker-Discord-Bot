import { beforeEach, describe, expect, it, vi } from 'vitest';

const kvStore = new Map<string, unknown>();

vi.mock('@tmrxjd/platform/tools', () => {
  const normalize = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return {};
    }
    return { ...(input as Record<string, unknown>) };
  };

  return {
    buildBotsTrackerLocalPersistPayload: normalize,
    normalizeBotsTrackerLocalSnapshot: normalize,
    buildSyncedStateReconcileResult: (input: {
      local: { state: Record<string, unknown> | null; updatedAt: number | null };
      cloud: { state: Record<string, unknown> | null; updatedAt: number | null };
      normalize: (state: Record<string, unknown> | null) => Record<string, unknown>;
    }) => ({
      autoCloudEnabled: false,
      hasDifference: false,
      direction: 'unknown' as const,
      localUpdatedAt: input.local.updatedAt,
      cloudUpdatedAt: input.cloud.updatedAt,
      localState: input.normalize(input.local.state),
      cloudState: input.cloud.state ? input.normalize(input.cloud.state) : null,
      applyCloudToLocal: async () => null,
      applyLocalToCloud: async () => undefined,
    }),
    applyAutoCloudReconcile: async () => undefined,
  };
});

vi.mock('./idb', () => ({
  getTrackerKv: vi.fn(async (key: string) => kvStore.get(key) ?? null),
  setTrackerKv: vi.fn(async (key: string, value: unknown) => {
    kvStore.set(key, value);
  }),
}));

vi.mock('./bots-tracker-cloud', () => ({
  loadBotsTrackerCloud: vi.fn(async () => null),
  saveBotsTrackerCloud: vi.fn(async () => true),
}));

vi.mock('./user-shared-settings-db', () => ({
  getEffectiveUserSharedSettings: vi.fn(async () => ({
    cloudSyncEnabled: false,
    chartPalettePreset: 'default',
    chartDataAlignment: 'left',
    languagePreference: 'English',
    dateFormatPreference: 'MM/DD/YYYY',
    decimalSeparatorPreference: 'Period (.)',
    runDeltaMode: 'off',
  })),
}));

import { saveBotsTrackerCloud } from './bots-tracker-cloud';
import {
  getBotsTrackerLocalState,
  reconcileBotsTrackerState,
  saveBotsTrackerLocalState,
} from './bots-tracker-db';

describe('bots-tracker-db', () => {
  beforeEach(() => {
    kvStore.clear();
    vi.clearAllMocks();
  });

  it('persists bots tracker state locally across reads', async () => {
    const userId = 'discord-user-1';
    await saveBotsTrackerLocalState(userId, {
      levels: { 'Golden Bot': [12, 3, 0] },
      towerRange: 18,
    });

    const loaded = await getBotsTrackerLocalState(userId);
    expect(loaded.levels).toEqual({ 'Golden Bot': [12, 3, 0] });
    expect(loaded.towerRange).toBe(18);

    const reloaded = await getBotsTrackerLocalState(userId);
    expect(reloaded.levels).toEqual({ 'Golden Bot': [12, 3, 0] });
  });

  it('does not require cloud when cloud sync is disabled', async () => {
    const userId = 'discord-user-2';
    await saveBotsTrackerLocalState(userId, {
      levels: { 'Amplify Bot': [5] },
    });

    expect(saveBotsTrackerCloud).not.toHaveBeenCalled();

    const result = await reconcileBotsTrackerState(userId);
    expect(result.localState.levels).toEqual({ 'Amplify Bot': [5] });
    expect(result.cloudState).toBeNull();
  });
});
