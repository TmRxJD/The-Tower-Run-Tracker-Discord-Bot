import { logError } from './error-handlers';
import { getLastRun, getLocalLifetimeData, getUserSettings } from '../tracker-api-client';
import { buildShareEmbed } from '../share/share-embed';
import { buildEmbedUserFromInteraction, resolveInteractionDisplayName } from '../discord-display-name';
import { getShareableRun, setShareableRun } from '../share/share-state';
import { getTrackerUiConfig } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';
import { TRACKER_IDS } from '../track-custom-ids';
import { EmbedBuilder, Colors, type MessageComponentInteraction, type ModalSubmitInteraction } from 'discord.js';

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
  try {
    let acknowledged = false;
    try {
      await interaction.deferUpdate();
      acknowledged = true;
    } catch {
      try {
        await interaction.deferReply({ ephemeral: true });
        acknowledged = true;
      } catch {
        /* ignore */
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
    let embed: EmbedBuilder | null = null;

    if (mode === 'lifetime') {
      const entries = await getLocalLifetimeData(userId);
      const sorted = [...entries].sort((a, b) => new Date(String(b.date ?? '')).getTime() - new Date(String(a.date ?? '')).getTime());
      const latest = sorted[0];
      if (!latest) {
        await sendNotice(shareUiConfig.noRunsFound);
        return;
      }

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
    } else {
      const cached = getShareableRun(userId);
      let run = cached?.run ?? null;
      let runTypeCounts = cached?.runTypeCounts ?? {};

      if (!run) {
        const summary = await getLastRun(userId, { cloudSyncMode: 'none' });
        run = summary?.lastRun ?? null;
        runTypeCounts = summary?.runTypeCounts ?? {};
      }

      if (!run) {
        await sendNotice(shareUiConfig.noRunsFound);
        return;
      }

      embed = buildShareEmbed({
        user: buildEmbedUserFromInteraction(interaction),
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
          includeDeathDefy,
          includeCoinsPerHour,
          includeCellsPerHour,
          includeDicePerHour,
          includeNotes,
          includeCoverage,
          includeScreenshot,
        },
      });
    }

    const channelWithSend = interaction.channel as { send?: (payload: { embeds: unknown[] }) => Promise<unknown> } | null;
    if (embed) {
      if (!channelWithSend?.send) {
        throw new Error('Unable to send share embed in this channel.');
      }

      try {
        await channelWithSend.send({ embeds: [embed] });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown channel error';
        throw new Error(`Unable to send share embed in this channel: ${reason}`);
      }

      await disableShareButtonOnOriginalMessage(interaction);
    }
  } catch (error) {
    await logError(interaction.client as { channels: { fetch: (id: string) => Promise<unknown> } }, interaction.user, error, 'track_menu_sharelast');
    const errorDetails = error instanceof Error ? ` ${error.message}` : '';
    const message = `${shareUiConfig.shareFailed}${errorDetails}`.trim();
    if (interaction.followUp) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else if (interaction.reply) {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
}
