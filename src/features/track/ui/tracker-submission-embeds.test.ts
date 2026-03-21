import { describe, expect, it } from 'vitest'
import { buildLifetimeSubmissionResultEmbed, buildSubmissionResultEmbed } from './tracker-submission-embeds'

describe('tracker submission embeds', () => {
  it('builds the run submission embed with normalized coverage fields', () => {
    const embed = buildSubmissionResultEmbed({
      data: {
        tierDisplay: '12+',
        wave: 3456,
        roundDuration: '1h2m3s',
        totalCoins: '12345',
        totalCells: '67',
        totalDice: '8',
        killedBy: 'Boss',
        date: '2026-03-13',
        time: '12:34:56',
        type: 'Farming',
        notes: 'test note',
        'Total Enemies': '5000',
        'Destroyed By Orbs': '1200',
      },
      isUpdate: false,
      runTypeCounts: { Farming: 4 },
      hasScreenshot: false,
      screenshotUrl: null,
    })

    expect(embed.data.title).toBeTruthy()
    expect(embed.data.description).toContain('4')
    expect(embed.data.fields?.some(field => field.name.includes('Tier'))).toBe(true)
    expect(embed.data.fields?.some(field => field.name.includes('notes') || field.name.includes('Notes'))).toBe(true)
    expect(embed.data.fields?.some(field => String(field.value).includes('Coverage'))).toBe(false)
  })

  it('builds the lifetime submission embed with entry date and screenshot placeholder', () => {
    const embed = buildLifetimeSubmissionResultEmbed({
      data: {
        date: '2026-03-13',
        coinsEarned: '1000',
        wavesCompleted: '200',
      },
      isUpdate: true,
      totalEntries: 3,
      hasScreenshot: true,
    })

    expect(embed.data.description).toContain('3')
    expect(embed.data.fields?.[0]?.name).toBe('📅 Entry Date')
    expect(embed.data.image?.url).toBe('attachment://screenshot.png')
  })
})