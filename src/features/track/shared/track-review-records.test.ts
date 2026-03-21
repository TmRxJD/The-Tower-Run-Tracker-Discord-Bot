import { describe, expect, it } from 'vitest'
import { toPendingRecord, toRunDataRecord } from './track-review-records'

describe('track review records', () => {
  it('coerces non-object run data into an empty record', () => {
    expect(toRunDataRecord(null)).toEqual({})
    expect(toRunDataRecord('bad')).toEqual({})
  })

  it('parses a pending review record and preserves optional fields', () => {
    const pending = toPendingRecord({
      userId: 'user-1',
      username: 'tester',
      runData: { tier: '12', wave: '3456' },
      canonicalRunData: { totalCoins: '1000' },
      screenshot: { url: 'https://example.com/test.png', contentType: 'image/png' },
      decimalPreference: 'Period (.)',
      isDuplicate: true,
      defaultRunType: 'Tournament',
    })

    expect(pending).toEqual({
      userId: 'user-1',
      username: 'tester',
      runData: { tier: '12', wave: '3456' },
      canonicalRunData: { totalCoins: '1000' },
      screenshot: { url: 'https://example.com/test.png', contentType: 'image/png' },
      decimalPreference: 'Period (.)',
      isDuplicate: true,
      defaultRunType: 'Tournament',
    })
  })

  it('rejects malformed pending review records', () => {
    expect(toPendingRecord(null)).toBeNull()
    expect(toPendingRecord({ userId: 'user-1' })).toBeNull()
    expect(toPendingRecord({ username: 'tester' })).toBeNull()
  })
})