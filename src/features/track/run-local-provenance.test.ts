import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ records: new Map<string, unknown>(), fail: false }));
vi.mock('../../services/idb', () => ({ getTrackerKv: async (key: string) => fixture.records.get(key) ?? null,
  setTrackerKv: async (key: string, value: unknown, options: { requirePersistent?: boolean }) => {
    expect(options.requirePersistent).toBe(true); if (fixture.fail) throw Error('synthetic disk failure'); fixture.records.set(key, value);
  } }));
import { getOriginalRunTarget, rememberOriginalRunTarget } from './run-local-provenance';
beforeEach(() => { fixture.records.clear(); fixture.fail = false; });
it('preserves the first alt across concurrent later selections', async () => {
  await Promise.all([rememberOriginalRunTarget('fixture', 'local', 'alt-a'), rememberOriginalRunTarget('fixture', 'local', 'alt-b')]);
  expect(await getOriginalRunTarget('fixture', 'local')).toEqual({ profileId: 'alt-a' });
});
it('preserves explicit Main and never fills unknown legacy provenance', async () => {
  await rememberOriginalRunTarget('fixture', 'main', null); await rememberOriginalRunTarget('fixture', 'main', 'alt-b');
  expect(await getOriginalRunTarget('fixture', 'main')).toEqual({ profileId: null });
  await rememberOriginalRunTarget('fixture', 'legacy', undefined); expect(await getOriginalRunTarget('fixture', 'legacy')).toBeNull();
});
it('propagates persistence failure instead of acknowledging a target', async () => {
  fixture.fail = true; await expect(rememberOriginalRunTarget('fixture', 'failed', 'alt-a')).rejects.toThrow();
  expect(await getOriginalRunTarget('fixture', 'failed')).toBeNull();
});
