import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../features/track/handlers/upload-handlers', () => ({ clearMainMenuSession: vi.fn() }));

import { STALE_COMPONENT_MESSAGE, registerInteractionRouter } from './interaction-router';
import type { TrackerBotClient } from './tracker-bot-client';

type Kind = 'command' | 'button' | 'select' | 'modal';

function makeInteraction(kind: Kind, overrides: Record<string, unknown> = {}) {
  return {
    id: 'interaction-1',
    type: kind === 'command' ? 2 : kind === 'modal' ? 5 : 3,
    createdTimestamp: Date.now(),
    user: { id: 'user-1' },
    guildId: null,
    customId: 'tracker:old-menu',
    commandName: 'track',
    replied: false,
    deferred: false,
    isRepliable: () => true,
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isUserSelectMenu: () => false,
    isRoleSelectMenu: () => false,
    isMentionableSelectMenu: () => false,
    isChannelSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal',
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup() {
  const emitter = new EventEmitter();
  const dispatch = vi.fn(async () => false);
  const execute = vi.fn(async () => undefined);
  const client = Object.assign(emitter, {
    components: { dispatch },
    commands: { get: vi.fn((name: string) => (name === 'track' ? { execute } : undefined)) },
    persistence: undefined,
  }) as unknown as TrackerBotClient;

  registerInteractionRouter(client);
  const fire = async (interaction: unknown) => {
    emitter.emit('interactionCreate', interaction);
    // The listener is fire-and-forget; let its promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { fire, dispatch, execute };
}

describe('interaction router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tells the user when a button has no handler instead of leaving it to fail', async () => {
    const { fire } = setup();
    const interaction = makeInteraction('button');

    await fire(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: STALE_COMPONENT_MESSAGE }));
  });

  it('does the same for a select menu with no handler', async () => {
    const { fire } = setup();
    const interaction = makeInteraction('select');

    await fire(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: STALE_COMPONENT_MESSAGE }));
  });

  it('leaves unclaimed modal submits alone: a local awaitModalSubmit owns them', async () => {
    const { fire } = setup();
    const interaction = makeInteraction('modal');

    await fire(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('does not reply on top of a handler that already answered', async () => {
    const { fire, dispatch } = setup();
    dispatch.mockResolvedValue(true as never);
    const interaction = makeInteraction('button');

    await fire(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('does not reply again when the interaction was already acknowledged', async () => {
    const { fire } = setup();
    const interaction = makeInteraction('button', { deferred: true });

    await fire(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it('runs a registered slash command', async () => {
    const { fire, execute } = setup();
    const interaction = makeInteraction('command');

    await fire(interaction);

    expect(execute).toHaveBeenCalledWith(interaction);
  });

  it('answers a command that throws before it acknowledged the interaction', async () => {
    const { fire, execute } = setup();
    execute.mockRejectedValue(new Error('boom') as never);
    const interaction = makeInteraction('command');

    await fire(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'There was an error handling this interaction.' }));
  });
});
