export type RunDataRecordLike = Record<string, unknown>
import { TRACK_RUN_OUTPUT_ALIAS_GROUPS, TRACK_RUN_SUBMIT_ALIAS_GROUPS, type RunDataAliasGroup } from './track-run-field-vocabulary'

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