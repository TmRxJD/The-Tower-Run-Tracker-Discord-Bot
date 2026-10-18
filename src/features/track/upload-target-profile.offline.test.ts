import { beforeEach, expect, it, vi } from 'vitest';
const store = vi.hoisted(() => new Map<string, unknown>());
const cloud = vi.hoisted(() => vi.fn());
vi.mock('../../services/idb', () => ({ getTrackerKv: async (key: string) => store.get(key), setTrackerKv: async (key: string, value: unknown) => { store.set(key, value); } }));
vi.mock('./run-cloud-identity', () => ({ resolveBotRunCloudIdentity: cloud }));
import { listBotUserProfiles, resolveBotUploadProfileId } from './upload-target-profile';
beforeEach(() => { store.clear(); cloud.mockReset(); cloud.mockRejectedValue(new Error('fixture outage')); });
it('uses stored Main/Alt order and default without a live identity lookup', async () => {
  store.set('tracker-profiles:v1:fixture', [
    { id: 'main', name: 'Main', isPrimary: true, isDefault: false, createdAt: '2026-01-01' },
    { id: 'alt-original', name: 'Alt', isPrimary: false, isDefault: true, createdAt: '2026-01-02' },
  ]);
  expect(await listBotUserProfiles('fixture', { localOnly: true })).toHaveLength(2);
  expect(await resolveBotUploadProfileId('fixture', null, { localOnly: true })).toEqual({ profileId: 'alt-original' });
  expect(await resolveBotUploadProfileId('fixture', 1, { localOnly: true })).toEqual({ profileId: 'alt-original' });
  expect(cloud).not.toHaveBeenCalled();
});
it('never silently maps an explicit unavailable Alt to Main', async () => {
  expect(await resolveBotUploadProfileId('fixture', 1, { localOnly: true })).toHaveProperty('error');
  expect(cloud).not.toHaveBeenCalled();
});
