import { describe, expect, it } from 'vitest'
import {
  applyRunDataAliasGroups,
  canonicalizeRunDataForOutput,
} from './run-data-normalization'
import { TRACK_RUN_SUBMIT_ALIAS_GROUPS } from './track-run-field-vocabulary'

describe('run data normalization', () => {
  it('canonicalizes output aliases and splits guardian summoned enemy text', () => {
    const normalized = canonicalizeRunDataForOutput({
      Tier: '12',
      duration: '1h2m3s',
      'Coins Earned': '1234',
      guardianDamage: '45 summoned enemies 9',
      'Guardian coins stolen': '77',
      'Rare Modules Fetched': '2',
    })

    expect(normalized.tier).toBe('12')
    expect(normalized.roundDuration).toBe('1h2m3s')
    expect(normalized.totalCoins).toBe('1234')
    expect(normalized.guardianDamage).toBe('45')
    expect(normalized.guardianSummonedEnemies).toBe('9')
    expect(normalized.guardianCoinsStolen).toBe('77')
    expect(normalized.rareModulesFetched).toBe('2')
    expect(normalized['Coins Earned']).toBeUndefined()
  })

  it('applies submit aliases that collapse duplicated battle-report keys', () => {
    const submitReady = applyRunDataAliasGroups({
      'Enemies Hit by Orbs': '401',
      'Destroyed By Orbs': '401',
      'Summoned Enemies': '12',
      'Spotlight Damage': '999',
    }, TRACK_RUN_SUBMIT_ALIAS_GROUPS)

    expect(submitReady.enemiesHitByOrbs).toBe('401')
    expect(submitReady['Enemies Hit by Orbs']).toBeUndefined()
    expect(submitReady['Destroyed By Orbs']).toBeUndefined()
    expect(submitReady.guardianSummonedEnemies).toBe('12')
    expect(submitReady.spotlightDamage).toBe('999')
  })
})