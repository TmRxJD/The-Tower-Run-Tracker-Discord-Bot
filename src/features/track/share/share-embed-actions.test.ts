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

  it('adds Expand and Battle Report buttons to a collapsed share', () => {
    const rows = buildShareEmbedActionRows({ shareRunRef: '123:abc', collapsed: true })
    const components = (rows[0]?.toJSON().components ?? []) as SerializedShareButton[]
    expect(components.some(component => component.custom_id === 'tracker_share_expand:123:abc')).toBe(true)
    expect(components.some(component => component.custom_id === 'tracker_share_report:123:abc')).toBe(true)
  })

  it('omits Expand on an already expanded share but keeps Battle Report', () => {
    const rows = buildShareEmbedActionRows({ shareRunRef: '123:abc' })
    const components = (rows[0]?.toJSON().components ?? []) as SerializedShareButton[]
    expect(components.some(component => component.custom_id?.startsWith('tracker_share_expand:'))).toBe(false)
    expect(components.some(component => component.custom_id === 'tracker_share_report:123:abc')).toBe(true)
  })

  it('drops run-scoped buttons when the run reference is missing', () => {
    const rows = buildShareEmbedActionRows({ shareRunRef: null, collapsed: true })
    const components = (rows[0]?.toJSON().components ?? []) as SerializedShareButton[]
    expect(components.some(component => component.custom_id?.startsWith('tracker_share_expand:'))).toBe(false)
    expect(components.some(component => component.custom_id?.startsWith('tracker_share_report:'))).toBe(false)
    expect(components.some(component => component.custom_id === 'tracker_share_track_run')).toBe(true)
  })

  it('drops run-scoped buttons when the custom id would exceed Discord limits', () => {
    const rows = buildShareEmbedActionRows({ shareRunRef: `${'9'.repeat(40)}:${'a'.repeat(60)}`, collapsed: true })
    const components = (rows[0]?.toJSON().components ?? []) as SerializedShareButton[]
    expect(components.some(component => component.custom_id?.startsWith('tracker_share_'))).toBe(true)
    expect(components.every(component => (component.custom_id?.length ?? 0) <= 100)).toBe(true)
  })
})
