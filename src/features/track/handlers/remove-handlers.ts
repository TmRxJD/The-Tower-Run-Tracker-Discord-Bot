import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';
import { getLastRun, getLocalLifetimeData, removeLastRun, removeLifetimeEntry } from '../tracker-api-client';
import { packTrackerRemoveToken, parsePrefixedTrackerToken, parseTrackerRemoveToken, TRACKER_IDS, withToken } from '../track-custom-ids';
import { logError } from './error-handlers';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';
import { createInitialEmbed, createMainMenuButtons } from '../ui/tracker-ui';

type TrackMenuInteraction = MessageComponentInteraction | ModalSubmitInteraction;

async function renderMainMenuFromLatest(interaction: TrackMenuInteraction, mode: 'track' | 'lifetime') {
  if (mode === 'lifetime') {
    const entries = await getLocalLifetimeData(interaction.user.id).catch(() => []);
    const sorted = [...entries].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
    const latest = sorted[0] ?? null;
    const embed = createInitialEmbed({
      mode,
      userId: interaction.user.id,
      lastRun: latest,
      runCount: sorted.length,
      runTypeCounts: {},
    });
    const rows = createMainMenuButtons(mode);
    await interaction.editReply({ content: '', embeds: [embed], components: rows, files: [], attachments: [] }).catch(() => {});
    return;
  }

  const summary = await getLastRun(interaction.user.id, { cloudSyncMode: 'none' }).catch(() => null);
  const embed = createInitialEmbed({
    mode,
    userId: interaction.user.id,
    lastRun: summary?.lastRun ?? null,
    runCount: summary?.allRuns?.length ?? 0,
    runTypeCounts: summary?.runTypeCounts ?? {},
  });
  const rows = createMainMenuButtons(mode);
  await interaction.editReply({ content: '', embeds: [embed], components: rows, files: [], attachments: [] }).catch(() => {});
}

export async function handleTrackMenuRemoveLastPrompt(interaction: TrackMenuInteraction) {
  try {
    const mode = getTrackerFlowMode(interaction.user.id);
    const removeUi = getTrackerUiConfig(mode).remove;
    await interaction.deferUpdate().catch(() => {});

    if (mode === 'lifetime') {
      const entries = await getLocalLifetimeData(interaction.user.id);
      const sorted = [...entries].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
      const latest = sorted[0];
      const latestId = latest ? (typeof latest.$id === 'string' ? latest.$id : (typeof latest.id === 'string' ? latest.id : null)) : null;
      if (!latest || !latestId) {
        await interaction.editReply({ content: removeUi.noneFound, embeds: [], components: [] }).catch(() => {});
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(removeUi.confirmTitle)
        .setDescription(`Are you sure you want to remove your last lifetime entry?\nDate ${String(latest.date ?? 'Unknown')}`)
        .setColor(Colors.Orange);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.remove.confirmPrefix, latestId)).setLabel(removeUi.confirmButton).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(TRACKER_IDS.remove.cancel).setLabel(removeUi.cancelButton).setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({ embeds: [embed], components: [row], content: '' }).catch(() => {});
      return;
    }

    const summary = await getLastRun(interaction.user.id);
    const lastRun = summary?.lastRun as Record<string, unknown> | undefined;
    const runId = typeof lastRun?.runId === 'string' && lastRun.runId.trim() ? lastRun.runId.trim() : null;
    const localId = typeof lastRun?.localId === 'string' && lastRun.localId.trim() ? lastRun.localId.trim() : null;
    if (!lastRun || (!runId && !localId)) {
      await interaction.editReply({ content: removeUi.noneFound, embeds: [], components: [] }).catch(() => {});
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(removeUi.confirmTitle)
      .setDescription(
        removeUi.confirmDescription
          .replace('{tier}', String(lastRun.tier ?? lastRun.tierDisplay ?? '?'))
          .replace('{wave}', String(lastRun.wave ?? '?'))
      )
      .setColor(Colors.Orange);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.remove.confirmPrefix, packTrackerRemoveToken(runId, localId))).setLabel(removeUi.confirmButton).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(TRACKER_IDS.remove.cancel).setLabel(removeUi.cancelButton).setStyle(ButtonStyle.Secondary),
    );

    await interaction.editReply({ embeds: [embed], components: [row], content: '' }).catch(() => {});
  } catch (error) {
    await logError(interaction.client, interaction.user, error, 'track_menu_remove_last_prompt');
  }
}

export async function handleTrackMenuConfirmRemove(interaction: TrackMenuInteraction) {
  try {
    const mode = getTrackerFlowMode(interaction.user.id);
    const removeUi = getTrackerUiConfig(mode).remove;
    const token = parsePrefixedTrackerToken(TRACKER_IDS.remove.confirmPrefix, interaction.customId);
    const { runId, localId } = parseTrackerRemoveToken(token);
    if (!runId && !localId) {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate().catch(() => {});
      }
      await interaction.editReply({ content: removeUi.missingRunId, embeds: [], components: [] }).catch(() => {});
      return;
    }
    await interaction.deferUpdate().catch(() => {});
    if (mode === 'lifetime') {
      const result = await removeLifetimeEntry({ userId: interaction.user.id, username: interaction.user.username, entryId: runId ?? localId ?? '' });
      if (result.cloudUnavailable) {
        await interaction.editReply({
          content: 'Cloud sync is currently unavailable. Your lifetime removal is saved locally and will sync automatically later.',
          embeds: [],
          components: [],
        }).catch(() => {});
      }
    } else {
      await removeLastRun({ userId: interaction.user.id, runId, localId });
    }
    await renderMainMenuFromLatest(interaction, mode);
  } catch (error) {
    const ui = getTrackerUiConfig(getTrackerFlowMode(interaction.user.id));
    await logError(interaction.client, interaction.user, error, 'track_menu_confirm_remove');
    await interaction.editReply({ content: ui.remove.failed, embeds: [], components: [] }).catch(() => {});
  }
}
