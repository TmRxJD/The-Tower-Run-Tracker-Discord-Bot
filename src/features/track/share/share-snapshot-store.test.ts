import { describe, expect, it, vi } from 'vitest';
import { readShareSnapshot, saveShareSnapshot } from './share-snapshot-store';

const kv = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../../services/idb', () => ({ getTrackerKv: kv.get, setTrackerKv: kv.set }));

describe('coverage baseline compatibility in saved shares', () => {
  const run = { killsWithOrbs: '42', totalEnemies: '100' };
  const deltaResult = { mode: 'last' as const, comparisonLabel: 'vs Last Run',
    baseline: { hitByOrbsPercentage: 90, destroyedInSpotlightPercentage: 80, coins: 100 } };
  const snapshot = { ref: 'share-ref', userId: 'user', run, sharerName: 'test', deltaResult };

  it('opens older shares without reusing unverifiable precomputed coverage comparisons', async () => {
    kv.get.mockResolvedValueOnce(snapshot);
    const loaded = await readShareSnapshot(snapshot.ref);
    expect(loaded?.run).toEqual(run);
    expect(loaded?.deltaResult?.baseline).toEqual({ coins: 100, destroyedInSpotlightPercentage: 80 });
    expect(snapshot.deltaResult.baseline.hitByOrbsPercentage).toBe(90);
    expect(kv.set).not.toHaveBeenCalled();
  });

  it('round trips a canonically computed baseline', async () => {
    await saveShareSnapshot(snapshot);
    const stored = kv.set.mock.lastCall?.[1];
    expect(stored.coverageVersion).toBe(1);
    kv.get.mockResolvedValueOnce(stored);
    expect((await readShareSnapshot(snapshot.ref))?.deltaResult).toEqual(deltaResult);
  });
});
