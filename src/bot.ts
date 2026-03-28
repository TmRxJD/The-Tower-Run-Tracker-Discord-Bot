import { createHash } from 'node:crypto';
import { GatewayIntentBits, Partials } from 'discord.js';
import { getAppConfig, loadConfig } from './config';
import { createBotBootstrapContext } from './core/bootstrap-contract';
import { acquireSharedDiscordTokenLock, acquireSingleInstanceLock } from './core/single-instance-lock';
import { TrackerBotClient } from './core/tracker-bot-client';
import { logger } from './core/logger';
import { registerInteractionRouter } from './core/interaction-router';
import { registerEvents } from './events';
import { commandModules } from './commands';
import { registerComponentHandlers } from './interactions';
import { createPersistence } from './persistence';
import { assertTrackerKvPersistentStorage, getTrackerKvStorageStatus } from './services/idb';

function registerShutdownHandlers(cleanup: (reason: string, error?: unknown) => Promise<void>): void {
  process.once('SIGINT', () => {
    void cleanup('SIGINT');
  });
  process.once('SIGTERM', () => {
    void cleanup('SIGTERM');
  });
  process.once('unhandledRejection', (reason) => {
    void cleanup('unhandledRejection', reason);
  });
  process.once('uncaughtException', (error) => {
    void cleanup('uncaughtException', error);
  });
}

async function bootstrap() {
  loadConfig();
  const appConfig = getAppConfig();
  const releaseInstanceLock = await acquireSingleInstanceLock();
  const tokenLockKey = createHash('sha256').update(appConfig.discord.token).digest('hex').slice(0, 16);
  const releaseSharedTokenLock = await acquireSharedDiscordTokenLock(tokenLockKey, `A local Discord bot process using client ${appConfig.discord.clientId}`);
  let cleanupStarted = false;

  const cleanup = async (reason: string, error?: unknown) => {
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;
    if (error) {
      logger.error(`TrackerBot shutting down after ${reason}`, error);
      process.exitCode = 1;
    }

    await releaseSharedTokenLock().catch(() => null);
    await releaseInstanceLock().catch(() => null);
  };

  registerShutdownHandlers(cleanup);

  try {
    await assertTrackerKvPersistentStorage();
    const kvStatus = await getTrackerKvStorageStatus();
    logger.info('Tracker KV storage initialized', kvStatus);

    const client = new TrackerBotClient(
      {
        intents: [GatewayIntentBits.Guilds],
        partials: [Partials.Channel],
      },
      appConfig
    );
    const startup = createBotBootstrapContext(client, appConfig);

    startup.client.persistence = createPersistence();

    startup.client.commands.registerMany(commandModules);
    registerEvents(startup.client);
    registerComponentHandlers(startup.client);
    registerInteractionRouter(startup.client);

    await startup.client.login(startup.runtime.loginToken);

    startup.client.once('shardDisconnect', () => {
      void cleanup('shardDisconnect');
    });
  } catch (error) {
    await cleanup('bootstrap failure', error);
    throw error;
  }
}

void bootstrap().catch(error => {
  logger.error('Failed to bootstrap tracker bot', error);
  process.exitCode = 1;
});
