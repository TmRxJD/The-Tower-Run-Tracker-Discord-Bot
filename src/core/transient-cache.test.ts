import { expect, it } from 'vitest';
import { TransientCache } from './transient-cache';
it('evicts the least recently used entry without losing the active one', () => {
  let now = 0; const cache = new TransientCache<string, number>(2, 10, () => now);
  cache.set('a', 1); cache.set('b', 2); now = 1; expect(cache.get('a')).toBe(1);
  cache.set('c', 3); expect(cache.has('b')).toBe(false); expect(cache.get('a')).toBe(1); expect(cache.size).toBe(2);
});
it('expires at the deadline and prunes unrelated stale entries on writes', () => {
  let now = 0; const cache = new TransientCache<string, number>(2, 10, () => now);
  cache.set('a', 0); now = 10; expect(cache.get('a')).toBeUndefined(); cache.set('b', 2);
  now = 20; cache.set('c', 3); expect([...cache.keys()]).toEqual(['c']);
});
