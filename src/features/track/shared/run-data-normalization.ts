export type RunDataRecordLike = Record<string, unknown>
import { z } from 'zod'
import { standardizeNotation } from '../../../utils/tracker-math'
import { TRACK_RUN_OUTPUT_ALIAS_GROUPS, TRACK_RUN_SUBMIT_ALIAS_GROUPS, type RunDataAliasGroup } from './track-run-field-vocabulary'

const TRACKER_RUN_CANONICAL_STRING_FIELDS = [
  'tier',
  'tierDisplay',
  'wave',
  'roundDuration',
  'killedBy',
  'date',
  'time',
  'type',
  'notes',
  'reportTimestamp',
  'runId',
  'localId',
  'screenshotUrl',
  'source',
  'fileId',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'gameTime',
  'coinsPerHour',
  'cellsPerHour',
  'rerollShardsPerHour',
  'cashEarned',
  'interestEarned',
  'gemBlocksTapped',
  'damageTaken',
  'damageTakenWall',
  'damageTakenWhileBerserked',
  'damageGainFromBerserk',
  'deathDefy',
  'damageDealt',
  'projectilesDamage',
  'rendArmorDamage',
  'projectilesCount',
  'lifesteal',
  'thornDamage',
  'orbDamage',
  'enemiesHitByOrbs',
  'landMineDamage',
  'landMinesSpawned',
  'deathRayDamage',
  'smartMissileDamage',
  'innerLandMineDamage',
  'chainLightningDamage',
  'deathWaveDamage',
  'taggedByDeathWave',
  'swampDamage',
  'blackHoleDamage',
  'spotlightDamage',
  'electronsDamage',
  'wavesSkipped',
  'recoveryPackages',
  'freeAttackUpgrade',
  'freeDefenseUpgrade',
  'freeUtilityUpgrade',
  'hpFromDeathWave',
  'coinsFromDeathWave',
  'cashFromGoldenTower',
  'coinsFromGoldenTower',
  'coinsFromBlackhole',
  'coinsFromSpotlight',
  'coinsFromOrbs',
  'coinsFromCoinUpgrade',
  'coinsFromCoinBonuses',
  'totalEnemies',
  'basic',
  'fast',
  'tank',
  'ranged',
  'boss',
  'protector',
  'totalElites',
  'vampires',
  'rays',
  'scatters',
  'saboteurs',
  'commanders',
  'overcharges',
  'destroyedByOrbs',
  'destroyedByThorns',
  'destroyedByDeathRay',
  'destroyedByLandMine',
  'destroyedInSpotlight',
  'flameBotDamage',
  'thunderBotStuns',
  'goldenBotCoinsEarned',
  'destroyedInGoldenBot',
  'guardianDamage',
  'guardianSummonedEnemies',
  'guardianCoinsStolen',
  'coinsFetched',
  'gemsFetched',
  'medalsFetched',
  'rerollShardsFetched',
  'cannonShardsFetched',
  'armorShardsFetched',
  'generatorShardsFetched',
  'coreShardsFetched',
  'commonModulesFetched',
  'rareModulesFetched',
] as const

const TRACKER_RUN_CANONICAL_METRIC_FIELDS = new Set<string>([
  'totalCoins',
  'totalCells',
  'totalDice',
  'coinsPerHour',
  'cellsPerHour',
  'rerollShardsPerHour',
  'cashEarned',
  'interestEarned',
  'gemBlocksTapped',
  'damageTaken',
  'damageTakenWall',
  'damageTakenWhileBerserked',
  'damageGainFromBerserk',
  'deathDefy',
  'damageDealt',
  'projectilesDamage',
  'rendArmorDamage',
  'projectilesCount',
  'lifesteal',
  'thornDamage',
  'orbDamage',
  'enemiesHitByOrbs',
  'landMineDamage',
  'landMinesSpawned',
  'deathRayDamage',
  'smartMissileDamage',
  'innerLandMineDamage',
  'chainLightningDamage',
  'deathWaveDamage',
  'taggedByDeathWave',
  'swampDamage',
  'blackHoleDamage',
  'spotlightDamage',
  'electronsDamage',
  'wavesSkipped',
  'recoveryPackages',
  'freeAttackUpgrade',
  'freeDefenseUpgrade',
  'freeUtilityUpgrade',
  'hpFromDeathWave',
  'coinsFromDeathWave',
  'cashFromGoldenTower',
  'coinsFromGoldenTower',
  'coinsFromBlackhole',
  'coinsFromSpotlight',
  'coinsFromOrbs',
  'coinsFromCoinUpgrade',
  'coinsFromCoinBonuses',
  'totalEnemies',
  'basic',
  'fast',
  'tank',
  'ranged',
  'boss',
  'protector',
  'totalElites',
  'vampires',
  'rays',
  'scatters',
  'saboteurs',
  'commanders',
  'overcharges',
  'destroyedByOrbs',
  'destroyedByThorns',
  'destroyedByDeathRay',
  'destroyedByLandMine',
  'destroyedInSpotlight',
  'flameBotDamage',
  'thunderBotStuns',
  'goldenBotCoinsEarned',
  'destroyedInGoldenBot',
  'guardianDamage',
  'guardianSummonedEnemies',
  'guardianCoinsStolen',
  'coinsFetched',
  'gemsFetched',
  'medalsFetched',
  'rerollShardsFetched',
  'cannonShardsFetched',
  'armorShardsFetched',
  'generatorShardsFetched',
  'coreShardsFetched',
  'commonModulesFetched',
  'rareModulesFetched',
])

const TRACKER_RUN_CLOUD_OPTIONAL_MAX_20_FIELDS = new Set<string>([
  ...TRACKER_RUN_CANONICAL_METRIC_FIELDS,
  'gameTime',
])

const trackerCanonicalRunOptionalFieldShape: Record<string, z.ZodTypeAny> = Object.fromEntries(
  TRACKER_RUN_CANONICAL_STRING_FIELDS
    .filter(key => ![
      'tier', 'tierDisplay', 'wave', 'roundDuration', 'killedBy', 'date', 'time', 'type', 'notes', 'reportTimestamp', 'runId', 'localId', 'screenshotUrl', 'source', 'fileId', 'deletedAt', 'createdAt', 'updatedAt',
    ].includes(key))
    .map(key => [key, z.string().optional()]),
)

const trackerCanonicalRunSchema = z.object({
  tier: z.string().optional(),
  tierDisplay: z.string().optional(),
  tierHasPlus: z.boolean().optional(),
  wave: z.string().optional(),
  roundDuration: z.string().optional(),
  totalCoins: z.string().optional(),
  totalCells: z.string().optional(),
  totalDice: z.string().optional(),
  killedBy: z.string().optional(),
  date: z.string().optional(),
  time: z.string().optional(),
  type: z.string().optional(),
  notes: z.string().optional(),
  reportTimestamp: z.string().optional(),
  runId: z.string().optional(),
  localId: z.string().optional(),
  screenshotUrl: z.string().optional(),
  source: z.string().optional(),
  fileId: z.string().optional(),
  deletedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  public: z.boolean().optional(),
  blocked: z.boolean().optional(),
  verified: z.union([z.boolean(), z.string()]).optional(),
  ...trackerCanonicalRunOptionalFieldShape,
}).strip()

export type TrackerCanonicalRunData = z.infer<typeof trackerCanonicalRunSchema>

function toTrimmedString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text ? text : undefined
}

function normalizeCanonicalMetricValue(value: unknown): string | undefined {
  const text = toTrimmedString(value)
  if (!text) return undefined
  return standardizeNotation(text)
}

function normalizeCanonicalFieldValue(key: string, value: unknown): unknown {
  if (key === 'tierHasPlus' || key === 'public' || key === 'blocked') {
    return value === true || value === 'true' || value === 1 || value === '1'
  }

  if (key === 'verified') {
    if (typeof value === 'boolean') return value
    const text = toTrimmedString(value)
    return text ?? undefined
  }

  if (TRACKER_RUN_CANONICAL_METRIC_FIELDS.has(key)) {
    return normalizeCanonicalMetricValue(value)
  }

  return toTrimmedString(value)
}

function omitUndefinedEntries(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
}

function buildCanonicalFieldMap(data: RunDataRecordLike): Record<string, unknown> {
  const normalized = canonicalizeRunDataForOutput(data)
  const notes = normalized.notes ?? normalized.note
  const date = normalized.date ?? normalized.runDate ?? normalized.dateIso
  const time = normalized.time ?? normalized.runTime ?? normalized.time24h

  const fieldMap: Record<string, unknown> = {
    tier: normalized.tier ?? normalized.tierDisplay,
    tierDisplay: normalized.tierDisplay ?? normalized.tier,
    tierHasPlus: normalized.tierHasPlus,
    wave: normalized.wave,
    roundDuration: normalized.roundDuration ?? normalized.duration,
    totalCoins: normalized.totalCoins,
    totalCells: normalized.totalCells,
    totalDice: normalized.totalDice,
    killedBy: normalized.killedBy,
    date,
    time,
    type: normalized.type,
    notes,
    reportTimestamp: normalized.reportTimestamp,
    runId: normalized.runId,
    localId: normalized.localId,
    screenshotUrl: normalized.screenshotUrl,
    source: normalized.source,
    fileId: normalized.fileId,
    deletedAt: normalized.deletedAt,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    public: normalized.public,
    blocked: normalized.blocked,
    verified: normalized.verified,
  }

  for (const key of TRACKER_RUN_CANONICAL_STRING_FIELDS) {
    if (key in fieldMap) continue
    fieldMap[key] = normalized[key]
  }

  return omitUndefinedEntries(
    Object.fromEntries(
      Object.entries(fieldMap).map(([key, rawValue]) => [key, normalizeCanonicalFieldValue(key, rawValue)]),
    ),
  )
}

export function canonicalizeTrackerRunData(data: RunDataRecordLike): TrackerCanonicalRunData {
  return trackerCanonicalRunSchema.parse(buildCanonicalFieldMap(data))
}

export function serializeTrackerRunForCloudAttributes(data: RunDataRecordLike): Record<string, unknown> {
  const canonical = canonicalizeTrackerRunData(data)
  const serialized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(canonical)) {
    if (value === undefined) continue
    if (typeof value === 'boolean') {
      serialized[key] = value
      continue
    }

    const text = toTrimmedString(value)
    if (!text) continue
    if (TRACKER_RUN_CLOUD_OPTIONAL_MAX_20_FIELDS.has(key) && text.length > 20) continue
    serialized[key] = text
  }

  return serialized
}

function hasMeaningfulValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

export function getFirstMeaningfulRunDataValue(...values: unknown[]): unknown {
  return values.find(hasMeaningfulValue)
}

export function applyRunDataAliasGroups(
  data: RunDataRecordLike,
  aliasGroups: readonly RunDataAliasGroup[],
): RunDataRecordLike {
  const normalized: RunDataRecordLike = { ...data }
  for (const { key, aliases } of aliasGroups) {
    const canonical = normalized[key]
    const aliasValue = getFirstMeaningfulRunDataValue(...aliases.map(alias => normalized[alias]))
    const chosen = hasMeaningfulValue(canonical) ? canonical : aliasValue
    if (chosen !== undefined) normalized[key] = chosen
    for (const alias of aliases) {
      delete normalized[alias]
    }
  }
  return normalized
}

export function normalizeGuardianSummonedEnemiesFromDamage(data: RunDataRecordLike): RunDataRecordLike {
  const normalized: RunDataRecordLike = { ...data }
  const guardianDamageRaw = normalized.guardianDamage
  if (!hasMeaningfulValue(guardianDamageRaw)) return normalized

  const guardianDamageText = String(guardianDamageRaw).trim()
  if (!/summoned\s+enemies/i.test(guardianDamageText)) return normalized

  const guardianMatch = guardianDamageText.match(/^(.*?)\s+summoned\s+enemies\s+(.+)$/i)
  if (!guardianMatch) return normalized

  const guardianDamageValue = (guardianMatch[1] ?? '').trim()
  const summonedEnemiesValue = (guardianMatch[2] ?? '').trim()
  if (guardianDamageValue) normalized.guardianDamage = guardianDamageValue
  if (summonedEnemiesValue && !hasMeaningfulValue(normalized.guardianSummonedEnemies)) {
    normalized.guardianSummonedEnemies = summonedEnemiesValue
  }
  return normalized
}

export function dedupeEquivalentRunDataKeys(data: RunDataRecordLike): RunDataRecordLike {
  const normalized: RunDataRecordLike = { ...data }
  const grouped = new Map<string, string[]>()

  for (const key of Object.keys(normalized)) {
    const token = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (!token) continue
    const existing = grouped.get(token) ?? []
    existing.push(key)
    grouped.set(token, existing)
  }

  const pickPreferredKey = (keys: string[]): string => {
    const camel = keys.find(key => /^[a-z][A-Za-z0-9]*$/.test(key) && /[A-Z]/.test(key))
    if (camel) return camel
    const lower = keys.find(key => /^[a-z][a-z0-9]*$/.test(key))
    if (lower) return lower
    return [...keys].sort((a, b) => a.length - b.length)[0] ?? keys[0]
  }

  for (const keys of grouped.values()) {
    if (keys.length < 2) continue
    const preferred = pickPreferredKey(keys)
    if (!hasMeaningfulValue(normalized[preferred])) {
      const donorKey = keys.find(key => key !== preferred && hasMeaningfulValue(normalized[key]))
      if (donorKey) normalized[preferred] = normalized[donorKey]
    }
    for (const key of keys) {
      if (key !== preferred) delete normalized[key]
    }
  }

  return normalized
}

export function canonicalizeRunDataForOutput(data: RunDataRecordLike): RunDataRecordLike {
  return dedupeEquivalentRunDataKeys(
    normalizeGuardianSummonedEnemiesFromDamage(
      applyRunDataAliasGroups(data, TRACK_RUN_OUTPUT_ALIAS_GROUPS),
    ),
  )
}