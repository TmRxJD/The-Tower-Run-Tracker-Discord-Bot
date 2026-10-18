import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ identity: vi.fn(), profiles: vi.fn(), target: vi.fn(), workflow: vi.fn(), touch: vi.fn(), settings: vi.fn() }));
vi.mock('../features/track/local-run-store', () => ({ getLocalSettings: calls.settings }));
vi.mock('../config/bot-config', () => ({ getBotConfig: () => ({ common: { responses: {} }, commands: { track: { options: { paste: { name: 'paste' } } } } }) }));
vi.mock('../features/track/run-cloud-identity', () => ({ resolveBotRunCloudIdentity: calls.identity }));
vi.mock('../features/track/upload-target-profile', () => ({ resolveBotUploadProfileId: calls.target, setPendingUploadProfile: vi.fn(), listBotUserProfiles: calls.profiles }));
vi.mock('../services/bots-tracker-db', () => ({ syncBotsTrackerState: async () => {} }));
vi.mock('../features/track/track-workflow', () => ({ handleTrackWorkflow: calls.workflow }));
vi.mock('../features/track/interaction-ack', () => ({ ensureDeferredEphemeralReply: async () => true }));
import { executeTrackerCommand } from './tracker-command-shared';
beforeEach(() => { vi.clearAllMocks(); calls.settings.mockResolvedValue({ cloudSyncEnabled: true }); });
it('reaches local workflow while identity, profiles and user backup are unavailable', async () => {
  calls.identity.mockRejectedValue(new Error('outage')); calls.profiles.mockRejectedValue(new Error('outage'));
  calls.touch.mockImplementation(() => new Promise(() => {})); calls.target.mockResolvedValue({ profileId: null });
  const owner = { client: { persistence: { users: { touch: calls.touch } } }, user: { id: 'fixture', username: 'fixture' }, options: { getString: () => 'Battle Report' }, editReply: vi.fn() };
  await executeTrackerCommand('track', owner as never);
  expect(calls.workflow).toHaveBeenCalledWith(owner, expect.objectContaining({ paste: 'Battle Report' }));
  expect(calls.target).toHaveBeenCalledWith('fixture', null, { localOnly: true });
  expect(owner.editReply).not.toHaveBeenCalled();
});

it('honors explicit cloud-disabled preference without identity/profile refresh calls', async () => {
  calls.settings.mockResolvedValue({ cloudSyncEnabled: false });
  calls.target.mockResolvedValue({ profileId: null }); calls.touch.mockResolvedValue(undefined);
  const owner = { client: { persistence: { users: { touch: calls.touch } } }, user: { id: 'fixture', username: 'fixture' }, options: { getString: () => 'Battle Report' }, editReply: vi.fn() };
  await executeTrackerCommand('track', owner as never);
  expect(calls.identity).not.toHaveBeenCalled(); expect(calls.profiles).not.toHaveBeenCalled();
  expect(calls.workflow).toHaveBeenCalledOnce();
});
