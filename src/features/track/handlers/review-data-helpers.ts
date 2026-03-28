import { formatDate, formatTime } from './upload-helpers';
import {
  canonicalizeRunDataForOutput,
  canonicalizeTrackerRunData,
  TRACK_RUN_BATTLE_REPORT_FIELDS,
  TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS,
} from '@tmrxjd/platform/tools';
import { ensureType } from './review-interaction-helpers';
import type { TrackReplyInteractionLike } from '../interaction-types';
import type { RunDataRecord } from '../shared/track-review-records';

function readScannedBattleReportValue(data: RunDataRecord, normalizedData: Record<string, unknown>, key: string): string | null {
  const valuesRecord = data.values && typeof data.values === 'object'
    ? data.values as Record<string, unknown>
    : null;

  const value = valuesRecord?.[key] ?? normalizedData[key];
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function buildRawParseText(data: RunDataRecord): string {
  const normalizedData = canonicalizeRunDataForOutput(data);
  const lines: string[] = [];

  for (const section of TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS) {
    const sectionLines = TRACK_RUN_BATTLE_REPORT_FIELDS
      .filter(field => field.section === section)
      .map((field) => {
        const text = readScannedBattleReportValue(data, normalizedData, field.key);
        return text ? `${field.label}\t${text}` : null;
      })
      .filter((line): line is string => Boolean(line));

    if (sectionLines.length > 0) {
      lines.push(section);
      lines.push(...sectionLines);
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