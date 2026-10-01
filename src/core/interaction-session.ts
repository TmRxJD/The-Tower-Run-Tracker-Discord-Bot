import type { ModalSubmitInteraction } from 'discord.js';

type ModalAwaitingInteraction = {
  user: { id: string };
  awaitModalSubmit: (options: { filter: (interaction: ModalSubmitInteraction) => boolean; time: number }) => Promise<ModalSubmitInteraction>;
};

export function createOwnedModalFilter(userId: string, customId: string) {
  return (interaction: ModalSubmitInteraction) => interaction.customId === customId && interaction.user.id === userId;
}

export async function awaitOwnedModalSubmit(
  interaction: ModalAwaitingInteraction,
  customId: string,
  time = 300_000,
): Promise<ModalSubmitInteraction> {
  return interaction.awaitModalSubmit({
    filter: createOwnedModalFilter(interaction.user.id, customId),
    time,
  });
}
export function isModalSubmitTimeout(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error && error.code === 'InteractionCollectorError'
    && error.message === 'Collector received no interactions before ending with reason: time';
}
