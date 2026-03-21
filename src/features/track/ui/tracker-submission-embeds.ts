import { Colors, EmbedBuilder } from 'discord.js'
import { formatNumberForDisplay, parseNumberInput, standardizeNotation } from '../../../utils/tracker-math'
import { getTrackUiConfig } from '../../../config/tracker-ui-config'
import { calculateHourlyRate } from '../tracker-helpers'
import { generateCoverageDescription, trimDisplayTimeSeconds } from '../handlers/upload-helpers'
import { getFirstMeaningfulRunDataValue } from '../shared/run-data-normalization'

type RunDataLike = Record<string, unknown>

function formatDurationForEmbed(duration?: string | null) {
  if (!duration || typeof duration !== 'string') return '0h0m0s'
  const normalized = duration.toLowerCase().replace(/\s+/g, '')
  const h = normalized.match(/(\d+)h/)
  const m = normalized.match(/(\d+)m/)
  const s = normalized.match(/(\d+)s/)
  const hours = h ? parseInt(h[1], 10) : 0
  const minutes = m ? parseInt(m[1], 10) : 0
  const seconds = s ? parseInt(s[1], 10) : 0
  return `${hours}h${minutes}m${seconds}s`
}

function getSubmissionFieldLabel(key: string) {
  const map = getTrackUiConfig().submission.fieldNameMap as Record<string, string>
  const fallbackMap: Record<string, string> = {
    tierWave: '🔢\nTier | Wave',
  }

  const configured = map[key]
  if (key === 'tierWave') {
    if (typeof configured === 'string' && configured.trim()) {
      if (configured.includes('\n')) return configured
      const labelText = configured.replace(/^\s*[0-9]+\s*/, '').replace(/🔢/g, '').trim() || 'Tier | Wave'
      return `🔢\n${labelText}`
    }
    return fallbackMap[key]
  }

  return configured || fallbackMap[key] || key
}

function normalizeCoverageFields(data: RunDataLike): RunDataLike {
  const totalEnemies = getFirstMeaningfulRunDataValue(data.totalEnemies, data['Total Enemies'])
  const enemiesHitByOrbs = getFirstMeaningfulRunDataValue(data.enemiesHitByOrbs, data['Enemies Hit by Orbs'], data.destroyedByOrbs, data['Destroyed By Orbs'])
  const taggedByDeathWave = getFirstMeaningfulRunDataValue(data.taggedByDeathWave, data['Tagged by Deathwave'])
  const destroyedInSpotlight = getFirstMeaningfulRunDataValue(data.destroyedInSpotlight, data['Destroyed in Spotlight'])
  const destroyedInGoldenBot = getFirstMeaningfulRunDataValue(data.destroyedInGoldenBot, data['Destroyed in Golden Bot'])
  const summonedEnemies = getFirstMeaningfulRunDataValue(
    data.guardianSummonedEnemies,
    data.summonedEnemies,
    data['Summoned enemies'],
    data['Summoned Enemies'],
    data.summoned,
    data['Summon'],
    data.summon,
  )

  return {
    ...data,
    ...(totalEnemies !== undefined ? { totalEnemies, ['Total Enemies']: totalEnemies } : {}),
    ...(enemiesHitByOrbs !== undefined
      ? {
          enemiesHitByOrbs,
          destroyedByOrbs: enemiesHitByOrbs,
          ['Enemies Hit by Orbs']: enemiesHitByOrbs,
          ['Destroyed By Orbs']: enemiesHitByOrbs,
        }
      : {}),
    ...(taggedByDeathWave !== undefined ? { taggedByDeathWave, ['Tagged by Deathwave']: taggedByDeathWave } : {}),
    ...(destroyedInSpotlight !== undefined ? { destroyedInSpotlight, ['Destroyed in Spotlight']: destroyedInSpotlight } : {}),
    ...(destroyedInGoldenBot !== undefined ? { destroyedInGoldenBot, ['Destroyed in Golden Bot']: destroyedInGoldenBot } : {}),
    ...(summonedEnemies !== undefined
      ? {
          guardianSummonedEnemies: summonedEnemies,
          summonedEnemies,
          ['Summoned enemies']: summonedEnemies,
          ['Summoned Enemies']: summonedEnemies,
        }
      : {}),
  }
}

export function buildSubmissionResultEmbed(params: {
  data: RunDataLike
  isUpdate: boolean
  runTypeCounts: Record<string, number>
  hasScreenshot: boolean
  screenshotUrl?: string | null
}) {
  const ui = getTrackUiConfig()
  const submissionUi = ui.submission
  const { data, isUpdate, runTypeCounts, hasScreenshot, screenshotUrl } = params
  const coverageData = normalizeCoverageFields(data)
  const runType = (coverageData?.type || 'Farming').toString()
  const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1)
  const rawTypeCount = runTypeCounts?.[runType] ?? runTypeCounts?.[formattedType] ?? 0
  const typeCount = Math.max(1, Number(rawTypeCount) || 0)
  const totalRuns = Math.max(1, Object.values(runTypeCounts || {}).reduce((a, b) => a + b, 0))

  const descriptionTemplate = isUpdate ? submissionUi.descriptionUpdated : submissionUi.descriptionLogged
  const description = descriptionTemplate.replace('{totalRuns}', String(totalRuns))

  const duration = formatDurationForEmbed(String(coverageData?.roundDuration ?? coverageData?.duration ?? ''))
  const durationRaw = String(coverageData?.roundDuration ?? coverageData?.duration ?? '')
  const coinsPerHour = calculateHourlyRate(String(coverageData?.totalCoins ?? coverageData?.coins ?? ''), durationRaw) || 'N/A'
  const cellsPerHour = calculateHourlyRate(String(coverageData?.totalCells ?? coverageData?.cells ?? ''), durationRaw) || 'N/A'
  const dicePerHour = calculateHourlyRate(String(coverageData?.totalDice ?? coverageData?.rerollShards ?? coverageData?.dice ?? ''), durationRaw) || 'N/A'

  const tierDisplay = coverageData?.tierDisplay && String(coverageData.tierDisplay).trim()
    ? String(coverageData.tierDisplay)
    : formatNumberForDisplay(parseNumberInput(standardizeNotation(String(coverageData?.tier ?? '0'))))
  const valueByKey: Record<string, string> = {
    tierWave: `${String(tierDisplay)} | ${String(coverageData?.wave ?? '')}`,
    duration: String(duration),
    killedBy: String(coverageData?.killedBy || 'Unknown'),
    coins: formatNumberForDisplay(parseNumberInput(standardizeNotation(String(coverageData?.totalCoins ?? coverageData?.coins ?? '0')))),
    cells: formatNumberForDisplay(parseNumberInput(standardizeNotation(String(coverageData?.totalCells ?? coverageData?.cells ?? '0')))),
    dice: formatNumberForDisplay(parseNumberInput(standardizeNotation(String(coverageData?.totalDice ?? coverageData?.rerollShards ?? coverageData?.dice ?? '0')))),
    coinsPerHour: String(coinsPerHour),
    cellsPerHour: String(cellsPerHour),
    dicePerHour: String(dicePerHour),
    date: coverageData?.date ? (coverageData?.time ? `${String(coverageData.date)} @ ${trimDisplayTimeSeconds(coverageData.time)}` : String(coverageData.date)) : 'Now',
    type: String(formattedType),
    run: formatNumberForDisplay(typeCount),
  }

  const fields = (submissionUi.fieldOrder as string[])
    .map((key) => {
      const label = getSubmissionFieldLabel(key)
      const value = valueByKey[key]
      if (!label || value === undefined) return null
      return { name: label, value, inline: true }
    })
    .filter((field): field is { name: string; value: string; inline: boolean } => field !== null)

  const embed = new EmbedBuilder()
    .setTitle(submissionUi.title)
    .setURL(submissionUi.url)
    .setDescription(description)
    .addFields(fields)
    .setColor(isUpdate ? Colors.Orange : Colors.Green)

  const noteText = coverageData?.notes || coverageData?.note
  if (noteText && String(noteText).trim() && noteText !== 'N/A') {
    embed.addFields({ name: getSubmissionFieldLabel('notes'), value: String(noteText), inline: false })
  }

  const coverage = generateCoverageDescription(coverageData)
  if (coverage) {
    embed.addFields({ name: submissionUi.coverageLabel, value: coverage, inline: false })
  }

  if (screenshotUrl && String(screenshotUrl).trim()) {
    embed.setImage(String(screenshotUrl))
  } else if (hasScreenshot) {
    embed.setImage('attachment://screenshot.png')
  }

  embed.setFooter({ text: submissionUi.footer })

  return embed
}

export function buildLifetimeSubmissionResultEmbed(params: {
  data: RunDataLike
  isUpdate: boolean
  totalEntries: number
  hasScreenshot: boolean
}) {
  const ui = getTrackUiConfig()
  const submissionUi = ui.submission
  const { data, isUpdate, totalEntries, hasScreenshot } = params
  const descriptionTemplate = isUpdate ? submissionUi.descriptionUpdated : submissionUi.descriptionLogged
  const description = descriptionTemplate.replace('{totalRuns}', String(Math.max(1, totalEntries)))

  const orderedKeys = [
    'gameStarted',
    'coinsEarned',
    'recentCoinsPerHour',
    'cashEarned',
    'stonesEarned',
    'keysEarned',
    'cellsEarned',
    'rerollShardsEarned',
    'damageDealt',
    'enemiesDestroyed',
    'wavesCompleted',
    'upgradesBought',
    'workshopUpgrades',
    'workshopCoinsSpent',
    'researchCompleted',
    'labCoinsSpent',
    'freeUpgrades',
    'interestEarned',
    'orbKills',
    'deathRayKills',
    'thornDamage',
    'wavesSkipped',
  ]

  const lifetimeLabelMap: Record<string, string> = {
    gameStarted: '🗓️ Game Started',
    coinsEarned: '🪙 Coins Earned',
    recentCoinsPerHour: '⏱️ Recent Coins/Hr',
    cashEarned: '💵 Cash Earned',
    stonesEarned: '🧱 Stones Earned',
    keysEarned: '🗝️ Keys Earned',
    cellsEarned: '🔋 Cells Earned',
    rerollShardsEarned: '🎲 Dice Earned',
    damageDealt: '💥 Damage Dealt',
    enemiesDestroyed: '👾 Enemies Destroyed',
    wavesCompleted: '🌊 Waves Completed',
    upgradesBought: '⬆️ Upgrades Bought',
    workshopUpgrades: '🏭 Workshop Upgrades',
    workshopCoinsSpent: '🏭 Workshop Coins Spent',
    researchCompleted: '🔬 Research Completed',
    labCoinsSpent: '🧪 Lab Coins Spent',
    freeUpgrades: '🎁 Free Upgrades',
    interestEarned: '📈 Interest Earned',
    orbKills: '🟣 Orb Kills',
    deathRayKills: '☠️ Death Ray Kills',
    thornDamage: '🌵 Thorn Damage',
    wavesSkipped: '⏭️ Waves Skipped',
  }

  const fields = orderedKeys
    .map((key) => {
      const value = data[key]
      if (value === undefined || value === null) return null
      const str = String(value).trim()
      if (!str) return null
      return {
        name: lifetimeLabelMap[key] ?? key,
        value: str.length > 1024 ? `${str.slice(0, 1021)}...` : str,
        inline: true,
      }
    })
    .filter((field): field is { name: string; value: string; inline: boolean } => field !== null)

  const dateValue = String(data.date ?? '').trim()
  if (dateValue) {
    fields.unshift({ name: '📅 Entry Date', value: dateValue, inline: true })
  }

  const embed = new EmbedBuilder()
    .setTitle(submissionUi.title)
    .setURL(submissionUi.url)
    .setDescription(description)
    .addFields(fields)
    .setColor(isUpdate ? Colors.Orange : Colors.Green)
    .setFooter({ text: submissionUi.footer })

  if (hasScreenshot) {
    embed.setImage('attachment://screenshot.png')
  }

  return embed
}