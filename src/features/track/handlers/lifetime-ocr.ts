type LifetimeEntryData = {
  date: string;
  gameStarted: string;
  coinsEarned: string;
  recentCoinsPerHour: string;
  cashEarned: string;
  stonesEarned: string;
  keysEarned: string;
  cellsEarned: string;
  rerollShardsEarned: string;
  damageDealt: string;
  enemiesDestroyed: string;
  wavesCompleted: string;
  upgradesBought: string;
  workshopUpgrades: string;
  workshopCoinsSpent: string;
  researchCompleted: string;
  labCoinsSpent: string;
  freeUpgrades: string;
  interestEarned: string;
  orbKills: string;
  deathRayKills: string;
  thornDamage: string;
  wavesSkipped: string;
};

const LABEL_MAP: Array<[RegExp, keyof LifetimeEntryData]> = [
  [/game\s*started|games?started|gamestarted|games? played|total games/i, 'gameStarted'],
  [/coins?\s*earned|coinsearned|total coins/i, 'coinsEarned'],
  [/cash\s*earned|cashearned|money earned|total cash/i, 'cashEarned'],
  [/stones?\s*earned|stonesearned|total stones/i, 'stonesEarned'],
  [/keys?\s*earned|keysearned|total keys/i, 'keysEarned'],
  [/cells?\s*earned|cellsearned|total cells/i, 'cellsEarned'],
  [/reroll\s*shards?\s*earned|rerollshards|reroll shards/i, 'rerollShardsEarned'],
  [/recent\s*coins?\s*per\s*hour|recentcoinsperhour|coins\s*per\s*hour/i, 'recentCoinsPerHour'],
  [/damage\s*dealt|damagedealt|total damage/i, 'damageDealt'],
  [/enemies?\s*destroyed|enemiesdestroyed|total enemies/i, 'enemiesDestroyed'],
  [/waves?\s*completed|wavescompleted|total waves/i, 'wavesCompleted'],
  [/upgrades?\s*bought|upgradesbought|total upgrades/i, 'upgradesBought'],
  [/workshop\s*upgrades|workshopupgrades|workshop research/i, 'workshopUpgrades'],
  [/workshop\s*coins?\s*spent|workshopcoinsspent|workshop cost/i, 'workshopCoinsSpent'],
  [/research\s*completed|researchcompleted|research/i, 'researchCompleted'],
  [/lab\s*coins?\s*spent|labcoinsspent|lab cost/i, 'labCoinsSpent'],
  [/free\s*upgrades|freeupgrades|bonus upgrades/i, 'freeUpgrades'],
  [/interest\s*earned|interestearned|total interest/i, 'interestEarned'],
  [/orb\s*kills|orbkills|orbs destroyed/i, 'orbKills'],
  [/death\s*ray\s*kills|deathraykills|deathray kills/i, 'deathRayKills'],
  [/thorn\s*damage|thorndamage|thorns damage/i, 'thornDamage'],
  [/waves?\s*skipped|wavesskipped|skipped waves/i, 'wavesSkipped'],
];

const VALUE_REGEX = /(\$)?\s*([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)([a-zA-Z]{1,3})?/;

function todayIsoDate() {
  return new Date().toISOString().split('T')[0];
}

function buildDefaultEntry(): LifetimeEntryData {
  return {
    date: todayIsoDate(),
    gameStarted: '',
    coinsEarned: '0',
    recentCoinsPerHour: '0',
    cashEarned: '0',
    stonesEarned: '0',
    keysEarned: '0',
    cellsEarned: '0',
    rerollShardsEarned: '0',
    damageDealt: '0',
    enemiesDestroyed: '0',
    wavesCompleted: '0',
    upgradesBought: '0',
    workshopUpgrades: '0',
    workshopCoinsSpent: '0',
    researchCompleted: '0',
    labCoinsSpent: '0',
    freeUpgrades: '0',
    interestEarned: '0',
    orbKills: '0',
    deathRayKills: '0',
    thornDamage: '0',
    wavesSkipped: '0',
  };
}

function parseAnyDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString().split('T')[0];
  }

  const normalized = trimmed
    .replace(/(\d+)(st|nd|rd|th)/gi, '$1')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  const compactMonth = normalized.match(/([a-zA-Z]+)(\d{1,2})(\d{4})/);
  if (compactMonth) {
    const maybe = new Date(`${compactMonth[1]} ${compactMonth[2]} ${compactMonth[3]}`);
    if (!Number.isNaN(maybe.getTime())) {
      return maybe.toISOString().split('T')[0];
    }
  }

  return null;
}

function normalizeValue(valuePart: string): string {
  const compact = valuePart.replace(/\s+/g, '').replace(/,/g, '');
  const match = compact.match(VALUE_REGEX);
  if (!match) return compact;
  return `${match[1] || ''}${match[2]}${match[3] || ''}`;
}

function matchLifetimeKey(line: string, labelPart: string): keyof LifetimeEntryData | null {
  for (const [regex, key] of LABEL_MAP) {
    if (regex.test(labelPart) || regex.test(line)) return key;
  }

  const compact = line.replace(/\s+/g, '');
  for (const [regex, key] of LABEL_MAP) {
    if (regex.test(compact)) return key;
  }

  return null;
}

export function parseLifetimeStatsFromOcrText(ocrText: string): LifetimeEntryData | null {
  if (!ocrText || !ocrText.trim()) return null;
  const lines = ocrText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;

  const result = buildDefaultEntry();
  result.date = todayIsoDate();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const inlineDate = parseAnyDate(line);
    if (inlineDate && /game\s*started|games?started|gamestarted/i.test(line)) {
      result.gameStarted = inlineDate;
      continue;
    }

    const idx = line.search(/[\d$]/);
    if (idx === -1) continue;

    const labelPart = line.slice(0, idx).trim();
    const valuePart = line.slice(idx).trim();
    const normalizedValue = normalizeValue(valuePart);
    const matchedKey = matchLifetimeKey(line, labelPart);

    if (!matchedKey) continue;

    if (matchedKey === 'gameStarted') {
      const parsed = parseAnyDate(normalizedValue);
      result.gameStarted = parsed ?? normalizedValue;
      continue;
    }

    result[matchedKey] = normalizedValue;
  }

  return result;
}
