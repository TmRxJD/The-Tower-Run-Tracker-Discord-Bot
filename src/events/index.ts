import { Events } from 'discord.js';
import type { TrackerBotClient } from '../core/tracker-bot-client';
import { logger } from '../core/logger';
import { startTrackerRunBackgroundSyncScheduler } from '../features/track/run-background-sync-scheduler';

/**
 * Gateway health is logged at warn/error on purpose: prod defaults to the warn level, and a
 * dropped or resumed session is exactly the evidence needed when interactions arrive late
 * ("command did nothing, had to run it again"). discord.js reconnects on its own, so none
 * of these are fatal.
 */
function registerGatewayHealthLogging(client: TrackerBotClient) {
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

  // Without a listener, an 'error' event is thrown and takes the process down.
  client.on(Events.Error, (error) => {
    logger.error('[discord.js] client error', error);
  });

  client.on(Events.Warn, (message) => {
    logger.warn('[discord.js] warning', message);
  });
}

export function registerEvents(client: TrackerBotClient) {
  registerGatewayHealthLogging(client);

  client.once(Events.ClientReady, readyClient => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
    startTrackerRunBackgroundSyncScheduler(client);
  });
}
