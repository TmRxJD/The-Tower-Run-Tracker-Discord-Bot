import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { standardizeNotation } from '../../../utils/tracker-math';
import { getTrackerFlowMode } from '../flow-mode-store';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { createAddNoteAndShowFullParseButtonRow, createConfirmationButtons, createDataReviewEmbed, createShowFullParseButtonRow, createTypeSelectionRow } from './tracker-ui';
import { parseTierString } from '../handlers/upload-helpers';
import { canonicalizeTrackerRunData } from '../shared/run-data-normalization';
import type { PendingRecordLike, RunDataRecord } from '../shared/track-review-records';

function createEditNotesButtonRow(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(withToken(TRACKER_IDS.review.editNotesPrefix, token))
      .setLabel('Add Note')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function getCurrentEditFieldValue(runData: RunDataRecord, field: string): string {
  if (field === 'tier') return String(runData?.tierDisplay ?? runData?.tier ?? '');
  return String(runData?.[field] ?? '');
}

export function applyEditFieldValue(runData: RunDataRecord, field: string, rawValue: string): RunDataRecord {
  const nextRunData = { ...runData };
  if (field === 'tier') {
    const parsed = parseTierString(rawValue);
    nextRunData.tier = parsed.numeric ?? runData?.tier ?? null;
    nextRunData.tierDisplay = parsed.hasPlus && parsed.numeric !== null ? `${parsed.numeric}+` : rawValue;
    nextRunData.tierHasPlus = parsed.hasPlus;
    return canonicalizeTrackerRunData(nextRunData);
  }

  if (field === 'totalCoins' || field === 'totalCells' || field === 'totalDice') {
    nextRunData[field] = rawValue ? standardizeNotation(rawValue) : null;
    return canonicalizeTrackerRunData(nextRunData);
  }

  if (field === 'wave') {
    nextRunData.wave = rawValue;
    return canonicalizeTrackerRunData(nextRunData);
  }

  nextRunData[field] = rawValue;
  return canonicalizeTrackerRunData(nextRunData);
}

export function buildReviewPayload(params: {
  token: string;
  pending: PendingRecordLike;
  includeType: boolean;
  includeNotes: boolean;
  selectedType: string;
  label?: string;
}) {
  const noteAndParseRow = params.includeNotes
    ? createAddNoteAndShowFullParseButtonRow(params.token)
    : createShowFullParseButtonRow(params.token);

  return {
    embeds: [createDataReviewEmbed(
      params.pending.runData,
      params.label ?? 'Extracted',
      params.pending.isDuplicate ?? false,
      params.pending.decimalPreference,
      params.pending.screenshot?.url ?? null,
      getTrackerFlowMode(params.pending.userId),
    )],
    components: params.includeType
      ? [createTypeSelectionRow(params.token, params.selectedType), noteAndParseRow, ...createConfirmationButtons(params.token)]
      : [noteAndParseRow, ...createConfirmationButtons(params.token)],
  };
}

export function buildEditFieldPickerPayload(token: string, pending: PendingRecordLike) {
  const ui = getTrackUiConfig().review;
  const fieldSelect = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(withToken(TRACKER_IDS.review.editFieldPrefix, token))
      .setPlaceholder(ui.modals.editFieldTitle)
      .setMinValues(1)
      .setMaxValues(Math.min(5, Object.keys(ui.fieldLabels).length))
      .addOptions(...Object.entries(ui.fieldLabels).map(([value, label]) => ({ label, value }))),
  );
  const notesRow = createEditNotesButtonRow(token);
  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.editDonePrefix, token)).setLabel(ui.buttons.doneEditing).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(withToken(TRACKER_IDS.review.cancelPrefix, token)).setLabel(ui.buttons.cancel).setStyle(ButtonStyle.Danger),
  );

  return {
    embeds: [createDataReviewEmbed(
      pending.runData,
      ui.messages.editLabel,
      pending.isDuplicate ?? false,
      pending.decimalPreference,
      pending.screenshot?.url ?? null,
      getTrackerFlowMode(pending.userId),
    )],
    components: [fieldSelect, notesRow, nav],
  };
}