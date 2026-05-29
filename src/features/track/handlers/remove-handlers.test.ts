import { describe, expect, it } from 'vitest';
import { resolveRemoveLastRunReference } from './remove-handlers';

describe('remove-handlers remove-last reference resolution', () => {
  it('prefers normalized cloud run ids over legacy plain ids', () => {
    expect(resolveRemoveLastRunReference({
      id: ' legacy-local-id ',
      runId: ' cloud-run-id ',
      localId: ' local-id ',
    })).toEqual({
      cloudRunId: 'cloud-run-id',
      localId: 'local-id',
    });
  });

  it('falls back to document ids when runId is missing', () => {
    expect(resolveRemoveLastRunReference({
      $id: ' cloud-doc-id ',
      localId: ' local-id ',
    })).toEqual({
      cloudRunId: 'cloud-doc-id',
      localId: 'local-id',
    });
  });

  it('uses legacy plain ids only when no normalized cloud id is available', () => {
    expect(resolveRemoveLastRunReference({
      id: ' cloud-doc-id ',
      localId: ' local-id ',
    })).toEqual({
      cloudRunId: 'cloud-doc-id',
      localId: 'local-id',
    });
  });

  it('keeps local-only deletes local-only instead of treating localId as cloud id', () => {
    expect(resolveRemoveLastRunReference({
      localId: ' local-only-id ',
    })).toEqual({
      cloudRunId: null,
      localId: 'local-only-id',
    });
  });
});