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