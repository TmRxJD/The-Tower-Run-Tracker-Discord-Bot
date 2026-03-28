import { describe, expect, it } from 'vitest';

import { ComponentRegistry } from './component-registry';

describe('ComponentRegistry', () => {
  it('dispatches handlers by interaction kind', async () => {
    const registry = new ComponentRegistry();
    const calls: string[] = [];

    registry.registerButton('button:id', async () => { calls.push('button'); });
    registry.registerStringSelect('string:id', async () => { calls.push('string-select'); });
    registry.registerModal('modal:id', async () => { calls.push('modal'); });

    await registry.dispatch({ isButton: () => true, isStringSelectMenu: () => false, isUserSelectMenu: () => false, isRoleSelectMenu: () => false, isMentionableSelectMenu: () => false, isChannelSelectMenu: () => false, isModalSubmit: () => false, customId: 'button:id' } as never);
    await registry.dispatch({ isButton: () => false, isStringSelectMenu: () => true, isUserSelectMenu: () => false, isRoleSelectMenu: () => false, isMentionableSelectMenu: () => false, isChannelSelectMenu: () => false, isModalSubmit: () => false, customId: 'string:id' } as never);
    await registry.dispatch({ isButton: () => false, isStringSelectMenu: () => false, isUserSelectMenu: () => false, isRoleSelectMenu: () => false, isMentionableSelectMenu: () => false, isChannelSelectMenu: () => false, isModalSubmit: () => true, customId: 'modal:id' } as never);

    expect(calls).toEqual(['button', 'string-select', 'modal']);
  });

  it('prefers the longest prefix match and preserves legacy prefix registration', async () => {
    const registry = new ComponentRegistry();
    const calls: string[] = [];

    registry.registerMany([
      { prefix: 'tracker_', handler: async () => { calls.push('general'); } },
      { prefix: 'tracker_review_', handler: async () => { calls.push('specific'); } },
    ]);

    await registry.dispatch({ isButton: () => true, isStringSelectMenu: () => false, isUserSelectMenu: () => false, isRoleSelectMenu: () => false, isMentionableSelectMenu: () => false, isChannelSelectMenu: () => false, isModalSubmit: () => false, customId: 'tracker_review_token' } as never);

    expect(calls).toEqual(['specific']);
  });

  it('returns false for unregistered modal interactions', async () => {
    const registry = new ComponentRegistry();

    const handled = await registry.dispatch({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isUserSelectMenu: () => false,
      isRoleSelectMenu: () => false,
      isMentionableSelectMenu: () => false,
      isChannelSelectMenu: () => false,
      isModalSubmit: () => true,
      customId: 'unregistered_modal',
    } as never);

    expect(handled).toBe(false);
  });
});