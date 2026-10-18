import { readTrackerMetricValue, readTrackerModuleShardsTotal } from '@tmrxjd/platform/tools';
import { Colors, EmbedBuilder } from 'discord.js'
import { getFirstMeaningfulRunDataValue, type TrackerRunDeltaResult, type TrackerDeltaStatKey, getDeltaAnnotationForStat } from '@tmrxjd/platform/tools'
import { formatNumberForDisplay } from '../../../utils/tracker-math'
import { getTrackUiConfig } from '../../../config/tracker-ui-config'
import { computeHourlyRate } from '../tracker-helpers'
import { generateCoverageDescription, trimDisplayTimeSeconds } from '../handlers/upload-helpers'

type RunDataLike = Record<string, unknown>

function formatDurationForEmbed(duration?: string | null) {
  if (!duration || typeof duration !== 'string') return 'Unavailable'
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
  const killsWithGoldenTower = getFirstMeaningfulRunDataValue(data.killsWithGoldenTower, data['Golden Tower'])
  const enemiesHitByBlackHole = getFirstMeaningfulRunDataValue(data.enemiesHitByBlackHole, data['Enemies Hit By Black Hole'])
  const enemiesHitByOrbs = getFirstMeaningfulRunDataValue(data.enemiesHitByOrbs, data['Enemies Hit by Orbs'])
  const killsWithOrbs = getFirstMeaningfulRunDataValue(data.killsWithOrbs)
  const killsWithBlackHole = getFirstMeaningfulRunDataValue(data.killsWithBlackHole)
  const taggedByDeathWave = getFirstMeaningfulRunDataValue(data.taggedByDeathWave, data['Tagged by Death Wave'])
  const destroyedInSpotlight = getFirstMeaningfulRunDataValue(data.destroyedInSpotlight, data['Destroyed in Spotlight'])
  const destroyedInGoldenBot = getFirstMeaningfulRunDataValue(data.destroyedInGoldenBot, data['Destroyed in Golden Bot'])
  const killsWithAmplifyBot = getFirstMeaningfulRunDataValue(data.killsWithAmplifyBot, data['Amplify Bot'])
  const summonedEnemies = getFirstMeaningfulRunDataValue(data.guardianSummonedEnemies, data['Summoned enemies'])

  return {
    ...data,
    ...(totalEnemies !== undefined ? { totalEnemies, ['Total Enemies']: totalEnemies } : {}),
    ...(killsWithGoldenTower !== undefined ? { killsWithGoldenTower, ['Golden Tower']: killsWithGoldenTower } : {}),
    ...(enemiesHitByBlackHole !== undefined ? { enemiesHitByBlackHole, ['Enemies Hit By Black Hole']: enemiesHitByBlackHole, ['Black Hole']: enemiesHitByBlackHole } : {}),
    ...(enemiesHitByOrbs !== undefined
      ? {
          enemiesHitByOrbs,
          ['Enemies Hit by Orbs']: enemiesHitByOrbs,
        }
      : {}),
    ...(killsWithOrbs !== undefined ? { killsWithOrbs } : {}),
    ...(killsWithBlackHole !== undefined ? { killsWithBlackHole } : {}),
    ...(taggedByDeathWave !== undefined ? { taggedByDeathWave, ['Tagged by Death Wave']: taggedByDeathWave } : {}),
    ...(destroyedInSpotlight !== undefined ? { destroyedInSpotlight, ['Destroyed in Spotlight']: destroyedInSpotlight } : {}),
    ...(destroyedInGoldenBot !== undefined ? { destroyedInGoldenBot, ['Destroyed in Golden Bot']: destroyedInGoldenBot } : {}),
    ...(killsWithAmplifyBot !== undefined ? { killsWithAmplifyBot, ['Amplify Bot']: killsWithAmplifyBot } : {}),
    ...(summonedEnemies !== undefined
      ? {
          guardianSummonedEnemies: summonedEnemies,
          ['Summoned enemies']: summonedEnemies,
        }
      : {}),
  }
}


function displayMetric(...values: unknown[]): string {
  const value = getFirstMeaningfulRunDataValue(...values)
  const parsed = readTrackerMetricValue(value)
  return parsed === null ? 'Unavailable' : formatNumberForDisplay(parsed)
}

function resolveModuleShardsTotal(data: Record<string, unknown>): string {
  const total = readTrackerModuleShardsTotal(data);
  return total === null ? 'Unavailable' : formatNumberForDisplay(total);
}

export function buildSubmissionResultEmbed(params: {
  data: RunDataLike
  isUpdate: boolean
  runTypeCounts: Record<string, number>
  hasScreenshot: boolean
  screenshotUrl?: string | null
  deltaResult?: TrackerRunDeltaResult
}) {
  const ui = getTrackUiConfig()
  const submissionUi = ui.submission
  const { data, isUpdate, runTypeCounts, hasScreenshot, screenshotUrl, deltaResult } = params
  const coverageData = normalizeCoverageFields(data)
  const runType = (coverageData?.type || 'Farming').toString()
  const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1)
  const rawTypeCount = runTypeCounts?.[runType] ?? runTypeCounts?.[formattedType] ?? 0
  const typeCount = Number(rawTypeCount)
  const typeCountLabel = Number.isSafeInteger(typeCount) && typeCount > 0 ? `#${typeCount}` : '(count unavailable)'
  const totalRuns = Object.values(runTypeCounts || {}).reduce((a, b) => a + b, 0)

  const descriptionTemplate = isUpdate ? submissionUi.descriptionUpdated : submissionUi.descriptionLogged
  const descriptionHeader = Object.keys(runTypeCounts).length ? descriptionTemplate.replace('{totalRuns}', String(totalRuns)) : (isUpdate ? 'Updated your local saved run.' : 'Saved your run locally.')

  const durationRaw = String(coverageData?.roundDuration ?? coverageData?.duration ?? '')
  const duration = formatDurationForEmbed(durationRaw)
  const coinsStr = displayMetric(coverageData?.totalCoins, coverageData?.coins)
  const cellsStr = displayMetric(coverageData?.totalCells, coverageData?.cells)
  const diceStr = displayMetric(coverageData?.totalDice, coverageData?.rerollShards, coverageData?.dice)
  const coinsPerHour = computeHourlyRate(String(coverageData?.totalCoins ?? coverageData?.coins ?? ''), durationRaw) || 'N/A'
  const cellsPerHour = computeHourlyRate(String(coverageData?.totalCells ?? coverageData?.cells ?? ''), durationRaw) || 'N/A'
  const dicePerHour = computeHourlyRate(String(coverageData?.totalDice ?? coverageData?.rerollShards ?? coverageData?.dice ?? ''), durationRaw) || 'N/A'
  const moduleShardsPerHour = computeHourlyRate(resolveModuleShardsTotal(coverageData), durationRaw) || 'N/A'
  const wavesPerHour = computeHourlyRate(String(coverageData?.wave ?? ''), durationRaw) || 'N/A'
  const enemiesPerHour = computeHourlyRate(String(coverageData?.totalEnemies ?? ''), durationRaw) || 'N/A'

  const tierDisplay = coverageData?.tierDisplay && String(coverageData.tierDisplay).trim()
    ? String(coverageData.tierDisplay)
    : displayMetric(coverageData?.tier)
  const waveStr = String(coverageData?.wave ?? 'N/A')
  const dateStr = coverageData?.date
    ? (coverageData?.time ? `${String(coverageData.date)} @ ${trimDisplayTimeSeconds(coverageData.time)}` : String(coverageData.date))
    : 'Unavailable'

  function delta(key: string): string {
    if (!deltaResult) return ''
    const annotation = getDeltaAnnotationForStat(coverageData, key as TrackerDeltaStatKey, deltaResult.baseline, deltaResult.coverageBasis)
    return annotation ? ` ${annotation}` : ''
  }

  const comparisonLine = deltaResult?.comparisonLabel ? ` *(${deltaResult.comparisonLabel})*` : ''

  const descLines: string[] = [
    descriptionHeader + comparisonLine,
    `⚙️ Type: **${formattedType} ${typeCountLabel}**`,
    `📅 Date: **${dateStr}**`,
    `🔢 Tier: **${tierDisplay}**`,
    `🌊 Wave: **${waveStr}**${delta('wave')}`,
    `⏱️ Duration: **${duration}**${delta('duration')}`,
    `💀 Killed By: **${String(coverageData?.killedBy || 'Unknown')}**`,
    `🪙 Coins: **${coinsStr}**${delta('coins')}`,
    `🔋 Cells: **${cellsStr}**${delta('cells')}`,
    `🎲 Dice: **${diceStr}**${delta('rerollShards')}`,
    `🔼 Shards: **${resolveModuleShardsTotal(coverageData)}**${delta('moduleShards')}`,
    `🍀 Death Defies: **${String(coverageData?.deathDefy ?? 'N/A')}**${delta('deathDefy')}`,
    '',
    `**📊 Per Hour**`,
    `🪙 Coins: **${coinsPerHour}**${delta('coinsPerHour')}`,
    `🔋 Cells: **${cellsPerHour}**${delta('cellsPerHour')}`,
    `🎲 Dice: **${dicePerHour}**${delta('rerollShardsPerHour')}`,
    `🔼 Shards: **${moduleShardsPerHour}**${delta('moduleShardsPerHour')}`,
    `🌊 Waves: **${wavesPerHour}**${delta('wavesPerHour')}`,
    `🔳 Enemies: **${enemiesPerHour}**${delta('enemiesPerHour')}`,
  ]

  const embed = new EmbedBuilder()
    .setTitle(submissionUi.title)
    .setURL(submissionUi.url)
    .setDescription(descLines.join('\n'))
    .setColor(isUpdate ? Colors.Orange : Colors.Green)

  const noteText = coverageData?.notes || coverageData?.note
  if (noteText && String(noteText).trim() && noteText !== 'N/A') {
    embed.addFields({ name: getSubmissionFieldLabel('notes'), value: String(noteText), inline: false })
  }

  const deltaCallbackForCoverage = deltaResult
    ? (key: string) => {
        const annotation = getDeltaAnnotationForStat(coverageData, key as TrackerDeltaStatKey, deltaResult.baseline, deltaResult.coverageBasis)
        return annotation ? ` ${annotation}` : ''
      }
    : undefined
  const coverage = generateCoverageDescription(coverageData, { getDeltaAnnotation: deltaCallbackForCoverage })
  if (coverage) {
    embed.addFields({ name: submissionUi.coverageLabel, value: coverage, inline: false })
  }

  if (screenshotUrl && String(screenshotUrl).trim()) {
    embed.setThumbnail(String(screenshotUrl))
  } else if (hasScreenshot) {
    embed.setThumbnail('attachment://screenshot.png')
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