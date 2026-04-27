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

type RawParseFieldValue = {
  value: string | null;
  fromRawParseFields: boolean;
};

type UpdatedRawParseField = {
  key: string;
  label: string;
};

type UpdatedRawParseSection = {
  section: string;
  fields: UpdatedRawParseField[];
};

function readScannedBattleReportValue(data: RunDataRecord, normalizedData: Record<string, unknown>, key: string): RawParseFieldValue {
  const rawParseFields = data.rawParseFields && typeof data.rawParseFields === 'object'
    ? data.rawParseFields as Record<string, unknown>
    : null;

  if (rawParseFields && Object.prototype.hasOwnProperty.call(rawParseFields, key)) {
    const value = rawParseFields[key];
    if (value === undefined || value === null) {
      return { value: null, fromRawParseFields: true };
    }

    return {
      value: String(value).trim(),
      fromRawParseFields: true,
    };
  }

  if (key === 'battleDate') {
    const formattedIsoBattleDate = typeof normalizedData.dateIso === 'string' && typeof normalizedData.time24h === 'string'
      ? (() => {
          const timestamp = new Date(`${normalizedData.dateIso}T${normalizedData.time24h}`);
          if (Number.isNaN(timestamp.getTime())) return '';
          return `${formatDate(timestamp)} ${formatTime(timestamp)}`;
        })()
      : '';
    const battleDate = typeof normalizedData.battleDate === 'string' && normalizedData.battleDate.trim().length > 0
      ? normalizedData.battleDate.trim()
      : formattedIsoBattleDate || [normalizedData.date, normalizedData.time]
          .map(value => typeof value === 'string' ? value.trim() : '')
          .filter(Boolean)
          .join(' ');
    return { value: battleDate || null, fromRawParseFields: false };
  }

  const value = normalizedData[key];
  if (value === undefined || value === null) return { value: null, fromRawParseFields: false };
  const text = String(value).trim();
  return { value: text ? text : null, fromRawParseFields: false };
}

const UPDATED_RAW_PARSE_LAYOUT: UpdatedRawParseSection[] = [
  {
    section: 'Battle Report',
    fields: [
      { key: 'battleDate', label: 'Battle Date' },
      { key: 'gameTime', label: 'Game Time' },
      { key: 'roundDuration', label: 'Real Time' },
      { key: 'tier', label: 'Tier' },
      { key: 'wave', label: 'Wave' },
      { key: 'killedBy', label: 'Killed By' },
      { key: 'totalCoins', label: 'Coins Earned' },
      { key: 'coinsPerHour', label: 'Coins Per Hour' },
      { key: 'totalCells', label: 'Cells Earned' },
      { key: 'cellsPerHour', label: 'Cells Per Hour' },
    ],
  },
  {
    section: 'Records',
    fields: [
      { key: 'highestCoinsPerMinute', label: 'Highest Coins / Minute' },
      { key: 'largestWaveSkip', label: 'Largest Wave Skip' },
      { key: 'mostCoinsFromWaveSkip', label: 'Most Coins From Wave Skip' },
      { key: 'mostCellsFromWaveSkip', label: 'Most Cells From Wave Skip' },
      { key: 'largestSmartMissileStack', label: 'Largest Smart Missile Stack' },
      { key: 'largestGoldenCombo', label: 'Largest Golden Combo' },
      { key: 'mostCoinsFromGoldenCombo', label: 'Most Coins From Golden Combo' },
      { key: 'largestInnerLandmineCharge', label: 'Largest Inner Landmine Charge' },
    ],
  },
  {
    section: 'Damage',
    fields: [
      { key: 'damageDealt', label: 'Damage Dealt' },
      { key: 'projectilesDamage', label: 'Projectiles' },
      { key: 'rendArmorDamage', label: 'Rend Armor' },
      { key: 'deathRayDamage', label: 'Death Ray' },
      { key: 'thornDamage', label: 'Thorns' },
      { key: 'orbDamage', label: 'Orbs' },
      { key: 'landMineDamage', label: 'Land Mines' },
      { key: 'chainLightningDamage', label: 'Chain Lightning' },
      { key: 'smartMissileDamage', label: 'Smart Missiles' },
      { key: 'innerLandMineDamage', label: 'Inner Land Mines' },
      { key: 'swampDamage', label: 'Poison Swamp' },
      { key: 'deathWaveDamage', label: 'Death Wave' },
      { key: 'blackHoleDamage', label: 'Black Hole' },
      { key: 'flameBotDamage', label: 'Flame Bot' },
      { key: 'attackChipDamage', label: 'Attack Chip' },
      { key: 'electronsDamage', label: 'Electrons' },
    ],
  },
  {
    section: 'Damage Taken',
    fields: [
      { key: 'damageTaken', label: 'Tower' },
      { key: 'damageTakenWall', label: 'Wall' },
    ],
  },
  {
    section: 'Bonus Health Gained',
    fields: [
      { key: 'hpFromDeathWave', label: 'From Death Wave' },
    ],
  },
  {
    section: 'Health Regenerated',
    fields: [
      { key: 'lifesteal', label: 'Lifesteal' },
      { key: 'towerHealthRegen', label: 'Tower Health Regen' },
      { key: 'wallHealthRegen', label: 'Wall Health Regen' },
    ],
  },
  {
    section: 'Damage Blocked',
    fields: [
      { key: 'defensePercentBlocked', label: 'Defense %' },
      { key: 'defenseAbsoluteBlocked', label: 'Defense Absolute' },
      { key: 'chronoFieldBlocked', label: 'Chrono Field' },
      { key: 'chainThunderBlocked', label: 'Chain Thunder' },
      { key: 'flameBotBlocked', label: 'Flame Bot' },
      { key: 'primordialCollapseBlocked', label: 'Primordial Collapse' },
      { key: 'negativeMassProjectorBlocked', label: 'Negative Mass Projector' },
    ],
  },
  {
    section: 'Utility',
    fields: [
      { key: 'recoveryPackages', label: 'Recovery Packages' },
      { key: 'freeAttackUpgrade', label: 'Free Attack Upgrade' },
      { key: 'freeDefenseUpgrade', label: 'Free Defense Upgrade' },
      { key: 'freeUtilityUpgrade', label: 'Free Utility Upgrade' },
      { key: 'enemyAttackLevelsSkipped', label: 'Enemy Attack Levels Skipped' },
      { key: 'enemyHealthLevelsSkipped', label: 'Enemy Health Levels Skipped' },
    ],
  },
  {
    section: 'Counts',
    fields: [
      { key: 'projectilesCount', label: 'Projectiles Count' },
      { key: 'landMinesSpawned', label: 'Land Mines Spawned' },
      { key: 'thunderBotStuns', label: 'Thunder Bot Stuns' },
      { key: 'wavesSkipped', label: 'Waves Skipped' },
      { key: 'deathDefy', label: 'Death Defy' },
      { key: 'hitsAbsorbedByEnergyShield', label: 'Hits Absorbed By Energy Shield' },
      { key: 'nukeCount', label: 'Nuke' },
      { key: 'secondWindCount', label: 'Second Wind' },
      { key: 'demonModeCount', label: 'Demon Mode' },
    ],
  },
  {
    section: 'Enemies Hit By',
    fields: [
      { key: 'enemiesHitByProjectiles', label: 'Projectiles' },
      { key: 'enemiesHitByThorns', label: 'Thorns' },
      { key: 'enemiesHitByOrbs', label: 'Orbs' },
      { key: 'enemiesHitByDeathRay', label: 'Death Ray' },
      { key: 'enemiesHitByChainLightning', label: 'Chain Lightning' },
      { key: 'enemiesHitBySmartMissiles', label: 'Smart Missiles' },
      { key: 'enemiesHitByInnerLandMines', label: 'Inner Land Mines' },
      { key: 'enemiesHitByPoisonSwamp', label: 'Poison Swamp' },
      { key: 'taggedByDeathWave', label: 'Death Wave' },
      { key: 'enemiesHitByBlackHole', label: 'Black Hole' },
      { key: 'enemiesHitByChronoField', label: 'Chrono Field' },
      { key: 'enemiesHitByLandMines', label: 'Land Mines' },
      { key: 'enemiesHitByThunderBot', label: 'Thunder Bot' },
      { key: 'enemiesHitByFlameBot', label: 'Flame Bot' },
      { key: 'enemiesHitByAttackChip', label: 'Attack Chip' },
      { key: 'enemiesHitByOrbitalAugment', label: 'Orbital Augment' },
    ],
  },
  {
    section: 'Killed With Effect Active',
    fields: [
      { key: 'killsWithGoldenTower', label: 'Golden Tower' },
      { key: 'killsWithDeathWave', label: 'Death Wave' },
      { key: 'destroyedInSpotlight', label: 'Spotlight' },
      { key: 'killsWithAmplifyBot', label: 'Amplify Bot' },
      { key: 'destroyedInGoldenBot', label: 'Golden Bot' },
      { key: 'killsWithDeathPenalty', label: 'Death Penalty' },
    ],
  },
  {
    section: 'Total Enemies',
    fields: [
      { key: 'totalEnemies', label: 'Total Enemies' },
      { key: 'basic', label: 'Basic' },
      { key: 'fast', label: 'Fast' },
      { key: 'tank', label: 'Tank' },
      { key: 'ranged', label: 'Ranged' },
      { key: 'boss', label: 'Boss' },
      { key: 'protector', label: 'Protector' },
      { key: 'vampires', label: 'Vampires' },
      { key: 'rays', label: 'Rays' },
      { key: 'scatters', label: 'Scatters' },
      { key: 'saboteurs', label: 'Saboteur' },
      { key: 'commanders', label: 'Commander' },
      { key: 'overcharges', label: 'Overcharge' },
      { key: 'guardianSummonedEnemies', label: 'Summoned Enemies' },
    ],
  },
  {
    section: 'Coins',
    fields: [
      { key: 'totalCoins', label: 'Coins Earned' },
      { key: 'coinsFromCoinUpgrade', label: 'Coin Bonus Upgrade' },
      { key: 'coinsFromCoinBonuses', label: 'Other Coin Bonuses' },
      { key: 'criticalCoinCoins', label: 'Critical Coin' },
      { key: 'coinsFromGoldenTower', label: 'Golden Tower' },
      { key: 'coinsFromGoldenCombo', label: 'Golden Combo' },
      { key: 'coinsFromDeathWave', label: 'Death Wave' },
      { key: 'coinsFromSpotlight', label: 'Spotlight' },
      { key: 'coinsFromBlackhole', label: 'Black Hole' },
      { key: 'coinsFromOrbs', label: 'Orbs' },
      { key: 'goldenBotCoinsEarned', label: 'Golden Bot' },
      { key: 'coinsPerKill', label: 'Coins / Kill' },
      { key: 'coinsFromWaveSkip', label: 'Wave Skip' },
      { key: 'coinsPerWave', label: 'Coins / Wave' },
      { key: 'coinsFetched', label: 'Coins Fetched' },
      { key: 'bountyCoins', label: 'Bounty Coins' },
    ],
  },
  {
    section: 'Cash',
    fields: [
      { key: 'cashEarned', label: 'Cash Earned' },
      { key: 'cashFromGoldenTower', label: 'Golden Tower' },
      { key: 'interestEarned', label: 'Interest earned' },
    ],
  },
  {
    section: 'Currencies',
    fields: [
      { key: 'totalCells', label: 'Cells Earned' },
      { key: 'gemsEarned', label: 'Gems' },
      { key: 'adGemsEarned', label: 'Ad Gems' },
      { key: 'gemBlocksTapped', label: 'Gem Blocks Tapped' },
      { key: 'fetchGems', label: 'Fetch Gems' },
      { key: 'medalsEarned', label: 'Medals' },
      { key: 'totalDice', label: 'Reroll Shards Earned' },
      { key: 'rerollShardsFetched', label: 'Reroll Shards Fetched' },
      { key: 'cannonShardsFetched', label: 'Cannon Shards' },
      { key: 'armorShardsFetched', label: 'Armor Shards' },
      { key: 'generatorShardsFetched', label: 'Generator Shards' },
      { key: 'coreShardsFetched', label: 'Core Shards' },
      { key: 'commonModulesFetched', label: 'Common Modules' },
      { key: 'rareModulesFetched', label: 'Rare Modules' },
    ],
  },
  {
    section: 'Enemies Destroyed By',
    fields: [
      { key: 'destroyedByProjectiles', label: 'Projectiles' },
      { key: 'destroyedByThorns', label: 'Thorns' },
      { key: 'destroyedByLandMine', label: 'Land Mines' },
      { key: 'destroyedByOrbs', label: 'Orbs' },
      { key: 'destroyedByChainLightning', label: 'Chain Lightning' },
      { key: 'destroyedBySmartMissiles', label: 'Smart Missiles' },
      { key: 'destroyedByInnerLandMines', label: 'Inner Land Mines' },
      { key: 'destroyedByPoisonSwamp', label: 'Poison Swamp' },
      { key: 'destroyedByDeathRay', label: 'Death Ray' },
      { key: 'destroyedByBlackHole', label: 'Black Hole' },
      { key: 'destroyedByFlameBot', label: 'Flame Bot' },
      { key: 'destroyedByOther', label: 'Other' },
    ],
  },
];

function isUpdatedBattleReportShape(data: RunDataRecord, normalizedData: Record<string, unknown>): boolean {
  return [
    'highestCoinsPerMinute',
    'largestWaveSkip',
    'defensePercentBlocked',
    'enemyAttackLevelsSkipped',
    'enemiesHitByProjectiles',
    'killsWithGoldenTower',
    'adGemsEarned',
    'destroyedByProjectiles',
  ].some(key => readScannedBattleReportValue(data, normalizedData, key).value !== null)
}

function formatRawParseLine(field: UpdatedRawParseField, rawField: RawParseFieldValue): string | null {
  if (rawField.value === null && !rawField.fromRawParseFields) {
    return null;
  }

  if (rawField.fromRawParseFields && rawField.value === '') {
    return field.label;
  }

  return rawField.value === null ? null : `${field.label}\t${rawField.value}`;
}

function buildUpdatedRawParseText(data: RunDataRecord, normalizedData: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const section of UPDATED_RAW_PARSE_LAYOUT) {
    const sectionLines = section.fields
      .map(field => formatRawParseLine(field, readScannedBattleReportValue(data, normalizedData, field.key)))
      .filter((line): line is string => Boolean(line));

    if (sectionLines.length > 0) {
      lines.push(section.section);
      lines.push(...sectionLines);
    }
  }

  return lines.join('\n');
}

export function buildRawParseText(data: RunDataRecord): string {
  const normalizedData = canonicalizeRunDataForOutput(data);
  const useUpdatedLayout = isUpdatedBattleReportShape(data, normalizedData);

  if (useUpdatedLayout) {
    return buildUpdatedRawParseText(data, normalizedData);
  }

  const lines: string[] = [];

  for (const section of TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS) {
    const sectionLines = TRACK_RUN_BATTLE_REPORT_FIELDS
      .filter(field => field.section === section)
      .map(field => formatRawParseLine({ key: field.key, label: field.label }, readScannedBattleReportValue(data, normalizedData, field.key)))
      .filter((line): line is string => Boolean(line));

    if (sectionLines.length > 0) {
      lines.push(section);
      lines.push(...sectionLines);
    }
  }

  return lines.join('\n');
}

export function resolveRawParseSourceData(runData: RunDataRecord, canonicalRunData?: RunDataRecord | null): RunDataRecord {
  if (!canonicalRunData) return runData;
  return {
    ...runData,
    ...canonicalRunData,
    rawParseFields: canonicalRunData.rawParseFields ?? runData.rawParseFields,
  };
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