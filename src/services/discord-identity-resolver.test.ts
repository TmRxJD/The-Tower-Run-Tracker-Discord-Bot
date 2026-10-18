import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ identities: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('node-appwrite', async importOriginal => ({ ...await importOriginal<object>(), Users: class { listIdentities = mocks.identities; } }));
vi.mock('../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ client: {} }) }));
vi.mock('./idb', () => ({ getTrackerKv: mocks.read, setTrackerKv: mocks.write }));
import { resolveAppwriteIdForDiscordUser, getStoredAppwriteIdForDiscordUser } from './discord-identity-resolver';
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue(null); mocks.write.mockResolvedValue(undefined); });
describe('strict run identity lookup', () => {
  it('throws on a failed provider lookup without caching a false unlinked result', async () => {
    mocks.identities.mockRejectedValue(new Error('fixture cloud unavailable'));
    await expect(resolveAppwriteIdForDiscordUser('960555681646276600', { failOnLookupError: true })).rejects.toThrow('identity lookup failed');
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.identities.mockResolvedValue({ total: 0, identities: [] });
    expect(await resolveAppwriteIdForDiscordUser('960555681646276600', { failOnLookupError: true })).toBeNull();
    expect(mocks.identities).toHaveBeenCalledTimes(2);
  });
  it('a successful empty lookup remains a valid legacy identity', async () => {
    mocks.identities.mockResolvedValue({ total: 0, identities: [] });
    expect(await resolveAppwriteIdForDiscordUser('960555681646276601', { failOnLookupError: true })).toBeNull();
    expect(mocks.write).toHaveBeenCalledOnce();
  });
});

it('uses an expired known mapping only as a local display hint during an outage', async () => {
  mocks.read.mockResolvedValue({ appwriteId: 'known-account', cachedAt: 1 });
  mocks.identities.mockRejectedValue(new Error('fixture cloud unavailable'));
  await expect(getStoredAppwriteIdForDiscordUser('960555681646276605')).resolves.toBe('known-account');
  expect(mocks.identities).not.toHaveBeenCalled();
  await expect(resolveAppwriteIdForDiscordUser('960555681646276605', { failOnLookupError: true })).rejects.toThrow('identity lookup failed');
});
