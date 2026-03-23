import { describe, expect, it } from 'vitest'
import {
  applyRunDataAliasGroups,
  canonicalizeRunDataForOutput,
  canonicalizeTrackerRunData,
  serializeTrackerRunForCloudAttributes,
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

  it('preserves canonical values when conflicting raw aliases are present', () => {
    const normalized = canonicalizeRunDataForOutput({
      wave: '7676',
      Wave: '167963',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
    })

    expect(normalized.wave).toBe('7676')
    expect(normalized.killedBy).toBe('Fast')
    expect(normalized.Wave).toBeUndefined()
    expect(normalized['Killed By']).toBeUndefined()
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

  it('builds a single canonical tracker run record and drops raw aliases', () => {
    const canonical = canonicalizeTrackerRunData({
      tier: '11',
      Tier: '11+',
      wave: '7676',
      Wave: '167963',
      totalCoins: '76.37T',
      coins: '76.37T',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      date: '2026-03-23',
      time: '14:00:00',
      runDate: '2026-03-22',
      runTime: '09:15:00',
      notes: 'keep me',
      values: { junk: true },
    })

    expect(canonical).toMatchObject({
      tier: '11',
      tierDisplay: '11',
      wave: '7676',
      totalCoins: '76.37T',
      killedBy: 'Fast',
      date: '2026-03-23',
      time: '14:00:00',
      runDate: '2026-03-22',
      runTime: '09:15:00',
      notes: 'keep me',
    })
    expect(canonical).not.toHaveProperty('Wave')
    expect(canonical).not.toHaveProperty('Killed By')
    expect(canonical).not.toHaveProperty('values')
  })

  it('omits oversized optional cloud attributes instead of sending invalid Appwrite values', () => {
    const serialized = serializeTrackerRunForCloudAttributes({
      tier: '11',
      wave: '7676',
      roundDuration: '9h54m5s',
      totalCoins: '76.37T',
      totalCells: '128.82K',
      totalDice: '16.80K',
      killedBy: 'Fast',
      date: '2026-03-21',
      time: '13:47:00',
      runDate: '2026-03-20',
      runTime: '11:47:00',
      deathWaveDamage: '1234567890123456789012345',
      taggedByDeathWave: '167963',
    })

    expect(serialized).toMatchObject({
      tier: '11',
      wave: '7676',
      totalCoins: '76.37T',
      runDate: '2026-03-20',
      runTime: '11:47:00',
      taggedByDeathWave: '167963',
    })
    expect(serialized.deathWaveDamage).toBeUndefined()
  })
})