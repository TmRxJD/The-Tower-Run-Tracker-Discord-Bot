import { BaseInteraction, ModalSubmitInteraction, MessageComponentInteraction } from 'discord.js';

export type ComponentHandler = (interaction: MessageComponentInteraction | ModalSubmitInteraction) => Promise<void>;

interface RegisteredHandler {
  prefix: string;
  handler: ComponentHandler;
}

export class ComponentRegistry {
  private handlers: RegisteredHandler[] = [];

  register(prefix: string, handler: ComponentHandler) {
    this.handlers.push({ prefix, handler });
  }

  registerMany(defs: Array<{ prefix: string; handler: ComponentHandler }>) {
    defs.forEach(def => this.register(def.prefix, def.handler));
  }

  find(interaction: BaseInteraction): ComponentHandler | undefined {
    if (!('customId' in interaction)) return undefined;
    const customId = (interaction as MessageComponentInteraction | ModalSubmitInteraction).customId ?? '';
    let bestMatch: RegisteredHandler | undefined;
    for (const handler of this.handlers) {
      if (!customId.startsWith(handler.prefix)) continue;
      if (!bestMatch || handler.prefix.length > bestMatch.prefix.length) {
        bestMatch = handler;
      }
    }
    return bestMatch?.handler;
  }
}
