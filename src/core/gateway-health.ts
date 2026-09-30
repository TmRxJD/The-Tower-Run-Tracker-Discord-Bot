import { Events, type Client } from 'discord.js';
import { logger } from './logger';

/**
 * The gateway library explains every reconnect in a debug line ("Destroying shard / Reason:
 * Told to reconnect by Discord / Code / Recover: Resume"), but discord.js's own
 * `shardReconnecting` event carries no reason at all, so the log said *that* the shard
 * reconnected and never *why*. Only the lines that state a cause are forwarded: heartbeat
 * traffic makes up the bulk of the debug stream and is dropped here.
 */
const GATEWAY_CAUSE_PATTERN = /Destroying shard|unexpected code|unknown error|Invalid session|not recoverable|failed to connect/i;

/**
 * Gateway health is logged at warn/error on purpose: prod defaults to the warn level, and a
 * dropped or resumed session is exactly the evidence needed when interactions arrive late
 * ("command did nothing, had to run it again"). discord.js reconnects on its own, so none
 * of these are fatal.
 */
export function registerGatewayHealthLogging(client: Client): void {
  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn('[gateway] shard disconnected', {
      shardId,
      code: event.code,
      reason: event.reason || undefined,
      wasClean: event.wasClean,
    });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.warn('[gateway] shard reconnecting', { shardId });
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    logger.warn('[gateway] shard resumed', { shardId, replayedEvents, wsPingMs: client.ws.ping });
  });

  client.on(Events.ShardError, (error, shardId) => {
    logger.error('[gateway] shard error', { shardId, error });
  });

  client.on(Events.Invalidated, () => {
    logger.error('[gateway] session invalidated; a restart is required to reconnect');
  });

  client.on(Events.Debug, (message) => {
    if (GATEWAY_CAUSE_PATTERN.test(message)) {
      logger.warn('[gateway] cause', message.replace(/\s+/g, ' ').trim());
    }
  });

  // Without a listener, an 'error' event is thrown and takes the process down.
  client.on(Events.Error, (error) => {
    logger.error('[discord.js] client error', error);
  });

  client.on(Events.Warn, (message) => {
    logger.warn('[discord.js] warning', message);
  });
}
