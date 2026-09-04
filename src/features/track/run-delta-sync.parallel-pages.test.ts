import { afterEach, describe, expect, it } from 'vitest';
import { resolveBulkImportParallelPages } from './run-delta-sync';

const VAR = 'TRACKER_BOT_BULK_IMPORT_PARALLEL_PAGES';

describe('resolveBulkImportParallelPages', () => {
  afterEach(() => { delete process.env[VAR]; });

  /**
   * This is the burst size hitting the DNS resolver, since Node re-resolves per request.
   * A bad value must never widen it, so the override is clamped rather than trusted.
   */
  it('defaults to 4 when unset', () => {
    delete process.env[VAR];
    expect(resolveBulkImportParallelPages()).toBe(4);
  });

  it('honours a sensible override', () => {
    process.env[VAR] = '6';
    expect(resolveBulkImportParallelPages()).toBe(6);
  });

  it('caps the override so it cannot recreate the storm', () => {
    process.env[VAR] = '99';
    expect(resolveBulkImportParallelPages()).toBe(10);
  });

  it.each(['0', '-3', 'abc', ''])('falls back to 4 for the invalid value %o', (value) => {
    process.env[VAR] = value;
    expect(resolveBulkImportParallelPages()).toBe(4);
  });

  it('floors a fractional value', () => {
    process.env[VAR] = '2.7';
    expect(resolveBulkImportParallelPages()).toBe(2);
  });
});
