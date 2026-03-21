import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  MessageComponentInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { standardizeNotation } from '../../../utils/tracker-math';
import { formatDate, formatTime, parseTierString } from './upload-helpers';
import { getPendingRun, updatePendingRun } from '../pending-run-store';
import { renderDataReview } from './data-review-handlers';
import { logError } from './error-handlers';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import type { TrackerUiMode } from '../../../config/tracker-ui-config';
import { getTrackerFlowMode } from '../flow-mode-store';

type ManualInteraction = MessageComponentInteraction | ModalSubmitInteraction;
type RunDataRecord = Record<string, unknown> & {
  tier?: unknown;
  tierDisplay?: unknown;
  tierHasPlus?: unknown;
  wave?: unknown;
  roundDuration?: unknown;
  duration?: unknown;
  totalCoins?: unknown;
  coins?: unknown;
  totalCells?: unknown;
  cells?: unknown;
  totalDice?: unknown;
  dice?: unknown;
  rerollShards?: unknown;
  killedBy?: unknown;
  date?: unknown;
  time?: unknown;
  notes?: unknown;
  note?: unknown;
  type?: unknown;
  reportTimestamp?: unknown;
};

type PendingRecordLike = {
  token: string;
  userId: string;
  username: string;
  runData: RunDataRecord;
};

type ManualDeps = {
  createPendingRunWithMetadata: (params: {
    userId: string;
    username: string;
    runData: RunDataRecord;
    screenshot?: { url: string; name?: string; contentType?: string } | null;
    canonicalRunData?: RunDataRecord | null;
  }) => Promise<PendingRecordLike>;
  handleAddRunFlow: (interaction: ManualInteraction) => Promise<void>;
  renderTrackMenu: (interaction: TrackReplyInteractionLike) => Promise<void>;
};

async function updateManualMessage(interaction: ManualInteraction, content: string) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }
  await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
}

function toRunDataRecord(value: unknown): RunDataRecord {
  return (typeof value === 'object' && value !== null ? value : {}) as RunDataRecord;
}

function toPendingRecord(value: unknown): PendingRecordLike | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.token !== 'string' || typeof rec.userId !== 'string' || typeof rec.username !== 'string') return null;
  return {
    token: rec.token,
    userId: rec.userId,
    username: rec.username,
    runData: toRunDataRecord(rec.runData),
  };
}

function getManualToken(customId: string) {
  return customId.includes(':') ? customId.split(':')[1] : null;
}

function withManualDefaults(runData: RunDataRecord, mode: TrackerUiMode) {
  const now = new Date();
  const defaults: RunDataRecord = {
    tier: runData?.tier ?? null,
    tierDisplay: runData?.tierDisplay ?? null,
    tierHasPlus: runData?.tierHasPlus ?? false,
    wave: runData?.wave ?? null,
    roundDuration: runData?.roundDuration ?? runData?.duration ?? '0h0m0s',
    totalCoins: runData?.totalCoins ?? runData?.coins ?? null,
    totalCells: runData?.totalCells ?? runData?.cells ?? null,
    totalDice: runData?.totalDice ?? runData?.dice ?? runData?.rerollShards ?? null,
    killedBy: runData?.killedBy ?? 'Apathy',
    date: runData?.date ?? formatDate(now),
    time: runData?.time ?? formatTime(now),
    notes: runData?.notes ?? runData?.note ?? '',
    reportTimestamp: runData?.reportTimestamp ?? now.toISOString(),
  };

  if (mode === 'track') {
    defaults.type = runData?.type ?? 'Farming';
  }

  return defaults;
}

function manualButtons(token: string, mode: TrackerUiMode) {
  const manualUi = getTrackUiConfig().manual;
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TRACKER_IDS.manual.editCorePrefix).setLabel(manualUi.buttons.editCore).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.manual.editExtraPrefix, token)).setLabel(manualUi.buttons.editExtra).setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(TRACKER_IDS.manual.backPrefix).setLabel(manualUi.buttons.back).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.manual.nextPrefix, token)).setLabel(manualUi.buttons.reviewSubmit).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.cancelPrefix, token)).setLabel(manualUi.buttons.cancel).setStyle(ButtonStyle.Danger),
    ),
  ];

  if (mode === 'track') {
    (rows[0] as ActionRowBuilder<ButtonBuilder>).addComponents(
      new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.manual.notePrefix, token)).setLabel(manualUi.buttons.addNote).setStyle(ButtonStyle.Secondary),
    );
    rows.unshift(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(withToken(TRACKER_IDS.manual.typePrefix, token))
          .setPlaceholder(manualUi.typePlaceholder)
          .addOptions(...manualUi.typeOptions.map((item) => ({ label: item, value: item }))),
      ),
    );
  }

  return rows;
}

async function renderManualDraft(interaction: ManualInteraction, token: string, pending: PendingRecordLike) {
  const mode = getTrackerFlowMode(interaction.user.id);
  const manualUi = getTrackUiConfig().manual;
  const runData = withManualDefaults(pending?.runData ?? {}, mode);
  const embed = new EmbedBuilder()
    .setTitle(manualUi.title)
    .setDescription(manualUi.description)
    .setColor(Colors.Blurple);

  const formatValue = (val: unknown, fallback = '—') => {
    if (val === null || val === undefined) return fallback;
    const str = String(val).trim();
    return str === '' ? fallback : str;
  };

  const tierDisplay = runData.tierDisplay || runData.tier;
  embed.addFields(
    { name: '🔢 Tier', value: formatValue(tierDisplay), inline: true },
    { name: '🌊 Wave', value: formatValue(runData.wave), inline: true },
    { name: '⏱️ Duration', value: formatValue(runData.roundDuration), inline: true },
    { name: '🪙 Coins', value: formatValue(runData.totalCoins), inline: true },
    { name: '🔋 Cells', value: formatValue(runData.totalCells), inline: true },
    { name: '🎲 Dice', value: formatValue(runData.totalDice), inline: true },
    { name: '💀 Killed By', value: formatValue(runData.killedBy, 'Apathy'), inline: true },
    { name: '📅 Date', value: formatValue(runData.date), inline: true },
    { name: '⏰ Time', value: formatValue(runData.time), inline: true },
  );

  if (mode === 'track') {
    embed.addFields({ name: '📋 Run Type', value: formatValue(runData.type, 'Farming'), inline: true });
  }

  const notesText = String(runData.notes || '').trim();
  if (notesText) {
    embed.addFields({ name: '📝 Notes', value: notesText.slice(0, 1024), inline: false });
  }

  await interaction.editReply({ embeds: [embed], components: manualButtons(token, mode), files: [] }).catch(() => {});
}

async function openManualStageOne(interaction: ManualInteraction, token: string, current: RunDataRecord) {
  const manualUi = getTrackUiConfig().manual;
  const reviewLabels = getTrackUiConfig().review.fieldLabels;
  const component = interaction as MessageComponentInteraction;
  const modal = new ModalBuilder().setCustomId(withToken(TRACKER_IDS.manual.modalOnePrefix, token)).setTitle(manualUi.modals.coreTitle);
  const tierInput = new TextInputBuilder().setCustomId('tier').setLabel(reviewLabels.tier).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current?.tierDisplay || current?.tier || ''));
  const waveInput = new TextInputBuilder().setCustomId('wave').setLabel(reviewLabels.wave).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current?.wave || ''));
  const durationInput = new TextInputBuilder().setCustomId('duration').setLabel(reviewLabels.roundDuration).setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current?.roundDuration || current?.duration || ''));
  const coinsInput = new TextInputBuilder().setCustomId('coins').setLabel(reviewLabels.totalCoins).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(current?.totalCoins || current?.coins || ''));
  const cellsInput = new TextInputBuilder().setCustomId('cells').setLabel(reviewLabels.totalCells).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(current?.totalCells || current?.cells || ''));
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(tierInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(waveInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(durationInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(coinsInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(cellsInput),
  );

  await component.showModal(modal);
  const submitted = await component.awaitModalSubmit({
    filter: (i) => i.customId === withToken(TRACKER_IDS.manual.modalOnePrefix, token) && i.user.id === interaction.user.id,
    time: 300_000,
  });

  try {
    await submitted.deferUpdate();
  } catch {
    /* ignore */
  }

  const tierRaw = submitted.fields.getTextInputValue('tier') || '';
  const tierInfo = parseTierString(tierRaw);
  const waveRaw = submitted.fields.getTextInputValue('wave') || '';
  const durationRaw = submitted.fields.getTextInputValue('duration') || '';
  const coinsRaw = submitted.fields.getTextInputValue('coins') || '';
  const cellsRaw = submitted.fields.getTextInputValue('cells') || '';

  return {
    tier: tierInfo.numeric,
    tierDisplay: tierInfo.hasPlus && tierInfo.numeric !== null ? `${tierInfo.numeric}+` : tierRaw,
    tierHasPlus: tierInfo.hasPlus,
    wave: waveRaw,
    roundDuration: durationRaw,
    totalCoins: coinsRaw ? standardizeNotation(coinsRaw) : null,
    totalCells: cellsRaw ? standardizeNotation(cellsRaw) : null,
  };
}

async function openManualStageTwo(interaction: ManualInteraction, token: string, current: RunDataRecord) {
  const manualUi = getTrackUiConfig().manual;
  const reviewLabels = getTrackUiConfig().review.fieldLabels;
  const component = interaction as MessageComponentInteraction;
  const modal = new ModalBuilder().setCustomId(withToken(TRACKER_IDS.manual.modalTwoPrefix, token)).setTitle(manualUi.modals.extraTitle);
  const diceInput = new TextInputBuilder().setCustomId('dice').setLabel(reviewLabels.totalDice).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(current?.totalDice || current?.dice || current?.rerollShards || ''));
  const killedByInput = new TextInputBuilder().setCustomId('killedBy').setLabel(reviewLabels.killedBy).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(current?.killedBy || 'Apathy'));
  const dateInput = new TextInputBuilder().setCustomId('date').setLabel(reviewLabels.date).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(current?.date || formatDate(new Date())));
  const timeInput = new TextInputBuilder().setCustomId('time').setLabel(reviewLabels.time).setStyle(TextInputStyle.Short).setRequired(false).setValue(String(current?.time || formatTime(new Date())));
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(diceInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(killedByInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(dateInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput),
  );

  await component.showModal(modal);
  const submitted = await component.awaitModalSubmit({
    filter: (i) => i.customId === withToken(TRACKER_IDS.manual.modalTwoPrefix, token) && i.user.id === interaction.user.id,
    time: 300_000,
  });

  try {
    await submitted.deferUpdate();
  } catch {
    /* ignore */
  }

  const diceRaw = submitted.fields.getTextInputValue('dice') || '';
  const killedByRaw = submitted.fields.getTextInputValue('killedBy') || '';
  const dateRaw = submitted.fields.getTextInputValue('date') || '';
  const timeRaw = submitted.fields.getTextInputValue('time') || '';

  return {
    totalDice: diceRaw ? standardizeNotation(diceRaw) : null,
    killedBy: killedByRaw ? killedByRaw.trim() : 'Apathy',
    date: dateRaw ? dateRaw.trim() : formatDate(new Date()),
    time: timeRaw ? timeRaw.trim() : formatTime(new Date()),
  };
}

export function createManualHandlers(deps: ManualDeps) {
  const { createPendingRunWithMetadata, handleAddRunFlow, renderTrackMenu } = deps;

  const handleTrackMenuUploadAnother = async (interaction: ManualInteraction) => {
    try {
      await handleAddRunFlow(interaction);
    } catch (error) {
      await logError(interaction.client, interaction.user, error, 'track_menu_upload_another');
    }
  };

  const handleTrackMenuManual = async (interaction: ManualInteraction) => {
    try {
      const mode = getTrackerFlowMode(interaction.user.id);
      await interaction.deferUpdate().catch(() => {});
      const pending = await createPendingRunWithMetadata({
        userId: interaction.user.id,
        username: interaction.user.username,
        runData: withManualDefaults({}, mode),
        canonicalRunData: null,
        screenshot: null,
      });
      await renderManualDraft(interaction, pending.token, pending);
    } catch (error) {
      const manualUi = getTrackUiConfig().manual;
      await logError(interaction.client, interaction.user, error, 'track_menu_manual');
      await interaction.editReply({ content: manualUi.startFailed, embeds: [], components: [] }).catch(() => {});
    }
  };

  const handleManualTypeSelection = async (interaction: ManualInteraction) => {
    try {
      const manualUi = getTrackUiConfig().manual;
      const token = getManualToken(interaction.customId);
      if (!token) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }
      const pending = toPendingRecord(await getPendingRun(token));
      if (!pending || pending.userId !== interaction.user.id) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }
      if (getTrackerFlowMode(interaction.user.id) !== 'track') {
        await interaction.deferUpdate().catch(() => {});
        await renderManualDraft(interaction, token, pending);
        return;
      }
      const selectedType = 'values' in interaction && Array.isArray(interaction.values) && interaction.values[0] ? interaction.values[0] : 'Farming';
      const updated = await updatePendingRun(token, { runData: { ...pending.runData, type: selectedType } });
      if (!updated) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }
      await interaction.deferUpdate().catch(() => {});
      await renderManualDraft(interaction, token, updated);
    } catch (error) {
      await logError(interaction.client, interaction.user, error, 'manual_type_selection');
    }
  };

  const handleManualNote = async (interaction: ManualInteraction) => {
    try {
      const manualUi = getTrackUiConfig().manual;
      const component = interaction as MessageComponentInteraction;
      const token = getManualToken(interaction.customId);
      if (!token) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }
      const pending = toPendingRecord(await getPendingRun(token));
      if (!pending || pending.userId !== interaction.user.id) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }
      if (getTrackerFlowMode(interaction.user.id) !== 'track') {
        await interaction.deferUpdate().catch(() => {});
        await renderManualDraft(interaction, token, pending);
        return;
      }

      const modal = new ModalBuilder().setCustomId(withToken(TRACKER_IDS.manual.noteModalPrefix, token)).setTitle(manualUi.modals.noteTitle);
      const noteInput = new TextInputBuilder()
        .setCustomId(TRACKER_IDS.manual.noteText)
        .setLabel(manualUi.modals.noteLabel)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(String(pending.runData?.notes || ''));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput));
      await component.showModal(modal);

      const submitted = await component.awaitModalSubmit({
        filter: (i) => i.customId === withToken(TRACKER_IDS.manual.noteModalPrefix, token) && i.user.id === interaction.user.id,
        time: 300_000,
      });

      try {
        await submitted.deferUpdate();
      } catch {
        /* ignore */
      }

      const nextNote = submitted.fields.getTextInputValue(TRACKER_IDS.manual.noteText) || '';
      const updated = await updatePendingRun(token, { runData: { ...pending.runData, notes: nextNote } });
      if (!updated) {
        await interaction.editReply({ content: manualUi.sessionExpired, embeds: [], components: [] }).catch(() => {});
        return;
      }

      await renderManualDraft(interaction, token, updated);
    } catch (error) {
      await logError(interaction.client, interaction.user, error, 'manual_note');
    }
  };

  const handleManualEditStageOne = async (interaction: ManualInteraction) => {
    try {
      const manualUi = getTrackUiConfig().manual;
      let token = getManualToken(interaction.customId || '');
      if (!token) {
        const messageEmbed = interaction.message?.embeds?.[0];
        if (messageEmbed) {
          const firstRow = interaction.message?.components?.[0];
          const rowComponents = firstRow && 'components' in firstRow ? (firstRow as { components?: Array<{ customId?: string }> }).components : undefined;
          const manualTypeRow = rowComponents?.find((c) => String(c.customId || '').startsWith(TRACKER_IDS.manual.typePrefix));
          token = getManualToken(manualTypeRow?.customId || '');
        }
      }

      if (!token) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }

      const pending = toPendingRecord(await getPendingRun(token));
      if (!pending || pending.userId !== interaction.user.id) {
        await updateManualMessage(interaction, manualUi.sessionExpired);
        return;
      }

      const patch = await openManualStageOne(interaction, token, pending.runData);
      const updated = await updatePendingRun(token, { runData: withManualDefaults({ ...pending.runData, ...patch }, getTrackerFlowMode(interaction.user.id)) });
      if (!updated) {
        await interaction.editReply({ content: manualUi.sessionExpired, embeds: [], components: [] }).catch(() => {});
        return;
      }

      await renderManualDraft(interaction, token, updated);
    } catch (error: unknown) {
      if (!String(error || '').includes('TIME')) {
        await logError(interaction.client, interaction.user, error, 'manual_edit_stage_one');
      }
    }
  };

  const handleManualEditStageTwo = async (interaction: ManualInteraction) => {
    try {
      const token = getManualToken(interaction.customId || '');
      if (!token) {
        await updateManualMessage(interaction, getTrackUiConfig().manual.sessionExpired);
        return;
      }
      const pending = toPendingRecord(await getPendingRun(token));
      if (!pending || pending.userId !== interaction.user.id) {
        await updateManualMessage(interaction, getTrackUiConfig().manual.sessionExpired);
        return;
      }

      const patch = await openManualStageTwo(interaction, token, pending.runData);
      const updated = await updatePendingRun(token, { runData: withManualDefaults({ ...pending.runData, ...patch }, getTrackerFlowMode(interaction.user.id)) });
      if (!updated) {
        await interaction.editReply({ content: getTrackUiConfig().manual.sessionExpired, embeds: [], components: [] }).catch(() => {});
        return;
      }

      await renderManualDraft(interaction, token, updated);
    } catch (error: unknown) {
      if (!String(error || '').includes('TIME')) {
        await logError(interaction.client, interaction.user, error, 'manual_edit_stage_two');
      }
    }
  };

  const handleManualNext = async (interaction: ManualInteraction) => {
    try {
      const token = getManualToken(interaction.customId || '');
      if (!token) {
        await updateManualMessage(interaction, getTrackUiConfig().manual.sessionExpired);
        return;
      }
      const pending = toPendingRecord(await getPendingRun(token));
      if (!pending || pending.userId !== interaction.user.id) {
        await updateManualMessage(interaction, getTrackUiConfig().manual.sessionExpired);
        return;
      }

      const runData = withManualDefaults(pending.runData, getTrackerFlowMode(interaction.user.id));
      if (!runData.tier || !runData.wave || !runData.roundDuration) {
        await updateManualMessage(interaction, getTrackUiConfig().manual.requiredCoreFields);
        return;
      }

      const updated = await updatePendingRun(token, { runData, runSource: 'manual' });
      if (!updated) {
        await updateManualMessage(interaction, getTrackUiConfig().manual.sessionExpired);
        return;
      }

      await interaction.deferUpdate().catch(() => {});
      await renderDataReview(interaction as unknown as TrackReplyInteractionLike, token, updated, 'Manual');
    } catch (error) {
      await logError(interaction.client, interaction.user, error, 'manual_next');
    }
  };

  const handleManualBackToMenu = async (interaction: ManualInteraction) => {
    try {
      await interaction.deferUpdate().catch(() => {});
      await renderTrackMenu(interaction as unknown as TrackReplyInteractionLike);
    } catch (error) {
      await logError(interaction.client, interaction.user, error, 'manual_back_to_menu');
    }
  };

  return {
    handleTrackMenuUploadAnother,
    handleTrackMenuManual,
    handleManualTypeSelection,
    handleManualNote,
    handleManualEditStageOne,
    handleManualEditStageTwo,
    handleManualNext,
    handleManualBackToMenu,
  };
}
