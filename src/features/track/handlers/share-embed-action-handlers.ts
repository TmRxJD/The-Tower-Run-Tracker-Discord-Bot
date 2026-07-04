import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { logError } from './error-handlers';
import { renderTrackMenu } from './upload-handlers';
import { TRACKER_IDS } from '../track-custom-ids';
import { readShareBuildLink } from '../share/share-build-code-cache';
import type { TrackReplyInteractionLike } from '../interaction-types';

export async function handleShareEmbedTrackRun(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!interaction.isMessageComponent()) {
    return;
  }
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
    await renderTrackMenu(interaction as unknown as TrackReplyInteractionLike);
  } catch (error) {
    await logError(interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, interaction.user, error, 'share_embed_track_run');
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Unable to open the run tracker menu right now.', ephemeral: true }).catch(() => {});
    } else if (interaction.deferred) {
      await interaction.editReply({ content: 'Unable to open the run tracker menu right now.', embeds: [], components: [], files: [] }).catch(() => {});
    }
  }
}

export async function handleShareEmbedViewBuild(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!interaction.isMessageComponent()) {
    return;
  }
  const token = interaction.customId.startsWith(TRACKER_IDS.share.viewBuildPrefix)
    ? interaction.customId.slice(TRACKER_IDS.share.viewBuildPrefix.length)
    : '';
  const cached = token ? readShareBuildLink(token) : null;

  if (!cached?.url) {
    await interaction.reply({ content: 'This build link expired. Ask the sharer to post a new run share.', ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.reply({
    content: `Open this build on the Tower Run Tracker:\n${cached.url}`,
    ephemeral: true,
  }).catch(() => {});
}
