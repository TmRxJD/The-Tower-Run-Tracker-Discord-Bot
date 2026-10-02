import type { ModalSubmitInteraction } from 'discord.js';

type ModalAwaitingInteraction = {
  user: { id: string };
  awaitModalSubmit: (options: { filter: (interaction: ModalSubmitInteraction) => boolean; time: number }) => Promise<ModalSubmitInteraction>;
};

// Track only live local collectors, scoped to exact Discord owner and modal custom id.
// This is routing metadata, never modal contents. Counts preserve overlapping waits.
const ownedModalWaits = new Map<string, Map<string, number>>();

export function hasOwnedModalWait(userId: string, customId: string): boolean {
  return (ownedModalWaits.get(userId)?.get(customId) ?? 0) > 0;
}

export function createOwnedModalFilter(userId: string, customId: string) {
  return (interaction: ModalSubmitInteraction) => interaction.customId === customId && interaction.user.id === userId;
}

export async function awaitOwnedModalSubmit(
  interaction: ModalAwaitingInteraction,
  customId: string,
  time = 300_000,
): Promise<ModalSubmitInteraction> {
  const userId = interaction.user.id;
  const waits = ownedModalWaits.get(userId) ?? new Map<string, number>();
  waits.set(customId, (waits.get(customId) ?? 0) + 1);
  ownedModalWaits.set(userId, waits);
  try {
    return await interaction.awaitModalSubmit({
      filter: createOwnedModalFilter(userId, customId),
      time,
    });
  } finally {
    const remaining = (waits.get(customId) ?? 1) - 1;
    if (remaining > 0) waits.set(customId, remaining);
    else waits.delete(customId);
    if (waits.size === 0) ownedModalWaits.delete(userId);
  }
}
export function isModalSubmitTimeout(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error && error.code === 'InteractionCollectorError'
    && error.message === 'Collector received no interactions before ending with reason: time';
}
