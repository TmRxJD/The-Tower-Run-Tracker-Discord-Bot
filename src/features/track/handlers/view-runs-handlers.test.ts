import { describe, expect, it } from 'vitest';
import { resolveViewRunDeletionReference } from './view-runs-handlers';

describe('view-runs-handlers deletion reference resolution', () => {
  it('prefers normalized cloud ids before local ids for lifetime deletion', () => {
    expect(resolveViewRunDeletionReference({
      $id: ' cloud-doc ',
      id: ' local-doc ',
      runId: ' run-id ',
      localId: ' local-id ',
    })).toMatchObject({
      entryId: 'cloud-doc',
      runId: 'run-id',
      localId: 'local-id',
    });
  });

  it('falls back to local id when no cloud-addressable run id exists', () => {
    expect(resolveViewRunDeletionReference({
      localId: ' local-only ',
      wave: '123',
    })).toMatchObject({
      entryId: 'local-only',
      runId: null,
      localId: 'local-only',
    });
  });

  it('keeps the document id available when the run payload is missing runId', () => {
    expect(resolveViewRunDeletionReference({
      $id: ' cloud-doc ',
      localId: ' local-id ',
      wave: '321',
    })).toMatchObject({
      entryId: 'cloud-doc',
      runId: null,
      localId: 'local-id',
    });
  });

  it('ignores plain id fallbacks when a cloud runId exists but no $id is present', () => {
    expect(resolveViewRunDeletionReference({
      id: ' legacy-local-id ',
      runId: ' cloud-run-id ',
      localId: ' local-id ',
      wave: '456',
    })).toMatchObject({
      entryId: 'cloud-run-id',
      runId: 'cloud-run-id',
      localId: 'local-id',
    });
  });
});