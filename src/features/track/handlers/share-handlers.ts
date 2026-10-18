import { logger } from '../../../core/logger';
import type { DiagnosticStage } from './safe-error-diagnostic';
import { logError } from './error-handlers';
import { prepareBotRunUploadHistory, withBotRunSubmissionLock } from '../run-upload-history';
import { getLocalLifetimeData, getUserSettings, getLocalRunSummary } from '../tracker-api-client';
import { buildShareEmbed } from '../share/share-embed';
import { resolveShareEmbedChannelPayload, type ShareEmbedChannelPayload } from '../share/share-embed-delivery';
import { buildEmbedUserFromInteraction, resolveInteractionDisplayName } from '../discord-display-name';
import { getShareableRun, setShareableRun } from '../share/share-state';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';
import { TRACKER_IDS } from '../track-custom-ids';
import { EmbedBuilder, Colors, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';
import { buildPerHourChartAttachment } from '../ui/per-hour-chart-helpers';
import { buildShareSnapshotRef } from '../share/share-run-ref';
import { shouldCompactShare } from '../share/share-compaction';
import { saveShareSnapshot } from '../share/share-snapshot-store';
import { getEffectiveUserSharedSettings } from '../../../services/user-shared-settings-db';
import { computeTrackerRunDeltaBaseline, estimateTrackerRunTimestamp, trackerRunReferencesSameEntry } from '@tmrxjd/platform/tools';

export function recordShareableRun(userId: string, run: Record<string, unknown>, runTypeCounts: Record<string, number>, screenshotUrl?: string | null) {
  const hydratedRun = { ...run };
  if (screenshotUrl && !hydratedRun.screenshotUrl) hydratedRun.screenshotUrl = screenshotUrl;
  setShareableRun(userId, { run: hydratedRun, runTypeCounts, screenshotUrl: screenshotUrl ?? null });
}

async function disableShareButtonOnOriginalMessage(interaction: MessageComponentInteraction | ModalSubmitInteraction): Promise<void> {
  const shareIds = new Set<string>([TRACKER_IDS.flow.shareLast, TRACKER_IDS.flow.shareLastMenu]);

  const currentRows = ('message' in interaction && interaction.message?.components)
    ? interaction.message.components
    : [];

  if (!currentRows.length) return;
  let changed = false;

  const nextComponents = currentRows.map((row) => {
    const json = row.toJSON() as {
      type: number;
      components?: Array<Record<string, unknown>>;
    };

    if (!Array.isArray(json.components)) return json;

    const nextRowComponents = json.components.map((component) => {
      if (component?.type !== 2) return component;
      const customId = typeof component.custom_id === 'string' ? component.custom_id : '';
      if (!shareIds.has(customId)) return component;
      changed = true;
      return { ...component, disabled: true };
    });

    return { ...json, components: nextRowComponents };
  });

  if (!changed) return;

  const updatedByReply = await interaction.editReply({ components: nextComponents }).then(() => true).catch(() => false);
  if (updatedByReply) return;

  if ('message' in interaction && interaction.message && 'edit' in interaction.message) {
    await interaction.message.edit({ components: nextComponents }).catch(() => {});
  }
}

export async function handleTrackMenuShareLast(interaction: MessageComponentInteraction | ModalSubmitInteraction) {
  const mode = getTrackerFlowMode(interaction.user.id);
  const shareUiConfig = getTrackerUiConfig(mode).share;
  let stage: DiagnosticStage = 'acknowledge';
  const started = performance.now();
  let stageStarted = started;
  const stages: Partial<Record<DiagnosticStage, number>> = {};
  const setStage = (next: DiagnosticStage) => {
    stages[stage] = (stages[stage] ?? 0) + performance.now() - stageStarted;
    stage = next; stageStarted = performance.now();
  };
  let acknowledged = interaction.deferred || interaction.replied;
  try {
    if (!acknowledged) {
      try {
        await interaction.deferUpdate();
        acknowledged = true;
      } catch {
        // A failed fallback must stop before history reads, snapshots or public sends.
        // The user cannot receive confirmation on an unacknowledged interaction.
        await interaction.deferReply({ ephemeral: true });
        acknowledged = true;
      }
    }

    const sendNotice = async (content: string) => {
      if (!content) return;
      if (acknowledged && interaction.followUp) {
        await interaction.followUp({ content, ephemeral: true }).catch(() => {});
        return;
      }
      if (interaction.reply) {
        await interaction.reply({ content, ephemeral: true }).catch(() => {});
      }
    };

    const userId = interaction.user.id;
    setStage('settings');
    const settings = await getUserSettings(userId).catch(() => null);
    const includeNotes = settings?.shareNotes !== false;
    const includeCoverage = settings?.shareCoverage !== false;
    const includeScreenshot = settings?.shareScreenshot !== false;
    const includeTier = settings?.shareTier !== false;
    const includeWave = settings?.shareWave !== false;
    const includeDuration = settings?.shareDuration !== false;
    const includeKilledBy = settings?.shareKilledBy !== false;
    const includeTotalCoins = settings?.shareTotalCoins !== false;
    const includeTotalCells = settings?.shareTotalCells !== false;
    const includeTotalDice = settings?.shareTotalDice !== false;
    const includeDeathDefy = settings?.shareDeathDefy !== false;
    const includeCoinsPerHour = settings?.shareCoinsPerHour !== false;
    const includeCellsPerHour = settings?.shareCellsPerHour !== false;
    const includeDicePerHour = settings?.shareDicePerHour !== false;
    const includeTotalShards = settings?.shareTotalShards !== false;
    const includeCoverageGoldenTower = settings?.shareCoverageGoldenTower !== false;
    const includeCoverageBlackHole = settings?.shareCoverageBlackHole !== false;
    const includeCoverageSpotlight = settings?.shareCoverageSpotlight !== false;
    const includeCoverageDeathWave = settings?.shareCoverageDeathWave !== false;
    const includeCoverageOrbs = settings?.shareCoverageOrbs !== false;
    const includeCoverageGoldenBot = settings?.shareCoverageGoldenBot !== false;
    const includeCoverageAmpBot = settings?.shareCoverageAmpBot !== false;
    const includeCoverageSummoned = settings?.shareCoverageSummoned !== false;
    const includeShardsPerHour = settings?.shareShardsPerHour !== false;
    const includeWavesPerHour = settings?.shareWavesPerHour !== false;
    const includeEnemiesPerHour = settings?.shareEnemiesPerHour !== false;
    let embed: EmbedBuilder | null = null;

    if (mode === 'lifetime') {
      setStage('history');
      const entries = await getLocalLifetimeData(userId);
      const sorted = [...entries].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
      const latest = sorted[0];
      if (!latest) {
        await sendNotice(shareUiConfig.noRunsFound);
        return;
      }

      setStage('render');
      embed = new EmbedBuilder()
        .setAuthor({ name: shareUiConfig.authorTemplate.replace('{username}', resolveInteractionDisplayName(interaction)) })
        .setTitle(shareUiConfig.titleTemplate.replace('{typeCount}', String(Math.max(1, sorted.length))))
        .setURL(shareUiConfig.url)
        .setColor(Colors.Blue)
        .addFields(
          { name: '📅 Entry Date', value: String(latest.date ?? 'Unknown'), inline: true },
          { name: '🗓️ Game Started', value: String(latest.gameStarted ?? 'Unknown'), inline: true },
          { name: '🪙 Coins Earned', value: String(latest.coinsEarned ?? '0'), inline: true },
          { name: '⏱️ Recent Coins/Hr', value: String(latest.recentCoinsPerHour ?? '0'), inline: true },
          { name: '💵 Cash Earned', value: String(latest.cashEarned ?? '0'), inline: true },
          { name: '🧱 Stones Earned', value: String(latest.stonesEarned ?? '0'), inline: true },
          { name: '🗝️ Keys Earned', value: String(latest.keysEarned ?? '0'), inline: true },
          { name: '🔋 Cells Earned', value: String(latest.cellsEarned ?? '0'), inline: true },
          { name: '🎲 Dice Earned', value: String(latest.rerollShardsEarned ?? '0'), inline: true },
        );

      if (includeScreenshot && typeof latest.screenshotUrl === 'string' && latest.screenshotUrl.trim()) {
        embed.setImage(latest.screenshotUrl);
      }

      const channelForLifetime = interaction.channel as { send?: (payload: ShareEmbedChannelPayload) => Promise<unknown> } | null;
      if (!channelForLifetime?.send) {
        throw new Error('Unable to send share embed in this channel.');
      }
      try {
        setStage('payload');
        const payload = await resolveShareEmbedChannelPayload({
          userId,
          embed,
        });
        setStage('send');
        await channelForLifetime.send(payload);
      } catch (error) {
        throw error;
      }
      setStage('finalize');
      await disableShareButtonOnOriginalMessage(interaction);
    } else {
      setStage('history');
      // Both reads use fresh settings/history and neither depends on the other.
      const [history, sharedSettings] = await Promise.all([
        withBotRunSubmissionLock(userId, context => prepareBotRunUploadHistory(userId, { localFirst: true, readOnly: true, onStage: context.setStage }), 'share-history'),
        getEffectiveUserSharedSettings(userId, { localOnly: settings?.cloudSyncEnabled === false }),
      ]);
      const verifiedRuns = await history.getRuns();
      const cached = getShareableRun(userId);
      let run = cached?.run ?? null;
      const { runTypeCounts } = await getLocalRunSummary(userId, verifiedRuns);

      if (run) {
        const selected = verifiedRuns.find(existing => trackerRunReferencesSameEntry({ left: { localId: existing.localId, runId: existing.runId, fallbackRunId: existing.id }, right: { localId: run!.localId, runId: run!.runId, fallbackRunId: run!.id } }));
        if (!selected) {
          await sendNotice('This run is no longer in your current history. Please choose another run.');
          return;
        }
        // Refresh the selected entry's data as well as its count. Never display stale draft values.
        run = { ...selected };
      }
      if (!run) {
        run = [...verifiedRuns].sort((a, b) => estimateTrackerRunTimestamp(b) - estimateTrackerRunTimestamp(a))[0] ?? null;
      }

      if (!run) {
        await sendNotice(shareUiConfig.noRunsFound);
        return;
      }



      // Compact only where required (this server) or where the user opted in; otherwise expanded.
      const compact = shouldCompactShare({ guildId: interaction.guildId, shareCompact: settings?.shareCompact });

      // Fetch all runs for the delta baseline
      const allRuns = verifiedRuns;
      const runType = String(run.type ?? 'Farming').trim() || 'Farming';

      const deltaResult = (history.verified !== false || history.completeLocal === true) && sharedSettings.runDeltaMode !== 'disabled'
        ? computeTrackerRunDeltaBaseline(allRuns, runType, sharedSettings.runDeltaMode, undefined, run)
        : undefined;

      const embedUser = buildEmbedUserFromInteraction(interaction);
      setStage('render');
      embed = buildShareEmbed({
        user: embedUser,
        run,
        runTypeCounts,
        options: {
          includeTier,
          includeWave,
          includeDuration,
          includeKilledBy,
          includeTotalCoins,
          includeTotalCells,
          includeTotalDice,
          includeTotalShards,
          includeDeathDefy,
          includeCoinsPerHour,
          includeCellsPerHour,
          includeDicePerHour,
          includeShardsPerHour,
          includeWavesPerHour,
          includeEnemiesPerHour,
          includeNotes,
          includeCoverage,
          includeCoverageGoldenTower,
          includeCoverageBlackHole,
          includeCoverageSpotlight,
          includeCoverageDeathWave,
          includeCoverageOrbs,
          includeCoverageGoldenBot,
          includeCoverageAmpBot,
          includeCoverageSummoned,
          includeScreenshot,
        },
        deltaResult,
        collapsed: compact,
      });

      if (history.verified === false) {
        embed.setTitle(embed.data.title + ' (locally saved)');
        embed.setFooter({ text: 'Offline fallback: counts and comparisons use saved history and pending runs; cloud changes are not verified.' });
      }
      const channelWithSend = interaction.channel as { send?: (payload: ShareEmbedChannelPayload) => Promise<unknown> } | null;
      if (embed) {
        if (!channelWithSend?.send) {
          throw new Error('Unable to send share embed in this channel.');
        }

        const chartAttachment = settings?.shareChart !== false && allRuns.length >= 2
          ? await buildPerHourChartAttachment(allRuns, runType).catch(() => null)
          : null;

        // Compact shares only preview the chart as a thumbnail (the full-size chart rides along
        // with the Expand reply); expanded shares show it full-size inline.
        if (chartAttachment) {
          if (compact) embed.setThumbnail('attachment://per-hour-chart.png');
          else embed.setImage('attachment://per-hour-chart.png');
        }

        setStage('snapshot');
        let shareRunRef = buildShareSnapshotRef(userId, run, runTypeCounts, history.verified !== false, deltaResult ?? null);
        if (shareRunRef) {
          const saved = await saveShareSnapshot({ ref: shareRunRef, userId, run, runTypeCounts, sharerName: embedUser.displayName, historyVerified: history.verified !== false, deltaResult: deltaResult ?? null }).catch(() => false);
          if (!saved) shareRunRef = null;
        }

        try {
          setStage('payload');
          const payload = await resolveShareEmbedChannelPayload({
            userId,
            embed,
            files: chartAttachment ? [chartAttachment] : [],
            shareRunRef,
            collapsed: compact,
          });
          setStage('send');
          await channelWithSend.send(payload);
        } catch (error) {
          throw error;
        }

        setStage('finalize');
      await disableShareButtonOnOriginalMessage(interaction);
      }
      return;
    }
  } catch (error) {
    await logError(interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, interaction.user, error, 'track_menu_sharelast', null, null, stage);
    if (!acknowledged) return;
    const message = shareUiConfig.shareFailed;
    if (interaction.followUp) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else if (interaction.reply) {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  } finally {
    setStage(stage);
    logger.warn('[perf] share.operation', {
      durationMs: Math.round(performance.now() - started),
      stages: Object.fromEntries(Object.entries(stages).map(([name, ms]) => [name, Math.round(ms)])),
    });
  }
}
