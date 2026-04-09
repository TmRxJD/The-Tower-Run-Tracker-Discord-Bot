import { parseNumberInput } from '../../../utils/tracker-math';
import { parseBattleReportRunData } from '@tmrxjd/platform/parity';
import {
  TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS,
  TRACK_RUN_INLINE_BATTLE_REPORT_LABELS,
  TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS,
} from '@tmrxjd/platform/tools';

const INLINE_BATTLE_REPORT_LABELS = TRACK_RUN_INLINE_BATTLE_REPORT_LABELS;
const INLINE_SECTION_HEADERS = TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS;
const INLINE_SINGLE_LINE_SECTION_LABELS = TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS;
const LEGACY_SINGLE_LINE_SECTION_HEADERS = ['Battle Report', 'Combat', 'Utility', 'Enemies Destroyed', 'Bots', 'Guardian'] as const;
const LEGACY_SINGLE_LINE_SECTION_LABELS = Object.freeze(
  Object.fromEntries(
    LEGACY_SINGLE_LINE_SECTION_HEADERS.map(section => [section, [...(INLINE_SINGLE_LINE_SECTION_LABELS[section] ?? [])]]),
  ) as Record<(typeof LEGACY_SINGLE_LINE_SECTION_HEADERS)[number], string[]>,
);

function getSingleLineSectionLabels(sectionLabelMap: Readonly<Record<string, string[]>>, section: string): string[] {
  return sectionLabelMap[section] ?? [];
}

function getSafeSingleLineSectionLabels(labels: string[]): string[] {
  return labels.filter(label => {
    const normalizedLabel = label.toLowerCase();
    return !labels.some(otherLabel => {
      if (otherLabel === label) return false;
      return otherLabel.toLowerCase().includes(normalizedLabel);
    });
  });
}

function escapeSingleLinePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
}

function getLegacySingleLineLabels(): string[] {
  return Array.from(new Set(LEGACY_SINGLE_LINE_SECTION_HEADERS.flatMap(section => LEGACY_SINGLE_LINE_SECTION_LABELS[section] ?? [])));
}

export function normalizeInlineBattleReportText(rawText: string): string {
  const canonicalized = (rawText ?? '')
    .toString()
    .replace(/\r/g, '\n')
    .replace(/\\t/g, '\t')
    .trim();

  const text = canonicalized;
  if (!text) return text;
  const hasLineBreaks = /\n/.test(text);

  if (hasLineBreaks) {
    const normalizedLines = text
      .split('\n')
      .map(line => line.replace(/\t+/g, ' ').trim())
      .filter(Boolean);

    const sortedLabels = [...INLINE_BATTLE_REPORT_LABELS].sort((a, b) => b.length - a.length);
    const tabbedLines = normalizedLines.map(line => {
      for (const label of sortedLabels) {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const pattern = new RegExp(`^(${escaped})(?:\\s*[:|-]\\s*|\\s+)(.+)$`, 'i');
        const match = line.match(pattern);
        if (match) {
          const matchedLabel = match[1]?.trim() ?? label;
          const value = match[2]?.trim() ?? '';
          if (!value) return matchedLabel;
          return `${matchedLabel}\t${value}`;
        }
      }
      return line;
    });

    return tabbedLines.join('\n');
  }

  let segmented = text.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim();
  const updatedSingleLineSignal = /\b(Records|Bonus Health Gained|Health Regenerated|Damage Blocked|Killed With Effect Active|Currencies|Enemies Destroyed By)\b/i;
  const useLegacySingleLineMode = !updatedSingleLineSignal.test(segmented);
  const activeSectionHeaders = useLegacySingleLineMode ? [...LEGACY_SINGLE_LINE_SECTION_HEADERS] : [...INLINE_SECTION_HEADERS];
  const sortedSectionHeaders = [...activeSectionHeaders].sort((a, b) => b.length - a.length);
  const activeSectionLabels = useLegacySingleLineMode ? getLegacySingleLineLabels() : [...INLINE_BATTLE_REPORT_LABELS];
  const activeSectionLabelMap = useLegacySingleLineMode ? LEGACY_SINGLE_LINE_SECTION_LABELS : INLINE_SINGLE_LINE_SECTION_LABELS;

  if (useLegacySingleLineMode) {
    const safeGlobalLabels = activeSectionLabels.filter(label => label.includes(' ') || label === 'Tier' || label === 'Wave');
    const globalLabelAlternation = safeGlobalLabels
      .sort((a, b) => b.length - a.length)
      .map(escapeSingleLinePattern)
      .join('|');
    const sectionAlternation = sortedSectionHeaders
      .map(escapeSingleLinePattern)
      .join('|');

    if (globalLabelAlternation) {
      const globalSplitPattern = new RegExp(`\\s+(${globalLabelAlternation})(?=\\s|:|$)`, 'gi');
      segmented = segmented.replace(globalSplitPattern, '\n$1');
    }

    if (sectionAlternation) {
      const sectionSplitPattern = new RegExp(`\\s+(${sectionAlternation})(?=\\s|:|$)`, 'gi');
      segmented = segmented.replace(sectionSplitPattern, '\n$1');
    }
  } else {
    for (const sectionHeader of sortedSectionHeaders) {
      const sectionLabels = getSingleLineSectionLabels(activeSectionLabelMap as Readonly<Record<string, string[]>>, sectionHeader)
      if (sectionLabels.length === 0) continue

      const labelAlternation = [...sectionLabels]
        .sort((a, b) => b.length - a.length)
        .map(escapeSingleLinePattern)
        .join('|')
      if (!labelAlternation) continue

      const escapedHeader = escapeSingleLinePattern(sectionHeader)
      const sectionSplitPattern = new RegExp(`\\s+(${escapedHeader})(?=\\s+(?:${labelAlternation})(?=\\s|:|$))`, 'gi')
      segmented = segmented.replace(sectionSplitPattern, '\n$1')
    }
  }

  const rawLines = segmented
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (rawLines.length === 0) return text;

  const lines: string[] = [];
  let currentSection = 'Battle Report';

  for (const rawLine of rawLines) {
    const sectionHeader = sortedSectionHeaders.find(header => rawLine.toLowerCase().startsWith(header.toLowerCase()));
    let remainder = rawLine;

    if (sectionHeader) {
      currentSection = sectionHeader;
      lines.push(sectionHeader);
      remainder = rawLine.slice(sectionHeader.length).trim();
    }

    if (!remainder) continue;

    const sectionLabels = getSingleLineSectionLabels(activeSectionLabelMap as Readonly<Record<string, string[]>>, currentSection);
    const splitLabels = useLegacySingleLineMode ? getSafeSingleLineSectionLabels(sectionLabels) : sectionLabels;
    const labelAlternation = splitLabels
      .sort((a: string, b: string) => b.length - a.length)
      .map((label: string) => escapeSingleLinePattern(label))
      .join('|');

    if (!labelAlternation) {
      lines.push(remainder);
      continue;
    }

    const splitPattern = new RegExp(`\\s+(${labelAlternation})(?=\\s|:|$)`, 'gi');
    const splitRemainder = remainder.replace(splitPattern, '\n$1');
    lines.push(...splitRemainder.split('\n').map(line => line.trim()).filter(Boolean));
  }

  const sortedLabels = [...INLINE_BATTLE_REPORT_LABELS].sort((a, b) => b.length - a.length);
  const tabbedLines = lines.map(line => {
    for (const label of sortedLabels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const pattern = new RegExp(`^(${escaped})\\s+(.+)$`, 'i');
      const match = line.match(pattern);
      if (match) {
        const matchedLabel = match[1]?.trim() ?? label;
        const value = match[2]?.trim() ?? '';
        if (!value) return matchedLabel;
        return `${matchedLabel}\t${value}`;
      }
    }
    return line;
  });

  return tabbedLines.join('\n');
}

const languageDecimalMap: Record<string, string> = {
  English: '.',
  German: ',',
  French: ',',
  Spanish: ',',
  Italian: ',',
  Portuguese: ',',
  Russian: ',',
};

export function getDecimalForLanguage(language: string): string {
  return languageDecimalMap[language] || '.';
}

export async function extractDateTimeFromImage(attachment: { name?: string; filename?: string } | null | undefined) {
  const now = new Date();
  const result = { date: formatDate(now), time: formatTime(now), timestamp: now };

  if (!attachment) return result;

  const filename = attachment.name || attachment.filename || '';
  if (filename) {
    const screenshotPattern = /Screenshot_(\d{8})_(\d{6}).*\.(jpg|jpeg|png)/i;
    const screenshotMatch = filename.match(screenshotPattern);
    if (screenshotMatch) {
      const dateStr = screenshotMatch[1];
      const timeStr = screenshotMatch[2];
      const year = parseInt(dateStr.substring(0, 4), 10);
      const month = parseInt(dateStr.substring(4, 6), 10);
      const day = parseInt(dateStr.substring(6, 8), 10);
      const hours = parseInt(timeStr.substring(0, 2), 10);
      const minutes = parseInt(timeStr.substring(2, 4), 10);
      const seconds = parseInt(timeStr.substring(4, 6), 10);
      const extractedDate = new Date(year, month - 1, day, hours, minutes, seconds);
      if (!Number.isNaN(extractedDate.getTime())) {
        return { date: formatDate(extractedDate), time: formatTime(extractedDate), timestamp: extractedDate };
      }
    }

    const datePatterns = [
      /(\d{4})[-_.](\d{2})[-_.](\d{2})/,
      /(\d{2})[-_.](\d{2})[-_.](\d{4})/,
      /(\d{2})[-_.](\d{2})[-_.](\d{2})/,
    ];

    for (const pattern of datePatterns) {
      const match = filename.match(pattern);
      if (match) {
        let year: string | number;
        let month: string | number;
        let day: string | number;
        if (match[1].length === 4) {
          year = match[1];
          month = match[2];
          day = match[3];
        } else {
          month = match[1];
          day = match[2];
          year = match[3].length === 2 ? `20${match[3]}` : match[3];
        }
        const extractedDate = new Date(parseInt(String(year), 10), parseInt(String(month), 10) - 1, parseInt(String(day), 10));
        if (!Number.isNaN(extractedDate.getTime())) {
          result.date = formatDate(extractedDate);
          result.timestamp = extractedDate;
          break;
        }
      }
    }

    const timePattern = /(\d{1,2})[:-](\d{2})(?:[:-](\d{2}))?(?:\s*(am|pm))?/i;
    const timeMatch = filename.match(timePattern);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      if (timeMatch[4]) {
        const isPM = timeMatch[4].toLowerCase() === 'pm';
        if (isPM && hours < 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;
      }
      const extractedTime = new Date(result.timestamp);
      extractedTime.setHours(hours, minutes, seconds);
      if (!Number.isNaN(extractedTime.getTime())) {
        result.time = formatTime(extractedTime);
        result.timestamp = extractedTime;
      }
    }
  }

  return result;
}

export function formatDate(dateObj: Date | string | number | null | undefined): string {
  if (!dateObj) return 'Unknown Date';
  const date = dateObj instanceof Date ? dateObj : new Date(dateObj);
  if (Number.isNaN(date.getTime())) return 'Unknown Date';
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear().toString().slice(-2)}`;
}

export function formatTime(time: Date | string | number | null | undefined): string {
  const date = time instanceof Date ? time : new Date(time ?? Date.now());
  if (Number.isNaN(date.getTime())) return '00:00:00';
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function trimDisplayTimeSeconds(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
}

export function parseBattleDateTime(rawDate: unknown): Date | null {
  if (!rawDate) return null;
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) return rawDate;

  let cleaned = String(rawDate)
    .replace(/@/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  cleaned = cleaned.replace(/(\d{1,2})(st|nd|rd|th)/gi, '$1');

  const candidates = new Set<string>();
  candidates.add(cleaned);

  if (!/\d+:\d+/.test(cleaned)) {
    const colonCandidate = cleaned.replace(/(\d{1,2})\s+(\d{2})(\s*[ap]m)?$/i, (_, h, m, suffix = '') => {
      const meridian = suffix ? suffix.trim().toUpperCase() : '';
      return `${h}:${m}${meridian ? ` ${meridian}` : ''}`;
    });
    candidates.add(colonCandidate.trim());
  }

  const hmCandidate = cleaned.replace(/(\d{1,2})h\s*(\d{1,2})(?:m)?/gi, '$1:$2');
  candidates.add(hmCandidate.trim());

  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function similarity(a: string, b: string) {
  const aNorm = a.toLowerCase();
  const bNorm = b.toLowerCase();
  let matches = 0;
  for (let i = 0; i < Math.min(aNorm.length, bNorm.length); i += 1) {
    if (aNorm[i] === bNorm[i]) matches += 1;
  }
  return matches / Math.max(aNorm.length, bNorm.length);
}

function getFieldExactOrFuzzy(lines: string[], fieldKeys: string[]) {
  const normalizedKeys = fieldKeys.map(k => k.replace(/\s+/g, '').toLowerCase());
  for (const line of lines) {
    const normalizedLine = line.replace(/\s+/g, '').toLowerCase();
    for (const key of normalizedKeys) {
      if (normalizedLine.startsWith(key)) {
        const valuePart = line.slice(line.toLowerCase().indexOf(key) + key.length).trim();
        const match = valuePart.match(/(\d[\d.,]*\s*\+|\d[\d.,]*)([a-zA-Z]*)/);
        if (match) {
          const numericPortion = match[1] ? match[1].replace(/\s+/g, '') : '';
          const suffix = match[2] || '';
          return numericPortion + suffix;
        }
      }
      if (normalizedLine.includes(key)) {
        const match = line.match(/(\d[\d.,]*\s*\+|\d[\d.,]*)([a-zA-Z]*)/);
        if (match) {
          const numericPortion = match[1] ? match[1].replace(/\s+/g, '') : '';
          const suffix = match[2] || '';
          return numericPortion + suffix;
        }
      }
    }
  }

  let bestMatch: { line: string; key: string; score: number } = { line: '', key: '', score: 0 };
  for (const line of lines) {
    for (const key of normalizedKeys) {
      const score = similarity(line.replace(/\s+/g, '').toLowerCase(), key);
      if (score > bestMatch.score) {
        bestMatch = { line, key, score };
      }
    }
  }
  if (bestMatch.score > 0.8) {
    const match = bestMatch.line.match(/(\d[\d.,]*\s*\+|\d[\d.,]*)([a-zA-Z]*)/);
    if (match) {
      const numericPortion = match[1] ? match[1].replace(/\s+/g, '') : '';
      const suffix = match[2] || '';
      return numericPortion + suffix;
    }
  }
  return null;
}

export function formatDuration(durationString: string | null | undefined): string {
  if (!durationString || typeof durationString !== 'string') return '0h0m0s';
  const normalized = durationString.toLowerCase().replace(/\s+/g, '');
  const hoursMatch = normalized.match(/(\d+)h/);
  const minutesMatch = normalized.match(/(\d+)m/);
  const secondsMatch = normalized.match(/(\d+)s/);
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  const seconds = secondsMatch ? parseInt(secondsMatch[1], 10) : 0;
  if (hours === 0 && minutes === 0 && seconds === 0) return '0h0m0s';
  return `${hours}h${minutes}m${seconds}s`;
}

type RunLike = Record<string, unknown>;

export function findPotentialDuplicateRun(extractedData: RunLike | null | undefined, existingRuns: RunLike[] | null | undefined) {
  if (!extractedData || !existingRuns || existingRuns.length === 0) {
    return {
      isDuplicate: false,
      duplicateRunId: null as string | null,
      duplicateLocalId: null as string | null,
    };
  }

  const currentTier = extractedData.tier;
  const currentWave = extractedData.wave;
  const currentDuration = formatDuration(String(extractedData.duration || extractedData.roundDuration || ''));
  const currentCoins = extractedData.totalCoins || extractedData.coins || 0;

  for (const existingRun of existingRuns) {
    const existingRunId = String(existingRun.runId || existingRun.id || '');
    const existingLocalId = String(existingRun.localId || '');
    const existingTier = existingRun.tier;
    const existingWave = existingRun.wave;
    const existingDuration = formatDuration(String(existingRun.duration || existingRun.roundDuration || ''));
    const existingCoins = existingRun.totalCoins || existingRun.coins || 0;

    const tierMatch = currentTier == existingTier;
    const waveMatch = currentWave == existingWave;
    const durationMatch = currentDuration === existingDuration;
    const coinMatch = currentCoins == existingCoins;

    if ((existingRunId || existingLocalId) && tierMatch && waveMatch && durationMatch && coinMatch) {
      return {
        isDuplicate: true,
        duplicateRunId: existingRunId || null,
        duplicateLocalId: existingLocalId || null,
      };
    }
  }

  return {
    isDuplicate: false,
    duplicateRunId: null,
    duplicateLocalId: null,
  };
}

export function generateCoverageDescription(runData: RunLike | null | undefined): string {
  if (!runData) return '';
  const totalEnemies = parseNumberInput(String(runData['Total Enemies'] ?? runData.totalEnemies ?? 0));
  const hasValidTotalEnemies = Number.isFinite(totalEnemies) && totalEnemies > 0;
  if (!hasValidTotalEnemies) return '';

  const getVal = (key: unknown) => parseNumberInput(String(key ?? 0));
  const killsWithGoldenTower = getVal(runData['Golden Tower'] ?? runData.killsWithGoldenTower);
  const enemiesHitByBlackHole = getVal(
    runData['Enemies Hit By Black Hole'] ??
      runData.enemiesHitByBlackHole,
  );
  const enemiesHitByOrbs = getVal(
    runData['Enemies Hit by Orbs'] ??
      runData.enemiesHitByOrbs,
  );
  const taggedByDeathWave = getVal(runData['Tagged by Death Wave'] ?? runData.taggedByDeathWave);
  const destroyedInSpotlight = getVal(runData['Destroyed in Spotlight'] ?? runData.destroyedInSpotlight);
  const destroyedInGoldenBot = getVal(runData['Destroyed in Golden Bot'] ?? runData.destroyedInGoldenBot);
  const killsWithAmplifyBot = getVal(runData['Amplify Bot'] ?? runData.killsWithAmplifyBot);
  const summonedEnemies = getVal(
    runData['Summoned enemies'] ??
      runData.guardianSummonedEnemies,
  );

  const toPct = (val: number) => {
    if (!Number.isFinite(val) || val <= 0) return null;
    const pct = Math.min(100, Math.round((val / totalEnemies) * 100));
    return pct;
  };

  const toBar = (pct: number, filledChar: string) => {
    const segments = 10;
    const filled = Math.max(0, Math.min(segments, Math.round(pct / 10)));
    const empty = segments - filled;
    return `${filledChar.repeat(filled)}${'⬛'.repeat(empty)}`;
  };

  const metrics = [
    { label: 'Golden Tower', value: toPct(killsWithGoldenTower), block: '🟨' },
    { label: 'Black Hole', value: toPct(enemiesHitByBlackHole), block: '🟪' },
    { label: 'Spotlight', value: toPct(destroyedInSpotlight), block: '⬜' },
    { label: 'Death Wave', value: toPct(taggedByDeathWave), block: '🟥' },
    { label: 'Orbs', value: toPct(enemiesHitByOrbs), block: '🟪' },
    { label: 'Golden Bot', value: toPct(destroyedInGoldenBot), block: '🟨' },
    { label: 'Amp Bot', value: toPct(killsWithAmplifyBot), block: '🟦' },
    { label: 'Summoned', value: toPct(summonedEnemies), block: '🟪' },
  ].filter((metric): metric is { label: string; value: number; block: string } => typeof metric.value === 'number');

  if (!metrics.length) return '';
  return metrics
    .map((metric) => `${metric.label}: ${metric.value}%\n${toBar(metric.value, metric.block)}`)
    .join('\n');
}

const ocrFieldTranslations: Record<string, Record<string, string>> = {
  English: {
    coins: 'Coins earned',
    cells: 'Cells Earned',
    dice: 'Reroll Shards Earned',
    duration: 'Real Time',
    killedBy: 'Killed By',
    tier: 'Tier',
    wave: 'Wave',
  },
  German: {
    coins: 'Verdiente Münzen',
    cells: 'Verdiente Zellen',
    dice: 'Erhaltene Zufallsscherben',
    duration: 'Echtzeit',
    killedBy: 'Getötet Von',
    tier: 'Stufe',
    wave: 'Welle',
  },
  French: {
    coins: 'Pièces Obtenues',
    cells: 'Composants Obtenus',
    dice: 'Fragments De Relance Obtenus',
    duration: 'Temps Réel',
    killedBy: 'Tué Par',
    tier: 'Difficulté',
    wave: 'Vague',
  },
  Spanish: {
    coins: 'Monedas Ganadas',
    cells: 'Baterias Ganadas',
    dice: 'Cambiar Equirlas Conseguidas Al Azar',
    duration: 'Tiempo Real',
    killedBy: 'Muerto Por',
    tier: 'Nivel',
    wave: 'Oleada',
  },
  Italian: {
    coins: 'Gettoni Guadagnate',
    cells: 'Cell Guadagnate',
    dice: 'Fragmenti Di Cambio Guadagnati',
    duration: 'Tempo Effettivo',
    killedBy: 'Ucciso Da',
    tier: 'Grado',
    wave: 'Ondata',
  },
  Portuguese: {
    coins: 'Moedas Ganhas',
    cells: 'Células Ganhas',
    dice: 'Fragmentos De Variacão Obtidos',
    duration: 'Tempo Real',
    killedBy: 'Mortos Por',
    tier: 'Grau',
    wave: 'Onda',
  },
  Russian: {
    coins: 'Заработанные Монеты',
    cells: 'Заработанные Ячейки',
    dice: 'Полученные Кубики Переката',
    duration: 'Реальное Время',
    killedBy: 'Убит',
    tier: 'ypoBeHb',
    wave: 'Волна',
  },
};

function getTierAndWave(lines: string[]) {
  let tier: number | 'Unknown' = 'Unknown';
  let wave: number | 'Unknown' = 'Unknown';
  let tierRaw: string | null = null;

  for (const line of lines) {
    const tierMatch = line.match(/Tier\s*[:|-]?\s*(\d+)(\s*\+)?/i);
    if (tierMatch) {
      tier = parseInt(tierMatch[1], 10);
      tierRaw = tierMatch[2] ? `${tierMatch[1]}+` : tierMatch[1];
    }
    const waveMatch = line.match(/Wave\s*[:|-]?\s*(\d+)/i);
    if (waveMatch) {
      wave = parseInt(waveMatch[1], 10);
    }
  }

  return { tier, wave, tierRaw };
}

function normalizeDecimalSeparator(value: string) {
  return value.replace(/,/g, '.');
}

function fixOCRMisreads(text: string): string | number {
  if (!text || typeof text !== 'string') return '0';
  const regex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)([KMBTSqQsS]*)/;
  const match = text.match(regex);
  if (!match) return text;
  let numberPart = match[1];
  let notationPart = match[2];
  if (parseFloat(numberPart) === 0) notationPart = '';
  numberPart = numberPart
    .replace(/O/g, '0')
    .replace(/B/g, '8')
    .replace(/S/g, '5')
    .replace(/I/g, '1')
    .replace(/l/g, '1')
    .replace(/Z/g, '2')
    .replace(/G/g, '6')
    .replace(/[^0-9.]/g, '');
  if (notationPart) return numberPart + notationPart;
  return parseInt(numberPart, 10);
}

export function parseTierString(rawTier: unknown): { numeric: number | null; hasPlus: boolean; display: string | null } {
  if (rawTier === null || rawTier === undefined) return { numeric: null, hasPlus: false, display: null };
  const str = String(rawTier).trim();
  if (!str) return { numeric: null, hasPlus: false, display: null };
  const normalizeDigits = (value: string) => {
    const cleaned = value.replace(/[^0-9]/g, '');
    return cleaned ? parseInt(cleaned, 10) : null;
  };
  const plusMatch = str.match(/(\d[\d.,]*)\s*\+/);
  if (plusMatch) {
    const numeric = normalizeDigits(plusMatch[1]);
    if (numeric !== null && !Number.isNaN(numeric)) return { numeric, hasPlus: true, display: `${numeric}+` };
  }
  const numberMatch = str.match(/(\d[\d.,]*)/);
  if (numberMatch) {
    const numeric = normalizeDigits(numberMatch[1]);
    if (numeric !== null && !Number.isNaN(numeric)) return { numeric, hasPlus: false, display: String(numeric) };
  }
  return { numeric: null, hasPlus: false, display: null };
}

type TierCarrier = Record<string, unknown> & {
  tier?: unknown;
  tierDisplay?: unknown;
  tierHasPlus?: unknown;
};

export function applyTierMetadata(target: TierCarrier, rawTierCandidates: unknown[] = []) {
  if (!target || typeof target !== 'object') return target;

  const candidates: unknown[] = [];
  if (target.tierDisplay) candidates.push(target.tierDisplay);
  if (target.tier !== undefined && target.tier !== null) candidates.push(target.tier);

  const extras = Array.isArray(rawTierCandidates) ? rawTierCandidates : [rawTierCandidates];
  for (const value of extras) {
    if (value !== undefined && value !== null && value !== '') {
      candidates.push(value);
    }
  }

  let bestInfo: { numeric: number | null; hasPlus: boolean; display: string | null } | null = null;

  if (target.tierHasPlus && (target.tierDisplay || target.tier !== undefined)) {
    const existingInfo = parseTierString(target.tierDisplay || target.tier);
    if (existingInfo.numeric !== null && !Number.isNaN(existingInfo.numeric)) {
      bestInfo = { ...existingInfo, hasPlus: true };
    }
  }

  for (const candidate of candidates) {
    const info = parseTierString(candidate);
    if (info.numeric === null || Number.isNaN(info.numeric)) continue;
    if (!bestInfo || (info.hasPlus && !bestInfo.hasPlus)) {
      bestInfo = info;
    }
  }

  if (bestInfo && bestInfo.numeric !== null && !Number.isNaN(bestInfo.numeric)) {
    target.tier = bestInfo.numeric;
    target.tierDisplay = bestInfo.display || String(bestInfo.numeric);
    target.tierHasPlus = bestInfo.hasPlus;
  } else {
    if (typeof target.tier === 'number' && !Number.isNaN(target.tier)) {
      target.tierDisplay = target.tierDisplay || String(target.tier);
    }
    target.tierHasPlus = !!target.tierHasPlus;
  }

  return target;
}

export function hasPlusTier(target: TierCarrier, rawTierCandidates: unknown[] = []) {
  if (!target || typeof target !== 'object') return false;
  applyTierMetadata(target, rawTierCandidates);
  if (target.tierHasPlus) return true;
  const info = parseTierString(target.tierDisplay ?? target.tier);
  return info.hasPlus;
}

export function formatOCRExtraction(
  gutenyeResult: unknown,
  dateTimeInfo: unknown,
  notes: string,
  decimalIndicator = '.',
  scanLanguage = 'English',
) {
  let lines: string[];
  if (Array.isArray(gutenyeResult) && typeof gutenyeResult[0] === 'string') {
    lines = gutenyeResult as string[];
  } else if (
    Array.isArray(gutenyeResult) &&
    typeof gutenyeResult[0] === 'object' &&
    gutenyeResult[0] !== null &&
    'text' in (gutenyeResult[0] as Record<string, unknown>)
  ) {
    lines = (gutenyeResult as Array<Record<string, unknown>>).map(item => String(item.text ?? ''));
  } else {
    lines = [];
  }

  const normalizeDecimal = (text: string) => {
    const value = typeof text === 'string' ? text : String(text);
    if (decimalIndicator === ',') return value.replace(/,/g, '.');
    return value;
  };

  const fuzzyContains = (line: string, expected: string) => line.toLowerCase().replace(/[^a-z0-9]/g, '').includes(expected.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const getField = (allLines: string[], expectedField: string) => {
    for (const line of allLines) {
      if (fuzzyContains(line, expectedField)) {
        const regex = /(\d+[\.,]?\d*)([a-zA-Z]*)/;
        const match = line.match(regex);
        if (match) return (match[1] || '') + (match[2] || '');
        if (line.includes('Killed By')) return line.replace('Killed By', '').trim();
      }
    }
    return '';
  };

  const processField = (rawValue: string) => {
    if (!rawValue || !rawValue.trim()) return '';
    const fixed = fixOCRMisreads(normalizeDecimal(rawValue));
    if (typeof fixed === 'string' && /[KMBTSqQsS]/.test(fixed)) return fixed;
    return parseInt(String(fixed), 10);
  };

  const fields = ocrFieldTranslations[scanLanguage] || ocrFieldTranslations.English;
  const allTranslations = (field: string) => Object.values(ocrFieldTranslations).map(f => f[field]).filter(Boolean);

  const tierWave = getTierAndWave(lines);
  let tier: number | 'Unknown' = tierWave.tier;
  let wave: number | 'Unknown' = tierWave.wave;
  let tierDisplay: string | null = tierWave.tierRaw || (typeof tier === 'number' && !Number.isNaN(tier) ? String(tier) : null);
  let tierHasPlus = tierDisplay ? tierDisplay.includes('+') : false;

  const totalCoins = processField(getFieldExactOrFuzzy(lines, allTranslations('coins')) || getField(lines, fields.coins));
  const totalCells = processField(getFieldExactOrFuzzy(lines, allTranslations('cells')) || getField(lines, fields.cells));
  const totalDice = processField(getFieldExactOrFuzzy(lines, allTranslations('dice')) || getField(lines, fields.dice));

  let roundDuration = '';
  for (const line of lines) {
    for (const durationKey of allTranslations('duration')) {
      const normalizedKey = durationKey.replace(/\s+/g, '').toLowerCase();
      const normalizedLine = line.replace(/\s+/g, '').toLowerCase();
      if (normalizedLine.startsWith(normalizedKey) || normalizedLine.includes(normalizedKey)) {
        const valuePart = line.slice(line.toLowerCase().indexOf(durationKey.toLowerCase()) + durationKey.length).trim();
        const durationMatch = valuePart.match(/(\d+d)?\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
        if (durationMatch && (durationMatch[1] || durationMatch[2] || durationMatch[3] || durationMatch[4])) {
          const days = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
          const hours = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
          const minutes = durationMatch[3] ? parseInt(durationMatch[3], 10) : 0;
          const seconds = durationMatch[4] ? parseInt(durationMatch[4], 10) : 0;
          const totalHours = hours + days * 24;
          roundDuration = `${totalHours}h${minutes}m${seconds}s`;
          roundDuration = formatDuration(roundDuration);
        } else {
          const fallbackMatch = line.match(/(\d+d)?\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
          if (fallbackMatch && (fallbackMatch[1] || fallbackMatch[2] || fallbackMatch[3] || fallbackMatch[4])) {
            const days = fallbackMatch[1] ? parseInt(fallbackMatch[1], 10) : 0;
            const hours = fallbackMatch[2] ? parseInt(fallbackMatch[2], 10) : 0;
            const minutes = fallbackMatch[3] ? parseInt(fallbackMatch[3], 10) : 0;
            const seconds = fallbackMatch[4] ? parseInt(fallbackMatch[4], 10) : 0;
            const totalHours = hours + days * 24;
            roundDuration = `${totalHours}h${minutes}m${seconds}s`;
            roundDuration = formatDuration(roundDuration);
          }
        }
        break;
      }
    }
  }
  let killedByRaw: string | null = null;
  for (const line of lines) {
    for (const killedByKey of allTranslations('killedBy')) {
      if (line.trim().toLowerCase() === killedByKey.trim().toLowerCase() || line.toLowerCase().includes(killedByKey.toLowerCase())) {
        const match = line.match(/(?:Killed By|Getötet Von|Tué Par|Muerto Por|Ucciso Da|Mortos Por|Убит)\s*(.*)/i);
        if (match && match[1]) {
          killedByRaw = match[1].trim();
        } else {
          killedByRaw = line.split(/\s+/).slice(-1)[0];
        }
      }
    }
  }
  const killedBy = killedByRaw && killedByRaw !== 'Unknown' ? killedByRaw : 'Apathy';

  const fuzzyTier = getFieldExactOrFuzzy(lines, allTranslations('tier'));
  const tierCandidates = [tierWave.tierRaw, fuzzyTier, tier];
  for (const candidate of tierCandidates) {
    const { numeric, hasPlus, display } = parseTierString(candidate);
    if (numeric !== null && !Number.isNaN(numeric)) {
      const tierUnset =
        typeof tier !== 'number' ||
        Number.isNaN(tier) ||
        tier <= 0 ||
        (typeof tier === 'string' && tier === 'Unknown');
      if (tierUnset) tier = numeric;
      if (!tierDisplay || hasPlus) tierDisplay = display;
      if (hasPlus) {
        tierHasPlus = true;
        break;
      }
    }
  }

  if (!tierDisplay && typeof tier === 'number' && !Number.isNaN(tier)) tierDisplay = String(tier);

  const fuzzyWave = getFieldExactOrFuzzy(lines, allTranslations('wave'));
  if ((wave === 'Unknown' || wave === 0) && fuzzyWave && fuzzyWave !== '0' && fuzzyWave !== 'Unknown') {
    wave = parseInt(fuzzyWave, 10);
  }

  let date: string;
  let time: string;
  if (
    dateTimeInfo &&
    typeof dateTimeInfo === 'object' &&
    'date' in dateTimeInfo &&
    'time' in dateTimeInfo
  ) {
    const dt = dateTimeInfo as { date?: unknown; time?: unknown };
    date = String(dt.date ?? formatDate(new Date()));
    time = String(dt.time ?? formatTime(new Date()));
  } else {
    const now = new Date();
    date = formatDate(now);
    time = formatTime(now);
  }

  return {
    tier,
    wave,
    totalCoins,
    totalCells,
    totalDice,
    roundDuration,
    killedBy,
    date,
    time,
    notes,
    tierDisplay,
    tierHasPlus,
    totalEnemies: null,
    destroyedByOrbs: null,
    taggedByDeathWave: null,
    destroyedInSpotlight: null,
    destroyedInGoldenBot: null,
  };
}

export function parseRunDataFromText(rawText: string) {
  const originalText = (rawText ?? '').toString().replace(/\r/g, '').trim();
  const normalizedText = normalizeInlineBattleReportText(originalText).replace(/\r/g, '').trim();
  const parseCandidates = [normalizedText, originalText].filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);

  let canonical: ReturnType<typeof parseBattleReportRunData> = null;
  for (const candidate of parseCandidates) {
    canonical = parseBattleReportRunData(candidate);
    if (canonical) break;
  }
  if (!canonical) {
    throw new Error('Parsed run data is incomplete.');
  }

  const tierInfo = parseTierString(canonical.tier);
  const tier = tierInfo.numeric !== null ? tierInfo.numeric : 'Unknown';
  const wave = canonical.wave ? parseInt(canonical.wave, 10) : 'Unknown';
  const roundDuration = formatDuration(canonical.roundDuration || canonical.duration);
  const totalCoins = canonical.totalCoins;
  const totalCells = canonical.totalCells;
  const totalDice = canonical.totalDice;
  const killedBy = (canonical.killedBy || '').trim() || 'Apathy';

  if (
    tier === 'Unknown'
    || wave === 'Unknown'
    || !roundDuration
    || !totalCoins
    || !totalCells
    || !totalDice
  ) {
    throw new Error('Parsed run data is incomplete.');
  }

  const resolvedTimestamp = canonical.dateIso && canonical.time24h
    ? new Date(`${canonical.dateIso}T${canonical.time24h}`)
    : null;

  if (!resolvedTimestamp || Number.isNaN(resolvedTimestamp.getTime())) {
    throw new Error('Parsed run data is incomplete.');
  }

  return {
    ...canonical,
    tier,
    wave,
    roundDuration,
    totalCoins,
    totalCells,
    totalDice,
    killedBy,
    date: formatDate(resolvedTimestamp),
    time: formatTime(resolvedTimestamp),
    reportTimestamp: resolvedTimestamp.toISOString(),
    notes: '',
    tierDisplay: tierInfo.display || String(tier),
    tierHasPlus: tierInfo.hasPlus,
  };
}
