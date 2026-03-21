export interface TrackUserLike {
  id: string;
  username: string;
}

export interface TrackChannelLike {
  send?: (...args: never[]) => Promise<unknown>;
}

export interface TrackMessageLike {
  embeds?: unknown[];
  components?: unknown[];
}

export interface TrackInteractionLike {
  customId: string;
  user: TrackUserLike;
}

type BivariantCallback<T extends (...args: unknown[]) => Promise<unknown>> = {
  bivarianceHack: T;
}['bivarianceHack'];

export interface TrackReplyInteractionLike {
  user: TrackUserLike;
  client: unknown;
  channel?: unknown | null;
  message?: unknown;
  deferred?: boolean;
  replied?: boolean;
  deferReply: BivariantCallback<(options?: unknown) => Promise<unknown>>;
  reply: BivariantCallback<(options: unknown) => Promise<unknown>>;
  editReply: BivariantCallback<(options: unknown) => Promise<unknown>>;
  followUp?: BivariantCallback<(options: unknown) => Promise<unknown>>;
  showModal?: BivariantCallback<(modal: unknown) => Promise<unknown>>;
  awaitModalSubmit?: BivariantCallback<(options: unknown) => Promise<TrackInteractionLike>>;
}

export interface TrackComponentInteractionLike extends TrackReplyInteractionLike {
  customId: string;
  values?: string[];
  isButton?: () => boolean;
  isStringSelectMenu?: () => boolean;
  deferUpdate: () => Promise<unknown>;
  update: BivariantCallback<(options: unknown) => Promise<unknown>>;
  showModal: BivariantCallback<(modal: unknown) => Promise<unknown>>;
  awaitModalSubmit: BivariantCallback<(options: unknown) => Promise<TrackInteractionLike>>;
}
