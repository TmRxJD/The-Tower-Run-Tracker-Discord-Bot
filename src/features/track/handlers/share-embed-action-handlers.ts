import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { logError } from './error-handlers';
import { renderTrackMenu } from './upload-handlers';
import { TRACKER_IDS, parsePrefixedTrackerToken } from '../track-custom-ids';
import { readShareBuildLink } from '../share/share-build-code-cache';
import { parseShareRunRef } from '../share/share-run-ref';
import { buildExpandedSharePayload, resolveSharedRunContext, type SharedRunContext } from '../share/shared-run-lookup';
import { buildBattleReportMarkdown } from '../share/battle-report-markdown';
import type { TrackReplyInteractionLike } from '../interaction-types';

const SHARE_RUN_UNAVAILABLE = 'That run is no longer available. Ask the sharer to post a new run share.';

/**
 * Resolves the run behind an Expand / Battle Report button. Replies with a notice and
 * returns `null` when the run can no longer be found, so callers can just bail out.
 */
async function resolveSharedRunForButton(
  interaction: MessageComponentInteraction,
  prefix: string,
): Promise<SharedRunContext & { userId: string } | null> {
  const token = parsePrefixedTrackerToken(prefix, interaction.customId);
  const parsed = token ? parseShareRunRef(token) : null;

  if (!parsed) {
    await interaction.editReply({ content: SHARE_RUN_UNAVAILABLE }).catch(() => {});
    return null;
  }

  const context = await resolveSharedRunContext(interaction.client, parsed.userId, parsed.runRef);
  if (!context) {
    await interaction.editReply({ content: SHARE_RUN_UNAVAILABLE }).catch(() => {});
    return null;
  }

  return { ...context, userId: parsed.userId };
}

export async function handleShareEmbedExpand(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!interaction.isMessageComponent()) {
    return;
  }
  try {
    await interaction.deferReply({ ephemeral: true });

    const context = await resolveSharedRunForButton(interaction, TRACKER_IDS.share.expandPrefix);
    if (!context) return;

    const { embed, files } = await buildExpandedSharePayload(interaction.client, context.userId, context);
    await interaction.editReply({ embeds: [embed], files });
  } catch (error) {
    await logError(interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, interaction.user, error, 'share_embed_expand');
    await interaction.editReply({ content: 'Unable to expand this run share right now.', embeds: [] }).catch(() => {});
  }
}

export async function handleShareEmbedBattleReport(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  if (!interaction.isMessageComponent()) {
    return;
  }
  try {
    await interaction.deferReply({ ephemeral: true });

    const context = await resolveSharedRunForButton(interaction, TRACKER_IDS.share.reportPrefix);
    if (!context) return;

    const markdown = buildBattleReportMarkdown(context.run, { sharerName: context.sharerName });
    if (!markdown) {
      await interaction.editReply({ content: 'No battle report stats were captured for this run.' });
      return;
    }

    await interaction.editReply({
      files: [{ attachment: Buffer.from(markdown, 'utf-8'), name: 'battle-report.md' }],
    });
  } catch (error) {
    await logError(interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, interaction.user, error, 'share_embed_battle_report');
    await interaction.editReply({ content: 'Unable to build the battle report right now.', files: [] }).catch(() => {});
  }
}

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
