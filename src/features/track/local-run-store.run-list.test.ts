import { describe, expect, it } from 'vitest';
import { upsertRunInRunList } from './local-run-store';

describe('upsertRunInRunList', () => {
  it('inserts a new run when no match exists', () => {
    const result = upsertRunInRunList([], 'user-1', 'player', {
      localId: 'local-1',
      tier: '5',
      wave: '100',
    }, 1_000);

    expect(result.wasUpdate).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.record.localId).toBe('local-1');
    expect(result.record.userId).toBe('user-1');
    expect(result.record.username).toBe('player');
  });

  it('updates an existing run by runId when incoming data is newer', () => {
    const initial = upsertRunInRunList([], 'user-1', 'player', {
      runId: 'run-1',
      localId: 'local-1',
      wave: '10',
      updatedAt: 1_000,
    }, 1_000);

    const updated = upsertRunInRunList(initial.runs, 'user-1', 'player', {
      runId: 'run-1',
      localId: 'local-1',
      wave: '20',
      updatedAt: 2_000,
    }, 2_000);

    expect(updated.wasUpdate).toBe(true);
    expect(updated.runs).toHaveLength(1);
    expect(updated.record.wave).toBe('20');
  });
});
