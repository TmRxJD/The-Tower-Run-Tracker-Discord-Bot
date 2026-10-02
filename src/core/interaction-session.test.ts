import { describe, expect, it, vi } from 'vitest';

import { awaitOwnedModalSubmit, createOwnedModalFilter, isModalSubmitTimeout, hasOwnedModalWait } from './interaction-session';

describe('interaction session helpers', () => {
  it('creates an owned modal filter bound to custom id and user id', () => {
    const filter = createOwnedModalFilter('user-1', 'modal-1');

    expect(filter({ customId: 'modal-1', user: { id: 'user-1' } } as never)).toBe(true);
    expect(filter({ customId: 'modal-2', user: { id: 'user-1' } } as never)).toBe(false);
    expect(filter({ customId: 'modal-1', user: { id: 'user-2' } } as never)).toBe(false);
  });

  it('awaits modal submit with owned filter and timeout', async () => {
    const submitted = { customId: 'modal-1', user: { id: 'user-1' } } as never;
    const awaitModalSubmit = vi.fn(async (options: { filter: (interaction: never) => boolean; time: number }) => {
      expect(options.time).toBe(123);
      expect(options.filter(submitted)).toBe(true);
      return submitted;
    });

    const result = await awaitOwnedModalSubmit({ user: { id: 'user-1' }, awaitModalSubmit: awaitModalSubmit as never }, 'modal-1', 123);

    expect(awaitModalSubmit).toHaveBeenCalledOnce();
    expect(result).toBe(submitted);
  });
});
it('recognizes only the normal Discord modal collector timeout', () => {
  const timeout = Object.assign(new Error('Collector received no interactions before ending with reason: time'), { code: 'InteractionCollectorError' });
  expect(isModalSubmitTimeout(timeout)).toBe(true);
  expect(isModalSubmitTimeout(new Error('NETWORK TIMEOUT'))).toBe(false);
  expect(isModalSubmitTimeout(Object.assign(new Error('Collector received no interactions before ending with reason: messageDelete'), { code: 'InteractionCollectorError' }))).toBe(false);
  expect(isModalSubmitTimeout(null)).toBe(false);
});

describe('modal wait lifecycle', () => {
  it('registers before invoking the collector and cleans up synchronous failures', async () => {
    const error = new Error('fixture synchronous failure');
    const request = awaitOwnedModalSubmit({ user: { id: 'sync-owner' }, awaitModalSubmit: () => {
      expect(hasOwnedModalWait('sync-owner', 'sync-modal')).toBe(true); throw error;
    } }, 'sync-modal');
    await expect(request).rejects.toBe(error);
    expect(hasOwnedModalWait('sync-owner', 'sync-modal')).toBe(false);
  });
  it('keeps overlapping waits owned until every collector finishes', async () => {
    let first!: (value: never) => void; let second!: (value: never) => void;
    const a = awaitOwnedModalSubmit({ user: { id: 'overlap-owner' }, awaitModalSubmit: () => new Promise(resolve => { first = resolve; }) }, 'overlap-modal');
    const b = awaitOwnedModalSubmit({ user: { id: 'overlap-owner' }, awaitModalSubmit: () => new Promise(resolve => { second = resolve; }) }, 'overlap-modal');
    expect(hasOwnedModalWait('overlap-owner', 'overlap-modal')).toBe(true);
    first({} as never); await a;
    expect(hasOwnedModalWait('overlap-owner', 'overlap-modal')).toBe(true);
    second({} as never); await b;
    expect(hasOwnedModalWait('overlap-owner', 'overlap-modal')).toBe(false);
  });
});
