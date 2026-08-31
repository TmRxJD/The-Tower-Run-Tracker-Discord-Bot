import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { canonicalizeRunData } from '@tmrxjd/platform/tools';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import { standardizeNotation } from '../../../utils/tracker-math';
import { getTrackerFlowMode } from '../flow-mode-store';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { createAddNoteAndShowFullParseButtonRow, createConfirmationButtons, createDataReviewEmbed, createShowFullParseButtonRow, createTypeSelectionRow } from './tracker-ui';
import { parseTierString } from '../handlers/upload-helpers';
import type { PendingRecordLike, RunDataRecord } from '../shared/track-review-records';
import { buildProfileSelectRow } from './profile-select';

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
    return canonicalizeRunData(nextRunData);
  }

  if (field === 'totalCoins' || field === 'totalCells' || field === 'totalDice') {
    nextRunData[field] = rawValue ? standardizeNotation(rawValue) : null;
    return canonicalizeRunData(nextRunData);
  }

  if (field === 'wave') {
    nextRunData.wave = rawValue;
    return canonicalizeRunData(nextRunData);
  }

  nextRunData[field] = rawValue;
  return canonicalizeRunData(nextRunData);
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

  // Retarget-this-run profile selector (only when the user has >1 profile).
  const profileRow = buildProfileSelectRow({
    customId: withToken(TRACKER_IDS.review.profileSelectPrefix, params.token),
    options: params.pending.profileOptions ?? [],
    selectedProfileId: params.pending.uploadProfileId ?? null,
    placeholder: 'Upload this run to profile',
  });

  const baseRows = params.includeType
    ? [createTypeSelectionRow(params.token, params.selectedType), noteAndParseRow, ...createConfirmationButtons(params.token)]
    : [noteAndParseRow, ...createConfirmationButtons(params.token)];

  return {
    embeds: [createDataReviewEmbed(
      params.pending.runData,
      params.label ?? 'Extracted',
      params.pending.isDuplicate ?? false,
      params.pending.screenshot?.url ?? null,
      getTrackerFlowMode(params.pending.userId),
    )],
    components: profileRow ? [profileRow, ...baseRows] : baseRows,
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
      pending.screenshot?.url ?? null,
      getTrackerFlowMode(pending.userId),
    )],
    components: [fieldSelect, notesRow, nav],
  };
}