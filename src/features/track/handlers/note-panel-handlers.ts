import * as Discord from 'discord.js';
import type {
  MessageComponentInteraction,
  ModalSubmitInteraction,
  StringSelectMenuBuilder} from 'discord.js';
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { logger } from '../../../core/logger';
import { TRACKER_IDS, withToken } from '../track-custom-ids';
import { getTrackerKv, setTrackerKv } from '../../../services/idb';
import { asTrackReplyInteraction } from './review-interaction-helpers';
import {
  renderUpdatedReviewAfterNote,
  resolveUpdatedPendingOrReplyExpired,
} from './review-edit-modal-helpers';
import { updatePendingRun } from '../pending-run-store';
import { awaitOwnedModalSubmit } from '../../../core/interaction-session';
import { handleError } from './error-handlers';
import { getTrackUiConfig } from '../../../config/tracker-ui-config';
import type { PendingRecordLike } from '../shared/track-review-records';
import type { TrackReplyInteractionLike } from '../interaction-types';

// ─── Module list (24 unique modules) ────────────────────────────────────────

const UNIQUE_MODULES = [
  { initials: 'AD',  name: 'Astral Deliverance',       type: 'Cannon' },
  { initials: 'BA',  name: 'Being Annihilator',         type: 'Cannon' },
  { initials: 'DP',  name: 'Death Penalty',             type: 'Cannon' },
  { initials: 'HB',  name: 'Havoc Bringer',             type: 'Cannon' },
  { initials: 'SR',  name: 'Shrink Ray',                type: 'Cannon' },
  { initials: 'AS',  name: 'Amplifying Strike',         type: 'Cannon' },
  { initials: 'ACP', name: 'Anti-Cube Portal',          type: 'Armor' },
  { initials: 'NMP', name: 'Negative Mass Projector',   type: 'Armor' },
  { initials: 'WR',  name: 'Wormhole Redirector',       type: 'Armor' },
  { initials: 'SD',  name: 'Space Displacer',           type: 'Armor' },
  { initials: 'SF',  name: 'Sharp Fortitude',           type: 'Armor' },
  { initials: 'OA',  name: 'Orbital Augment',           type: 'Armor' },
  { initials: 'SH',  name: 'Singularity Harness',       type: 'Generator' },
  { initials: 'GC',  name: 'Galaxy Compressor',         type: 'Generator' },
  { initials: 'PH',  name: 'Pulsar Harvester',          type: 'Generator' },
  { initials: 'BHD', name: 'Black Hole Digestor',       type: 'Generator' },
  { initials: 'PF',  name: 'Project Funding',           type: 'Generator' },
  { initials: 'RB',  name: 'Restorative Bonus',         type: 'Generator' },
  { initials: 'OC',  name: 'Om Chip',                   type: 'Core' },
  { initials: 'HC',  name: 'Harmony Conductor',         type: 'Core' },
  { initials: 'DC',  name: 'Dimension Core',            type: 'Core' },
  { initials: 'MVN', name: 'Multiverse Nexus',          type: 'Core' },
  { initials: 'MH',  name: 'Magnetic Hook',             type: 'Core' },
  { initials: 'PC',  name: 'Primordial Collapse',       type: 'Core' },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

type RenderEditFieldPickerFn = (
  interaction: TrackReplyInteractionLike,
  token: string,
  pending: PendingRecordLike,
  mode: 'update' | 'editReply',
) => Promise<void>;

type LooseRecord = Record<string, unknown>;
type ModalLookup = { customId?: string; values?: string[]; [key: string]: unknown };

type LabelBuilderInstance = {
  setLabel: (label: string) => LabelBuilderInstance;
  setStringSelectMenuComponent: (component: StringSelectMenuBuilder) => LabelBuilderInstance;
};
type BuildersLike = {
  StringSelectMenuBuilder: typeof StringSelectMenuBuilder;
  LabelBuilder: new () => LabelBuilderInstance;
};
type ModalWithLabelComponents = ModalBuilder & {
  addLabelComponents: (...components: unknown[]) => ModalBuilder;
};

type NoteDefaults = {
  primaryModules: string[];
  assistModules: string[];
  towerRange: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const NOTE_DEFAULTS_KV_PREFIX = 'tracker:note-defaults:v1:';

// ─── Local helpers ────────────────────────────────────────────────────────────

function toRecord(value: unknown): LooseRecord {
  return typeof value === 'object' && value !== null ? (value as LooseRecord) : {};
}

function findByCustomIdDeep(node: unknown, id: string, seen = new Set<unknown>()): ModalLookup | null {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);

  const record = toRecord(node);
  if (record.customId === id) return record as ModalLookup;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByCustomIdDeep(item, id, seen);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(record)) {
    const found = findByCustomIdDeep(value, id, seen);
    if (found) return found;
  }
  return null;
}

function readSelectValues(submitted: ModalSubmitInteraction, customId: string): string[] {
  try {
    const record = toRecord(submitted);
    const comp = findByCustomIdDeep(record.components ?? record, customId)
      ?? findByCustomIdDeep(toRecord(record.data).components ?? toRecord(record.data), customId);
    if (!comp) return [];
    const vals = comp.values;
    return Array.isArray(vals) ? vals.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Strip Tower Range/Primary Modules/Assist Modules lines from existing notes to get base text. */
function extractBaseNoteText(fullNotes: string): string {
  const structuredPrefixes = ['Tower Range:', 'Primary Modules:', 'Assist Modules:'];
  return fullNotes
    .split('\n')
    .filter(l => !structuredPrefixes.some(p => l.trim().startsWith(p)))
    .join('\n')
    .trim();
}

/** Assemble the final note text from parts. */
function assembleNoteText(parts: {
  noteText: string;
  primaryModules: string[];
  assistModules: string[];
  towerRange: string;
}): string {
  const result: string[] = [];
  if (parts.noteText.trim()) result.push(parts.noteText.trim());

  const structured: string[] = [];
  if (parts.towerRange) structured.push(`Tower Range: ${parts.towerRange}m`);
  if (parts.primaryModules.length > 0) structured.push(`Primary Modules: ${parts.primaryModules.join(' ')}`);
  if (parts.assistModules.length > 0) structured.push(`Assist Modules: ${parts.assistModules.join(' ')}`);

  if (structured.length > 0) {
    if (result.length > 0) result.push('');
    result.push(...structured);
  }

  return result.join('\n');
}

// ─── Display normalizer ───────────────────────────────────────────────────────

/** Module initials sorted longest-first for greedy left-to-right matching. */
const SORTED_INITIALS = [...UNIQUE_MODULES]
  .map(m => m.initials as string)
  .sort((a, b) => b.length - a.length);

/** Split a concatenated initials string (e.g. "ASACPBHDDC") into spaced tokens ("AS ACP BHD DC"). */
function splitModuleInitials(raw: string): string {
  const tokens: string[] = [];
  let remaining = raw;
  while (remaining.length > 0) {
    const matched = SORTED_INITIALS.find(init => remaining.startsWith(init));
    if (matched) {
      tokens.push(matched);
      remaining = remaining.slice(matched.length);
    } else {
      tokens.push(remaining);
      break;
    }
  }
  return tokens.join(' ');
}

/**
 * Converts the old compact note format (TowerRange:30mPrimaryModules:...AssistModules:...)
 * to the human-readable multi-line format used by the current modal.
 * Notes already in the new format are returned unchanged.
 */
export function normalizeNoteForDisplay(note: string): string {
  const str = note.trim();
  if (!str) return str;
  // Already in new format — has spaced key names
  if (/Tower Range:|Primary Modules:|Assist Modules:/.test(str)) return str;
  // Not an old compact note either — free-text note, pass through
  if (!/TowerRange:|PrimaryModules:|AssistModules:/.test(str)) return str;

  const lines: string[] = [];
  const trMatch = str.match(/TowerRange:(\d+(?:\.\d+)?)/i);
  if (trMatch) lines.push(`Tower Range: ${trMatch[1]}m`);

  const pmMatch = str.match(/PrimaryModules:([A-Z]+)(?=[A-Z][a-z]|$)/);
  if (pmMatch) lines.push(`Primary Modules: ${splitModuleInitials(pmMatch[1])}`);

  const amMatch = str.match(/AssistModules:([A-Z]+)(?=[A-Z][a-z]|$)/);
  if (amMatch) lines.push(`Assist Modules: ${splitModuleInitials(amMatch[1])}`);

  return lines.length ? lines.join('\n') : str;
}

// ─── Public: open the note modal ─────────────────────────────────────────────

export async function openNoteModal(
  component: MessageComponentInteraction,
  token: string,
  pending: PendingRecordLike,
  userId: string,
  returnMode: 'review' | 'edit',
  renderEditFieldPickerFn: RenderEditFieldPickerFn,
): Promise<void> {
  const defaults = await getTrackerKv<NoteDefaults>(`${NOTE_DEFAULTS_KV_PREFIX}${userId}`).catch(() => null);
  const existingNotes = String(pending.runData?.notes || pending.runData?.note || '');
  const baseNoteText = extractBaseNoteText(existingNotes);
  const initialPrimary: string[] = Array.isArray(defaults?.primaryModules) ? defaults.primaryModules : [];
  const initialAssist: string[] = Array.isArray(defaults?.assistModules) ? defaults.assistModules : [];
  const initialRange = typeof defaults?.towerRange === 'string' ? defaults.towerRange : '';

  const Builders = Discord as unknown as BuildersLike;
  const modal = new ModalBuilder()
    .setCustomId(withToken(TRACKER_IDS.review.noteModalPrefix, token))
    .setTitle('Add Note');

  const noteInput = new TextInputBuilder()
    .setCustomId(TRACKER_IDS.review.noteText)
    .setLabel('Note (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setValue(baseNoteText.slice(0, 4000));

  const rangeInput = new TextInputBuilder()
    .setCustomId(TRACKER_IDS.review.noteRangeInput)
    .setLabel('Tower Range in meters (30–300, optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('e.g. 150 or 150.5')
    .setValue(initialRange);

  const primarySelect = new Builders.StringSelectMenuBuilder()
    .setCustomId(TRACKER_IDS.review.notePanelPrimarySelect)
    .setPlaceholder('Select primary modules\u2026')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(4)
    .addOptions(UNIQUE_MODULES.map(mod => ({
      label: `${mod.initials} \u2013 ${mod.name}`,
      value: mod.initials,
      description: mod.type,
      default: initialPrimary.includes(mod.initials),
    })));

  const assistSelect = new Builders.StringSelectMenuBuilder()
    .setCustomId(TRACKER_IDS.review.notePanelAssistSelect)
    .setPlaceholder('Select assist modules\u2026')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(4)
    .addOptions(UNIQUE_MODULES.map(mod => ({
      label: `${mod.initials} \u2013 ${mod.name}`,
      value: mod.initials,
      description: mod.type,
      default: initialAssist.includes(mod.initials),
    })));

  const labeledPrimary = new Builders.LabelBuilder()
    .setLabel('Primary Modules')
    .setStringSelectMenuComponent(primarySelect);

  const labeledAssist = new Builders.LabelBuilder()
    .setLabel('Assist Modules')
    .setStringSelectMenuComponent(assistSelect);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(rangeInput),
  );
  (modal as ModalWithLabelComponents).addLabelComponents(labeledPrimary);
  (modal as ModalWithLabelComponents).addLabelComponents(labeledAssist);

  try {
    await component.showModal(modal);
  } catch (showErr) {
    logger.error('[note_modal] showModal failed:', showErr);
    // Acknowledge the interaction so Discord does not show "Interaction Failed"
    await component.deferUpdate().catch(() => {});
    await component.editReply({ content: 'Failed to open the note modal. Please try again.', embeds: [], components: [] }).catch(() => {});
    return;
  }

  try {
    const submitted = await awaitOwnedModalSubmit(component, withToken(TRACKER_IDS.review.noteModalPrefix, token));
    try { await submitted.deferUpdate(); } catch { /* already acknowledged */ }

    const noteText = submitted.fields.getTextInputValue(TRACKER_IDS.review.noteText)?.trim() || '';
    const rawRange = submitted.fields.getTextInputValue(TRACKER_IDS.review.noteRangeInput)?.trim() || '';
    const primaryModules = readSelectValues(submitted, TRACKER_IDS.review.notePanelPrimarySelect);
    const assistModules = readSelectValues(submitted, TRACKER_IDS.review.notePanelAssistSelect);

    let towerRange = '';
    if (rawRange) {
      const parsed = parseFloat(rawRange);
      if (!isNaN(parsed) && parsed >= 30 && parsed <= 300) {
        towerRange = String(Math.round(parsed * 100) / 100);
      }
    }

    const assistDeduped = assistModules.filter(m => !primaryModules.includes(m));
    const assembledNote = assembleNoteText({ noteText, primaryModules, assistModules: assistDeduped, towerRange });

    await setTrackerKv(`${NOTE_DEFAULTS_KV_PREFIX}${userId}`, {
      primaryModules,
      assistModules: assistDeduped,
      towerRange,
    } satisfies NoteDefaults).catch(() => {});

    const updated = await updatePendingRun(token, { runData: { ...pending.runData, notes: assembledNote } });
    const ui = getTrackUiConfig();
    const updatedPending = await resolveUpdatedPendingOrReplyExpired(
      submitted,
      updated,
      ui.manual.sessionExpired,
    );
    if (!updatedPending) return;

    await renderUpdatedReviewAfterNote(
      asTrackReplyInteraction(submitted),
      token,
      updatedPending,
      returnMode,
      renderEditFieldPickerFn,
    );
  } catch (err: unknown) {
    if (String(err || '').includes('TIME')) {
      return;
    }
    await handleError({ client: component.client, user: component.user, error: err, context: 'note_modal' });
  }
}

