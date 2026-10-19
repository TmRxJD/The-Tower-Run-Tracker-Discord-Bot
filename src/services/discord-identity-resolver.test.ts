import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ identities: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('node-appwrite', async importOriginal => ({ ...await importOriginal<object>(), Users: class { listIdentities = mocks.identities; } }));
vi.mock('../persistence/appwrite-client', () => ({ createAppwriteClient: () => ({ client: {} }) }));
vi.mock('./idb', () => ({ getTrackerKv: mocks.read, setTrackerKv: mocks.write }));
import { resolveAppwriteIdForDiscordUser, getStoredAppwriteIdForDiscordUser, refreshAppwriteIdForDiscordUser } from './discord-identity-resolver';
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

describe('concurrent provider identity reads', () => {
  it('shares one cold read across strict, optional and required-linked callers', async () => {
    const id = '960555681646276610';
    let finish!: (value: unknown) => void;
    mocks.identities.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = Promise.all([
      resolveAppwriteIdForDiscordUser(id, { failOnLookupError: true }),
      resolveAppwriteIdForDiscordUser(id),
      resolveAppwriteIdForDiscordUser(id, { requireLinked: true }),
    ]);
    await vi.waitFor(() => expect(mocks.identities).toHaveBeenCalledOnce());
    finish({ identities: [{ provider: 'discord', providerUid: id, userId: 'linked-account' }] });
    expect(await pending).toEqual(['linked-account', 'linked-account', 'linked-account']);
  });
  it('preserves each caller error policy and evicts a rejected shared lookup', async () => {
    const id = '960555681646276611';
    let fail!: (error: Error) => void;
    mocks.identities.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = Promise.allSettled([
      resolveAppwriteIdForDiscordUser(id),
      resolveAppwriteIdForDiscordUser(id, { failOnLookupError: true }),
      resolveAppwriteIdForDiscordUser(id, { requireLinked: true }),
    ]);
    await vi.waitFor(() => expect(mocks.identities).toHaveBeenCalledOnce());
    fail(new Error('fixture cloud unavailable'));
    const results = await pending;
    expect(results[0]).toEqual({ status: 'fulfilled', value: null });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'Run history identity lookup failed. Please retry.' } });
    expect(results[2]).toMatchObject({ status: 'rejected', reason: { code: 'IDENTITY_NOT_FOUND' } });
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.identities.mockResolvedValue({ identities: [{ provider: 'discord', providerUid: id, userId: 'recovered-account' }] });
    expect(await resolveAppwriteIdForDiscordUser(id, { failOnLookupError: true })).toBe('recovered-account');
    expect(mocks.identities).toHaveBeenCalledTimes(2);
  });
  it('shares a successful unlinked observation without weakening requireLinked', async () => {
    const id = '960555681646276612';
    mocks.identities.mockResolvedValue({ identities: [] });
    const results = await Promise.allSettled([
      resolveAppwriteIdForDiscordUser(id, { requireLinked: true }),
      resolveAppwriteIdForDiscordUser(id, { failOnLookupError: true }),
      resolveAppwriteIdForDiscordUser(id),
    ]);
    expect(mocks.identities).toHaveBeenCalledOnce();
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'IDENTITY_NOT_FOUND' } });
    expect(results.slice(1)).toEqual([{ status: 'fulfilled', value: null }, { status: 'fulfilled', value: null }]);
  });
  it('never coalesces different Discord owners', async () => {
    mocks.identities.mockImplementation(async (queries: string[]) => {
      const id = queries.map(q => JSON.parse(q)).find(q => q.attribute === 'providerUid').values[0];
      return { identities: [{ provider: 'discord', providerUid: id, userId: id.endsWith('3') ? 'account-a' : 'account-b' }] };
    });
    expect(await Promise.all([
      resolveAppwriteIdForDiscordUser('960555681646276613'),
      resolveAppwriteIdForDiscordUser('960555681646276614'),
    ])).toEqual(['account-a', 'account-b']);
    expect(mocks.identities).toHaveBeenCalledTimes(2);
  });
  it('an explicit refresh starts a new provider read instead of joining an older one', async () => {
    const id = '960555681646276615';
    let finish!: (value: unknown) => void;
    mocks.identities.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ identities: [{ provider: 'discord', providerUid: id, userId: 'fresh-account' }] });
    const old = resolveAppwriteIdForDiscordUser(id);
    await vi.waitFor(() => expect(mocks.identities).toHaveBeenCalledOnce());
    expect(await refreshAppwriteIdForDiscordUser(id)).toBe('fresh-account');
    expect(mocks.identities).toHaveBeenCalledTimes(2);
    finish({ identities: [{ provider: 'discord', providerUid: id, userId: 'old-account' }] });
    await old;
  });
});
