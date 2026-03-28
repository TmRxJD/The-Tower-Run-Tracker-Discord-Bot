import { describe, expect, it, vi } from 'vitest';

import { awaitOwnedModalSubmit, createOwnedModalFilter } from './interaction-session';

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