import { describe, expect, it } from 'vitest'
import { buildBattleReportMarkdown } from './battle-report-markdown'

const run = {
  type: 'Farming',
  tier: '18',
  wave: '5220',
  roundDuration: '4h4m34s',
  killedBy: 'Basic',
  totalCoins: '1.18Q',
  totalCells: '464.92K',
  damageDealt: '9.20T',
  deathRayDamage: '1.10T',
  destroyedByProjectiles: '120.5K',
  fullRunData: {
    interestEarned: '4.20M',
  },
}

describe('battle report markdown', () => {
  it('renders report sections in report order with their categories', () => {
    const markdown = buildBattleReportMarkdown(run, { sharerName: 'JD' }) ?? ''

    expect(markdown.startsWith('# Battle Report')).toBe(true)
    expect(markdown).toContain('_Farming · Tier 18 · Wave 5220 · JD_')
    expect(markdown).toContain('## Battle Report')
    expect(markdown).toContain('- **Coins Earned:** 1.18Q')
    expect(markdown).toContain('## Damage')
    expect(markdown).toContain('- **Death Ray:** 1.10T')

    // Damage precedes Enemies Destroyed By in the in-game report.
    expect(markdown.indexOf('## Damage')).toBeLessThan(markdown.indexOf('## Enemies Destroyed By'))
  })

  it('pulls stats that only live under fullRunData', () => {
    expect(buildBattleReportMarkdown(run)).toContain('- **Interest earned:** 4.20M')
  })

  it('returns null when no report stats were captured', () => {
    expect(buildBattleReportMarkdown({})).toBeNull()
  })
})
