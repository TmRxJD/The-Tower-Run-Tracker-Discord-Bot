import { TRACKER_IDS } from './track-custom-ids';

/** The former manual entry and image OCR workflows are deprecated and off by default. */
export function legacyTrackerInputEnabled(): boolean {
  return process.env.TRACKER_BOT_ENABLE_LEGACY_INPUT?.trim().toLowerCase() === 'true';
}

export const BATTLE_REPORT_EXPORT_HELP =
  'Use /track to paste the in-game Battle Report export, or import a supported save file.';

export const LEGACY_TRACKER_INPUT_DISABLED = BATTLE_REPORT_EXPORT_HELP;
export const LIFETIME_EXPORT_HELP =
  'To import Lifetime Stats, use /track → Import Save File. Existing entries can still be viewed and edited here.';

export async function replyLegacyTrackerInputDisabled(interaction: {
  deferred?: boolean;
  replied?: boolean;
  deferUpdate?: () => Promise<unknown>;
  editReply: (payload: { content: string; embeds: []; components: [] }) => Promise<unknown>;
}, content = LEGACY_TRACKER_INPUT_DISABLED): Promise<void> {
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate?.().catch(() => {});
  await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
}

export function isDeprecatedTrackerInputModal(customId: string): boolean {
  return customId === TRACKER_IDS.flow.uploadModal ||
    [TRACKER_IDS.manual.modalPrefix, TRACKER_IDS.manual.modalOnePrefix,
      TRACKER_IDS.manual.modalTwoPrefix, TRACKER_IDS.manual.noteModalPrefix]
      .some(prefix => customId.startsWith(prefix));
}
