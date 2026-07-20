import { describe, expect, it } from 'vitest'
import { COMPACT_ONLY_GUILD_ID, shouldCompactShare } from './share-compaction'

describe('shouldCompactShare', () => {
  it('always compacts in the compact-only server regardless of preference', () => {
    expect(shouldCompactShare({ guildId: COMPACT_ONLY_GUILD_ID, shareCompact: false })).toBe(true)
    expect(shouldCompactShare({ guildId: COMPACT_ONLY_GUILD_ID, shareCompact: undefined })).toBe(true)
  })

  it('defaults to expanded elsewhere', () => {
    expect(shouldCompactShare({ guildId: '111', shareCompact: undefined })).toBe(false)
    expect(shouldCompactShare({ guildId: null })).toBe(false)
    expect(shouldCompactShare({})).toBe(false)
  })

  it('honors the opt-in preference in other servers', () => {
    expect(shouldCompactShare({ guildId: '111', shareCompact: true })).toBe(true)
    expect(shouldCompactShare({ guildId: '111', shareCompact: false })).toBe(false)
  })
})
