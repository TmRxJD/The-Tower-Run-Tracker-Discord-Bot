import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), render: vi.fn(), log: vi.fn() }));
vi.mock('../share/shared-run-lookup', () => ({ resolveSharedRunContext: mocks.lookup, buildExpandedSharePayload: vi.fn() }));
vi.mock('./upload-handlers', () => ({ renderTrackMenu: mocks.render }));
vi.mock('./error-handlers', () => ({ logError: mocks.log }));
import { handleShareEmbedExpand, handleShareEmbedBattleReport, handleShareEmbedTrackRun } from './share-embed-action-handlers';
import { TRACKER_IDS } from '../track-custom-ids';

it.each([
  [handleShareEmbedExpand, TRACKER_IDS.share.expandPrefix, 'share_embed_expand', 'lookup'],
  [handleShareEmbedBattleReport, TRACKER_IDS.share.reportPrefix, 'share_embed_battle_report', 'lookup'],
  [handleShareEmbedTrackRun, '', 'share_embed_track_run', 'render'],
] as const)('retains button failure operation and stage without echoing private exceptions', async (handler, prefix, operation, stage) => {
  vi.clearAllMocks();
  const error = Object.assign(new Error('PRIVATE_PASTE_SECRET'), { code: 50013 });
  mocks.lookup.mockRejectedValue(error); mocks.render.mockRejectedValue(error);
  const interaction = { isMessageComponent: () => true, customId: prefix + '123456789012345678:run-1', client: {}, user: {}, deferred: true, deferReply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined) };
  await handler(interaction as never);
  expect(mocks.log).toHaveBeenCalledWith(interaction.client, interaction.user, error, operation, null, null, stage);
  expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain('PRIVATE_PASTE_SECRET');
});
