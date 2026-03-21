import { formatDate, formatTime } from './upload-helpers';
import { ensureType } from './review-interaction-helpers';
import type { TrackReplyInteractionLike } from '../interaction-types';
import { canonicalizeRunDataForOutput, canonicalizeTrackerRunData } from '../shared/run-data-normalization';
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
  const canonical = canonicalizeTrackerRunData(canonicalizeRunDataForOutput(data));
  const runData: Record<string, unknown> = {
    ...canonical,
    tier: canonical.tier ?? '1',
    wave: canonical.wave ?? '1',
    totalCoins: canonical.totalCoins ?? '0',
    totalCells: canonical.totalCells ?? '0',
    totalDice: canonical.totalDice ?? '0',
    roundDuration: canonical.roundDuration ?? '0h0m0s',
    killedBy: canonical.killedBy ?? 'Apathy',
    date: canonical.date ?? formatDate(new Date()),
    time: canonical.time ?? formatTime(new Date()),
  };

  if (includeType) {
    runData.type = ensureType(canonical.type);
  }

  if (includeNotes) {
    runData.notes = canonical.notes ?? '';
  }

  return { runData, note: includeNotes ? (canonical.notes ?? '') : '', userId, username };
}