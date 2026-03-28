import { describe, expect, it } from 'vitest'
import {
  TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS,
  TRACK_RUN_CANONICAL_REPORT_LABEL_BY_KEY,
  TRACK_RUN_INLINE_BATTLE_REPORT_LABELS,
  TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS,
  TRACK_RUN_OUTPUT_ALIAS_GROUPS,
  TRACK_RUN_SUBMIT_ALIAS_GROUPS,
} from './track-run-field-vocabulary'

describe('track run field vocabulary', () => {
  it('keeps one authoritative report label per field and only preserves the dice alias bridge', () => {
    expect(TRACK_RUN_CANONICAL_REPORT_LABEL_BY_KEY.totalCoins).toBe('Coins earned')
    expect(TRACK_RUN_CANONICAL_REPORT_LABEL_BY_KEY.damageDealt).toBe('Damage Dealt')
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'cashEarned')?.aliases).toEqual(['Cash earned'])
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'destroyedByThorns')?.aliases).toEqual(['Destroyed by Thorns'])
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'saboteurs')?.aliases).toEqual(['Saboteur'])
    expect(TRACK_RUN_SUBMIT_ALIAS_GROUPS.find(group => group.key === 'totalDice')?.aliases).toEqual(['Reroll Shards Earned', 'rerollShards', 'dice'])
  })

  it('builds the exact ordered label lists used for tracker battle reports', () => {
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toEqual([
      'Battle Report',
      'Combat',
      'Utility',
      'Enemies Destroyed',
      'Bots',
      'Guardian',
    ])
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS['Battle Report']).toEqual([
      'Battle Date',
      'Game Time',
      'Real Time',
      'Tier',
      'Wave',
      'Killed By',
      'Coins earned',
      'Coins per hour',
      'Cash earned',
      'Interest earned',
      'Gem Blocks Tapped',
      'Cells Earned',
      'Reroll Shards Earned',
    ])
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Battle Date')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Damage Dealt')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Destroyed by Death Ray')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).not.toContain('Coins Earned')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).not.toContain('Damage dealt')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).not.toContain('Saboteurs')
    expect(new Set(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).size).toBe(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS.length)
  })
})