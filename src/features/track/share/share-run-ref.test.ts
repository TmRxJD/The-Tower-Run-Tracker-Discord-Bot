import { describe, expect, it } from 'vitest'
import { buildShareRunRef, buildShareSnapshotRef, fitsShareCustomId, parseShareRunRef } from './share-run-ref'

describe('share run ref', () => {
  it('prefers localId and round-trips through parse', () => {
    const ref = buildShareRunRef('4242', { localId: 'local-1', runId: 'cloud-1' })
    expect(ref).toBe('4242:local-1')
    expect(parseShareRunRef(ref!)).toEqual({ userId: '4242', runRef: 'local-1' })
  })

  it('falls back to runId when there is no localId', () => {
    expect(buildShareRunRef('4242', { runId: 'cloud-1' })).toBe('4242:cloud-1')
  })

  it('returns null when the run carries no identity', () => {
    expect(buildShareRunRef('4242', { tier: '18' })).toBeNull()
    expect(buildShareRunRef('', { localId: 'local-1' })).toBeNull()
  })

  it('rejects malformed refs', () => {
    expect(parseShareRunRef('nocolon')).toBeNull()
    expect(parseShareRunRef(':local-1')).toBeNull()
    expect(parseShareRunRef('4242:')).toBeNull()
  })

  it('flags custom ids that overflow the Discord limit', () => {
    expect(fitsShareCustomId('tracker_share_expand:', '4242:local-1')).toBe(true)
    expect(fitsShareCustomId('tracker_share_expand:', 'a'.repeat(100))).toBe(false)
  })
})

it('binds a version to owner, data and counts and reuses identical snapshots', () => {
  const a = buildShareSnapshotRef('4242', { runId: 'run-9', totalCoins: '0' }, { Farming: 9 });
  expect(a).toBe(buildShareSnapshotRef('4242', { runId: 'run-9', totalCoins: '0' }, { Farming: 9 }));
  expect(a).not.toBe(buildShareSnapshotRef('4242', { runId: 'run-9', totalCoins: '2.97s' }, { Farming: 9 }));
  expect(a).not.toBe(buildShareSnapshotRef('other', { runId: 'run-9', totalCoins: '0' }, { Farming: 9 }));
  expect(a).not.toBe(buildShareSnapshotRef('4242', { runId: 'run-9', totalCoins: '0' }, { Farming: 10 }));
  expect(fitsShareCustomId('tracker_share_expand:', a!)).toBe(true);
});
it('versions a changed comparison separately without overwriting an earlier share', () => {
  const run = { localId: 'same-run', wave: '200' }, counts = { Farming: 132 };
  const first = buildShareSnapshotRef('owner', run, counts, true, { mode: 'last', baseline: { wave: 100 }, comparisonLabel: 'vs Last Run' });
  const second = buildShareSnapshotRef('owner', run, counts, true, { mode: 'last', baseline: { wave: 150 }, comparisonLabel: 'vs Last Run' });
  expect(first).not.toBe(second);
  expect(buildShareSnapshotRef('owner', run, counts, false, null)).not.toBe(buildShareSnapshotRef('owner', run, counts, true, null));
});
