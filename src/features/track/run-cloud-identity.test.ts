import { resolveAppwriteIdForDiscordUser } from '../../services/discord-identity-resolver';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildTrackerRunIdentityContext } from '@tmrxjd/platform/tools';
import { resolveBotRunCloudIdentity, invalidateBotRunCloudIdentityCache } from './run-cloud-identity';

vi.mock('../../services/discord-identity-resolver', () => ({
  resolveAppwriteIdForDiscordUser: vi.fn(async () => '681ab667ce6096096b3b'),
}));

describe('resolveBotRunCloudIdentity', () => {
  beforeEach(() => {
    invalidateBotRunCloudIdentityCache();
  });

  it('uses OAuth-linked Appwrite id for cloud writes and includes Discord in lookup ids', async () => {
    const identity = await resolveBotRunCloudIdentity('371914184822095873');
    expect(identity.cloudWriteUserId).toBe('681ab667ce6096096b3b');
    expect(identity.lookupUserIds).toContain('681ab667ce6096096b3b');
    expect(identity.lookupUserIds).toContain('371914184822095873');
    expect(identity.ownerUserId).toBe('681ab667ce6096096b3b');
  });

  it('matches platform identity context without env user maps', async () => {
    const expected = buildTrackerRunIdentityContext({
      appwriteUserId: '681ab667ce6096096b3b',
      permissionAppwriteUserId: '681ab667ce6096096b3b',
      discordUserId: '371914184822095873',
      extraUserIds: ['681ab667ce6096096b3b', '371914184822095873'],
    });

    const identity = await resolveBotRunCloudIdentity('371914184822095873');
    expect(identity.lookupUserIds).toEqual(expected.lookupUserIds);
    expect(identity.permissionUserIds).toEqual(expected.permissionUserIds);
    expect(identity.ownerUserId).toBe(expected.ownerUserId);
  });
});

describe('cloud identity failures', () => {
  it('propagates failures and permits a successful retry without a cached false-unlinked result', async () => {
    invalidateBotRunCloudIdentityCache();
    vi.mocked(resolveAppwriteIdForDiscordUser).mockRejectedValueOnce(new Error('fixture lookup failed'));
    await expect(resolveBotRunCloudIdentity('960555681646276668')).rejects.toThrow('lookup failed');
    const retried = await resolveBotRunCloudIdentity('960555681646276668');
    expect(retried.lookupUserIds).toContain('681ab667ce6096096b3b');
    expect(retried.lookupUserIds).toContain('960555681646276668');
    expect(resolveAppwriteIdForDiscordUser).toHaveBeenLastCalledWith('960555681646276668', { failOnLookupError: true });
  });
  it('a successful no-OAuth lookup still supports legacy Discord-owned history', async () => {
    invalidateBotRunCloudIdentityCache();
    vi.mocked(resolveAppwriteIdForDiscordUser).mockResolvedValueOnce(null);
    const identity = await resolveBotRunCloudIdentity('960555681646276668');
    expect(identity.lookupUserIds).toContain('960555681646276668');
  });
});
