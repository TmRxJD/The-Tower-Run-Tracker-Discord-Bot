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
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'saboteurs')?.aliases).toEqual(['Saboteur', 'Saboteurs'])
    expect(TRACK_RUN_SUBMIT_ALIAS_GROUPS.find(group => group.key === 'totalDice')?.aliases).toEqual(['Reroll Shards Earned', 'rerollShards', 'dice'])
  })

  it('builds the section and label sets used for both legacy and updated battle reports', () => {
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toContain('Battle Report')
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toContain('Combat')
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toContain('Records')
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toContain('Damage')
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toContain('Killed With Effect Active')
    expect(TRACK_RUN_BATTLE_REPORT_SECTION_HEADERS).toContain('Enemies Destroyed By')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS['Battle Report']).toContain('Battle Date')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS['Battle Report']).toContain('Cells Per Hour')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS.Damage).toContain('Projectiles')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS['Damage Taken']).toContain('Tower')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS.Coins).toContain('Golden Tower')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_SECTION_LABELS['Killed With Effect Active']).toContain('Golden Tower')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Battle Date')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Damage Dealt')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Projectiles')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Tower')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Destroyed by Death Ray')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).not.toContain('Damage dealt')
    expect(new Set(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).size).toBe(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS.length)
  })
})