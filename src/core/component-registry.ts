import type {
  BaseInteraction,
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  MentionableSelectMenuInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';

type MatchStrategy = 'exact' | 'prefix';
type MessageComponentKind = 'button' | 'string-select' | 'user-select' | 'role-select' | 'mentionable-select' | 'channel-select';
type ComponentKind = MessageComponentKind | 'modal';
type ComponentKindGroup = ComponentKind | 'select' | 'message-component' | 'all' | 'any';

type ButtonHandler = (interaction: ButtonInteraction) => Promise<void>;
type StringSelectHandler = (interaction: StringSelectMenuInteraction) => Promise<void>;
type UserSelectHandler = (interaction: UserSelectMenuInteraction) => Promise<void>;
type RoleSelectHandler = (interaction: RoleSelectMenuInteraction) => Promise<void>;
type MentionableSelectHandler = (interaction: MentionableSelectMenuInteraction) => Promise<void>;
type ChannelSelectHandler = (interaction: ChannelSelectMenuInteraction) => Promise<void>;
type ModalHandler = (interaction: ModalSubmitInteraction) => Promise<void>;
export type ComponentHandler = (interaction: MessageComponentInteraction | ModalSubmitInteraction) => Promise<void>;

interface ComponentRegistration<T> {
  match: MatchStrategy;
  handler: T;
}

const COMPONENT_KINDS: ComponentKind[] = [
  'button',
  'string-select',
  'user-select',
  'role-select',
  'mentionable-select',
  'channel-select',
  'modal',
];

function createHandlerMaps<T>() {
  return new Map<ComponentKind, Map<string, ComponentRegistration<T>>>(
    COMPONENT_KINDS.map(kind => [kind, new Map<string, ComponentRegistration<T>>()])
  );
}

function expandKinds(kind: ComponentKindGroup): ComponentKind[] {
  switch (kind) {
    case 'button':
    case 'string-select':
    case 'user-select':
    case 'role-select':
    case 'mentionable-select':
    case 'channel-select':
    case 'modal':
      return [kind];
    case 'select':
      return ['string-select', 'user-select', 'role-select', 'mentionable-select', 'channel-select'];
    case 'message-component':
      return ['button', 'string-select', 'user-select', 'role-select', 'mentionable-select', 'channel-select'];
    case 'all':
    case 'any':
      return COMPONENT_KINDS;
  }
}

function getComponentKind(interaction: BaseInteraction): ComponentKind | null {
  if (interaction.isButton()) return 'button';
  if (interaction.isStringSelectMenu()) return 'string-select';
  if (interaction.isUserSelectMenu()) return 'user-select';
  if (interaction.isRoleSelectMenu()) return 'role-select';
  if (interaction.isMentionableSelectMenu()) return 'mentionable-select';
  if (interaction.isChannelSelectMenu()) return 'channel-select';
  if (interaction.isModalSubmit()) return 'modal';
  return null;
}

export class ComponentRegistry {
  private readonly handlers = createHandlerMaps<ComponentHandler>();

  register(customId: string, handler: ComponentHandler, options: { kind?: ComponentKindGroup; match?: MatchStrategy } = {}) {
    const { kind = 'all', match = 'prefix' } = options;
    for (const expandedKind of expandKinds(kind)) {
      this.handlers.get(expandedKind)?.set(customId, { match, handler });
    }
  }

  registerMany(defs: Array<{ prefix?: string; customId?: string; handler: ComponentHandler; match?: MatchStrategy; kind?: ComponentKindGroup }>) {
    for (const def of defs) {
      const customId = def.customId ?? def.prefix;
      if (!customId) continue;
      this.register(customId, def.handler, {
        match: def.match ?? (def.customId ? 'exact' : 'prefix'),
        kind: def.kind,
      });
    }
  }

  registerButton(customId: string, handler: ButtonHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as ButtonInteraction), { kind: 'button', match });
  }

  registerStringSelect(customId: string, handler: StringSelectHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as StringSelectMenuInteraction), { kind: 'string-select', match });
  }

  registerUserSelect(customId: string, handler: UserSelectHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as UserSelectMenuInteraction), { kind: 'user-select', match });
  }

  registerRoleSelect(customId: string, handler: RoleSelectHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as RoleSelectMenuInteraction), { kind: 'role-select', match });
  }

  registerMentionableSelect(customId: string, handler: MentionableSelectHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as MentionableSelectMenuInteraction), { kind: 'mentionable-select', match });
  }

  registerChannelSelect(customId: string, handler: ChannelSelectHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as ChannelSelectMenuInteraction), { kind: 'channel-select', match });
  }

  registerModal(customId: string, handler: ModalHandler, match: MatchStrategy = 'exact') {
    this.register(customId, async interaction => handler(interaction as ModalSubmitInteraction), { kind: 'modal', match });
  }

  has(customId: string, kind: ComponentKindGroup = 'any') {
    return expandKinds(kind).some(expandedKind => this.handlers.get(expandedKind)?.has(customId) ?? false);
  }

  list(kind: ComponentKindGroup = 'any') {
    return [...new Set(expandKinds(kind).flatMap(expandedKind => [...(this.handlers.get(expandedKind)?.keys() ?? [])]))];
  }

  findByCustomId(customId: string, kind: ComponentKindGroup = 'any'): ComponentHandler | undefined {
    for (const expandedKind of expandKinds(kind)) {
      const handler = this.resolveHandler(customId, this.handlers.get(expandedKind));
      if (handler) return handler;
    }
    return undefined;
  }

  find(interaction: BaseInteraction): ComponentHandler | undefined {
    const kind = getComponentKind(interaction);
    if (!kind || !('customId' in interaction)) return undefined;
    const customId = (interaction as MessageComponentInteraction | ModalSubmitInteraction).customId ?? '';
    return this.resolveHandler(customId, this.handlers.get(kind)) ?? undefined;
  }

  async dispatch(interaction: BaseInteraction): Promise<boolean> {
    const handler = this.find(interaction);
    if (!handler) {
      return false;
    }

    await handler(interaction as MessageComponentInteraction | ModalSubmitInteraction);
    return true;
  }

  private resolveHandler<T>(customId: string, map: Map<string, ComponentRegistration<T>> | undefined): T | null {
    if (!map) return null;
    if (map.has(customId)) return map.get(customId)?.handler ?? null;

    let bestPrefixMatch: T | null = null;
    let bestPrefixLength = -1;

    for (const [key, registration] of map.entries()) {
      if (registration.match === 'prefix' && customId.startsWith(key) && key.length > bestPrefixLength) {
        bestPrefixMatch = registration.handler;
        bestPrefixLength = key.length;
      }
    }

    return bestPrefixMatch;
  }
}
