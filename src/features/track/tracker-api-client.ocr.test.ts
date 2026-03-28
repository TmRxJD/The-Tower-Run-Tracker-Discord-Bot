import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runDirectVisionOcrMock = vi.fn()
const extractTrackerImageTextMock = vi.fn()
const preprocessTrackerImageForOcrMock = vi.fn()
const extractDateTimeFromImageMock = vi.fn()
const formatOCRExtractionMock = vi.fn()
const parseRunDataFromTextMock = vi.fn()

vi.mock('../../config', () => ({
  getAppConfig: () => ({
    appwrite: {
      runsDatabaseId: 'runs-db',
      runsCollectionId: 'runs',
      settingsDatabaseId: 'settings-db',
      settingsCollectionId: 'settings',
      lifetimeDatabaseId: 'lifetime-db',
      lifetimeCollectionId: 'lifetime',
      leaderboardDatabaseId: 'leaderboard-db',
      leaderboardCollectionId: 'leaderboard',
    },
    ai: {
      cloudApiKey: 'test-key',
      cloudEndpoint: 'https://example.com',
      cloudVisionModel: 'test-model',
      timeoutMs: 5000,
    },
  }),
}))

vi.mock('../../core/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../persistence/appwrite-client', () => ({
  createAppwriteClient: () => ({
    databases: {
      getDocument: vi.fn(),
      updateDocument: vi.fn(),
      createDocument: vi.fn(),
      deleteDocument: vi.fn(),
      listDocuments: vi.fn(),
    },
    storage: {
      createFile: vi.fn(),
      deleteFile: vi.fn(),
      getFileView: vi.fn(),
    },
  }),
}))

vi.mock('../../services/idb', () => ({
  getTrackerKv: vi.fn(),
  setTrackerKv: vi.fn(),
}))

vi.mock('@tmrxjd/platform/node', () => ({
  createOrUpdateDocument: vi.fn(),
  extractTrackerImageText: (...args: unknown[]) => extractTrackerImageTextMock(...args),
  getDocumentOrNull: vi.fn(),
  isUnauthorizedAppwriteError: vi.fn(),
  preprocessTrackerImageForOcr: (...args: unknown[]) => preprocessTrackerImageForOcrMock(...args),
  updateOrCreateDocument: vi.fn(),
}))

vi.mock('./handlers/upload-helpers', () => ({
  extractDateTimeFromImage: (...args: unknown[]) => extractDateTimeFromImageMock(...args),
  formatOCRExtraction: (...args: unknown[]) => formatOCRExtractionMock(...args),
  parseRunDataFromText: (...args: unknown[]) => parseRunDataFromTextMock(...args),
}))

vi.mock('./vision-ocr-client', () => ({
  runDirectVisionOcr: (...args: unknown[]) => runDirectVisionOcrMock(...args),
}))

vi.mock('./local-run-store', () => ({
  getLocalLifetime: vi.fn(),
  getLocalRuns: vi.fn(),
  getLocalSettingsRecord: vi.fn(),
  getLocalSettings: vi.fn(),
  getQueueItems: vi.fn(),
  hasPersistedLocalSettings: vi.fn(),
  markQueueItemFailed: vi.fn(),
  mergeCloudRuns: vi.fn(),
  queueCloudDelete: vi.fn(),
  queueCloudSettings: vi.fn(),
  queueCloudUpsert: vi.fn(),
  removeLocalRun: vi.fn(),
  removeQueueItem: vi.fn(),
  upsertLocalRun: vi.fn(),
  updateLocalLifetime: vi.fn(),
  updateLocalSettings: vi.fn(),
}))

vi.mock('./shared/tracker-parity-core', () => ({
  estimateLifetimeEntryTimestamp: vi.fn(),
  mergeLifetimeEntriesDelta: vi.fn(),
  sortLifetimeEntriesByTimestamp: vi.fn(),
}))

import { parseBattleReportRunDataFromOcrLines } from '@tmrxjd/platform/parity'
import { parseLifetimeTrackerOcrText } from '@tmrxjd/platform/tools'
import { runOCR } from './tracker-api-client'

function loadAttachment(fileName: string): { data: Buffer; filename: string; contentType: string } {
  const filePath = resolve('c:/Users/jdion/Projects/TrackerWebsite/the-tower-run-tracker/tmp', fileName)
  return {
    data: readFileSync(filePath),
    filename: fileName,
    contentType: 'image/png',
  }
}

const battleReportLines = [
  'Battle Report',
  'Battle Date    Feb 20, 2026 13:03',
  'Game Time    17h 27m 44s',
  'Real Time    3h 31m 19s',
  'Tier    20',
  'Wave    4732',
  'Killed By    Tank',
  'Coins earned    8.000',
  'Coins per hour    2.270',
  'Cash earned    $5.31T',
  'Interest earned    $62.94M',
  'Gem Blocks Tapped    2',
  'Cells Earned    1.05M',
  'Reroll Shards Earned    482.97K',
  'Combat',
  'Damage dealt    1.41ad',
]

const lifetimeLines = [
  'Game Started August 30 2023',
  'Coins Earned 5.67s',
  'Recent Coins Per Hour 3.930',
  'Cash Earned $26.14q',
  'Stones Earned 165493',
  'Keys Earned 2929',
  'Cells Earned 1.69B',
  'Reroll Shards Earned 290.80M',
  'Damage Dealt 1.53ae',
  'Enemies Destroyed 2.17B',
  'Waves Completed 11.23M',
  'Upgrades Bought 6.48M',
  'Workshop Upgrades 7.19M',
  'Workshop Coins Spent 60.610',
  'Research Completed 3.16K',
  'Lab Coins Spent 559.64Q',
  'Free Upgrades 5.30M',
  'Interest Earned $58.88B',
  'Orb Kills 885.49M',
  'Death Ray Kills 41.06M',
  'Thorn Damage 2.59ad',
  'Waves Skipped 8246078',
]

describe('tracker-api-client OCR routing', () => {
  beforeEach(() => {
    runDirectVisionOcrMock.mockReset()
    extractTrackerImageTextMock.mockReset()
    preprocessTrackerImageForOcrMock.mockReset()
    extractDateTimeFromImageMock.mockReset()
    formatOCRExtractionMock.mockReset()
    parseRunDataFromTextMock.mockReset()
  })

  it('uses cloud OCR first for the battle report image and keeps the shared parser input clean', async () => {
    runDirectVisionOcrMock.mockResolvedValue({
      textLines: battleReportLines,
      runData: {},
    })
    parseRunDataFromTextMock.mockReturnValue({
      type: 'Farming',
      tier: '20',
      wave: '4732',
      gameTime: '17h27m44s',
      roundDuration: '3h31m19s',
      totalCoins: '8.000',
      totalCells: '1.05M',
      totalDice: '482.97K',
      killedBy: 'Tank',
      cashEarned: '5.31T',
      interestEarned: '62.94M',
      gemBlocksTapped: '2',
      damageDealt: '1.41ad',
    })

    const result = await runOCR(loadAttachment('battle_report_example.png'))
    const parsed = parseBattleReportRunDataFromOcrLines(result.text)

    expect(result.source).toBe('cloud-vision')
    expect(result.text).toEqual(battleReportLines)
    expect(parsed).toMatchObject({
      type: 'Farming',
      tier: '20',
      wave: '4732',
      duration: '3h31m19s',
      gameTime: '17h27m44s',
      coins: '8.000',
      cells: '1.05M',
      rerollShards: '482.97K',
      killedBy: 'Tank',
      cashEarned: '5.31T',
      interestEarned: '62.94M',
      gemBlocksTapped: '2',
      dateIso: '2026-02-20',
    })
  })

  it('uses cloud OCR first for lifetime stats and keeps the shared lifetime parser input clean', async () => {
    runDirectVisionOcrMock.mockResolvedValue({
      textLines: lifetimeLines,
      runData: {},
    })
    parseRunDataFromTextMock.mockReturnValue({})

    const result = await runOCR(loadAttachment('lifetime_stats_example.png'))
    const parsed = parseLifetimeTrackerOcrText(result.text)

    expect(result.source).toBe('cloud-vision')
    expect(result.text).toEqual(lifetimeLines)
    expect(parsed).toMatchObject({
      gameStarted: '2023-08-30',
      coinsEarned: '5.67s',
      recentCoinsPerHour: '3.930',
      cashEarned: '$26.14q',
      stonesEarned: '165493',
      keysEarned: '2929',
      cellsEarned: '1.69B',
      rerollShardsEarned: '290.80M',
      damageDealt: '1.53ae',
      enemiesDestroyed: '2.17B',
      wavesCompleted: '11.23M',
      upgradesBought: '6.48M',
      workshopUpgrades: '7.19M',
      workshopCoinsSpent: '60.610',
      researchCompleted: '3.16K',
      labCoinsSpent: '559.64Q',
      freeUpgrades: '5.30M',
      interestEarned: '$58.88B',
      orbKills: '885.49M',
      deathRayKills: '41.06M',
      thornDamage: '2.59ad',
      wavesSkipped: '8246078',
    })
  })

  it('falls back to local Gutenye OCR when cloud OCR is unavailable', async () => {
    runDirectVisionOcrMock.mockRejectedValue(new Error('cloud unavailable'))
    preprocessTrackerImageForOcrMock.mockResolvedValue(Buffer.from('preprocessed-image'))
    extractTrackerImageTextMock.mockResolvedValue({ textLines: battleReportLines })
    extractDateTimeFromImageMock.mockResolvedValue(null)
    parseRunDataFromTextMock.mockReturnValue({
      type: 'Farming',
      tier: '20',
      wave: '4732',
      gameTime: '17h27m44s',
      roundDuration: '3h31m19s',
      totalCoins: '8.000',
      totalCells: '1.05M',
      totalDice: '482.97K',
      killedBy: 'Tank',
      cashEarned: '5.31T',
      interestEarned: '62.94M',
      gemBlocksTapped: '2',
      damageDealt: '1.41ad',
    })

    const result = await runOCR(loadAttachment('battle_report_example.png'))

    expect(result.source).toBe('local-gutenye')
    expect(result.text).toEqual(battleReportLines)
    expect(preprocessTrackerImageForOcrMock).toHaveBeenCalledTimes(1)
    expect(extractTrackerImageTextMock).toHaveBeenCalledTimes(1)
  })
})
