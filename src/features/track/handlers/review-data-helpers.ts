import { formatDate, formatTime } from './upload-helpers';
import { ensureType } from './review-interaction-helpers';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { applyRunDataAliasGroups, canonicalizeRunDataForOutput } from '../shared/run-data-normalization';
import { TRACK_RUN_SUBMIT_ALIAS_GROUPS } from '../shared/track-run-field-vocabulary';
import type { RunDataRecord } from '../shared/track-review-records';

const ORDERED_CORE_KEYS = [
  'tierDisplay',
  'tier',
  'wave',
  'roundDuration',
  'duration',
  'totalCoins',
  'totalCells',
  'totalDice',
  'killedBy',
  'date',
  'time',
  'type',
];

export function buildRawParseText(data: RunDataRecord): string {
  const normalizedData = canonicalizeRunDataForOutput(data);
  const lines: string[] = [];

  for (const key of ORDERED_CORE_KEYS) {
    const value = normalizedData[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    lines.push(`${key}: ${text}`);
  }

  const remainingEntries = Object.entries(normalizedData)
    .filter(([key, value]) => !ORDERED_CORE_KEYS.includes(key) && value !== undefined && value !== null && String(value).trim() !== '')
    .sort(([left], [right]) => left.localeCompare(right));

  if (remainingEntries.length) {
    lines.push('');
    lines.push('--- additional fields ---');
    for (const [key, value] of remainingEntries) {
      lines.push(`${key}: ${String(value).trim()}`);
    }
  }

  return lines.join('\n');
}

export async function sendRawParseMessage(interaction: TrackReplyInteractionLike, data: RunDataRecord, label: string): Promise<void> {
  if (typeof interaction.followUp !== 'function') return;

  const rawText = buildRawParseText(data);
  if (!rawText.trim()) return;

  const fileBuffer = Buffer.from(rawText, 'utf-8');
  await interaction.followUp({
    content: `Raw parse output (${label})`,
    files: [{ attachment: fileBuffer, name: 'parsed-values.txt' }],
    ephemeral: true,
  }).catch(() => {});
}

export async function buildSubmitPayload(userId: string, username: string, data: RunDataRecord, includeType: boolean, includeNotes: boolean) {
  const runData: Record<string, unknown> = applyRunDataAliasGroups(canonicalizeRunDataForOutput(data), TRACK_RUN_SUBMIT_ALIAS_GROUPS);

  runData.tier = runData.tier ?? data.tier ?? data.tierDisplay ?? '1';
  runData.wave = runData.wave ?? data.wave ?? '1';
  runData.totalCoins = runData.totalCoins ?? data.totalCoins ?? data.coins ?? '0';
  runData.totalCells = runData.totalCells ?? data.totalCells ?? data.cells ?? '0';
  runData.totalDice = runData.totalDice ?? data.totalDice ?? data.rerollShards ?? data.dice ?? '0';
  runData.roundDuration = runData.roundDuration ?? data.roundDuration ?? data.duration ?? '0h0m0s';
  runData.killedBy = runData.killedBy ?? data.killedBy ?? 'Apathy';
  runData.date = runData.date ?? data.date ?? formatDate(new Date());
  runData.time = runData.time ?? data.time ?? formatTime(new Date());

  if (includeType) {
    runData.type = ensureType(data.type);
  }

  if (includeNotes) {
    runData.notes = data.notes ?? '';
  }

  return { runData, note: includeNotes ? (data.notes ?? '') : '', userId, username };
}