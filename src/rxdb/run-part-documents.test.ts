import { describe, expect, it } from 'vitest';
import { stitchTrackerRunCollections } from '@tmrxjd/platform/tools';
import { toRunPartPlainDocument } from './run-part-documents';

describe('toRunPartPlainDocument', () => {
  it('unwraps RxDocument-like payloads for stitch', () => {
    const part1 = {
      toJSON: () => ({
        id: 'run-abc',
        updatedAt: 1_700_000_000_000,
        tier: '12',
        wave: '5000',
        runId: 'run-abc',
      }),
    };
    const part2 = {
      toJSON: () => ({
        id: 'run-abc',
        updatedAt: 1_700_000_000_000,
        schemaVersion: 1,
        runId: 'run-abc',
      }),
    };

    const stitched = stitchTrackerRunCollections(
      toRunPartPlainDocument(part1 as never),
      toRunPartPlainDocument(part2 as never),
    );

    expect(stitched).not.toBeNull();
    expect(stitched?.id).toBe('run-abc');
    expect(stitched?.tier).toBe('12');
  });

  it('does not stitch RxDocument-like payloads without toJSON unwrap', () => {
    const part1 = {
      toJSON: () => ({
        id: 'run-abc',
        updatedAt: 1,
        tier: '1',
        wave: '1',
        runId: 'run-abc',
      }),
    };

    const stitched = stitchTrackerRunCollections(part1 as never, null);
    expect(stitched).toBeNull();
  });
});
