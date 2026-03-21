import { describe, expect, it } from 'vitest'
import {
  TRACK_RUN_INLINE_BATTLE_REPORT_LABELS,
  TRACK_RUN_OUTPUT_ALIAS_GROUPS,
  TRACK_RUN_SUBMIT_ALIAS_GROUPS,
} from './track-run-field-vocabulary'

describe('track run field vocabulary', () => {
  it('includes upload-helper case variants in the canonical alias groups', () => {
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'cashEarned')?.aliases).toContain('Cash earned')
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'damageDealt')?.aliases).toContain('Damage dealt')
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'destroyedByThorns')?.aliases).toContain('Destroyed by Thorns')
    expect(TRACK_RUN_OUTPUT_ALIAS_GROUPS.find(group => group.key === 'saboteurs')?.aliases).toContain('Saboteur')
    expect(TRACK_RUN_SUBMIT_ALIAS_GROUPS.find(group => group.key === 'cashEarned')?.aliases).toContain('Cash earned')
  })

  it('builds one deduped inline battle-report label list for upload parsing', () => {
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Coins Earned')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Cash earned')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Destroyed by Death Ray')
    expect(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).toContain('Battle Date')
    expect(new Set(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS).size).toBe(TRACK_RUN_INLINE_BATTLE_REPORT_LABELS.length)
  })
})