import { describe, expect, it } from 'vitest'
import { buildShareEmbedActionRows } from './share-embed-actions'

type SerializedShareButton = {
  custom_id?: string
  label?: string
  url?: string
}

describe('share embed actions', () => {
  it('includes Use Run Tracker and Go to Website buttons', () => {
    const rows = buildShareEmbedActionRows()
    expect(rows).toHaveLength(1)
    const components = (rows[0]?.toJSON().components ?? []) as SerializedShareButton[]
    expect(components.some(component => component.custom_id === 'tracker_share_track_run' && component.label === 'Use Run Tracker')).toBe(true)
    expect(components.some(component => component.label === 'Go to Website' && typeof component.url === 'string' && component.url.length > 0)).toBe(true)
    expect(components.some(component => component.label === 'View My Build')).toBe(false)
  })

  it('uses a custom website url when provided', () => {
    const rows = buildShareEmbedActionRows({
      websiteUrl: 'https://example.com/trackers',
    })
    const components = (rows[0]?.toJSON().components ?? []) as SerializedShareButton[]
    expect(components.some(component => component.url === 'https://example.com/trackers')).toBe(true)
  })
})
