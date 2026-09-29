import './rxdb/ensure-node-storage';
import { createHash } from 'node:crypto';
import { GatewayIntentBits, Partials } from 'discord.js';
import { getAppConfig, loadConfig } from './config';
import { createBotBootstrapContext } from './core/bootstrap-contract';
import { acquireSharedDiscordTokenLock, acquireSingleInstanceLock } from './core/single-instance-lock';
import { TrackerBotClient } from './core/tracker-bot-client';
import { logger } from './core/logger';
import { registerInteractionRouter } from './core/interaction-router';
import { startEventLoopLagMonitor, stopEventLoopLagMonitor } from './core/diagnostics';
import { registerEvents } from './events';
import { commandModules } from './commands';
import { registerComponentHandlers } from './interactions';
import { createPersistence } from './persistence';
import { assertTrackerKvPersistentStorage, getTrackerKvStorageStatus } from './services/idb';
import { registerBotRunInboundChangeHandler } from './rxdb/reactive-sync';
import { purgeQuarantinedBotRxStorage } from './rxdb/bot-rx-storage';
import { cleanupStalePendingRuns } from './features/track/pending-run-store';
import { stopTrackerRunBackgroundSyncScheduler } from './features/track/run-background-sync-scheduler';

/** Upper bound on graceful shutdown so a hung release can never leave a zombie process. */
const SHUTDOWN_TIMEOUT_MS = 8_000;

interface ShutdownContext {
  getClient: () => TrackerBotClient | null;
  releaseLocks: () => Promise<void>;
}

function registerProcessHandlers(context: ShutdownContext): void {
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number, error?: unknown) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (error) {
      logger.error(`TrackerBot shutting down after ${reason}`, error);
    } else {
      logger.warn(`TrackerBot shutting down after ${reason}`);
    }

    // Exit no matter what: signal handlers replace Node's default exit, so a stuck
    // client.destroy() or lock release would otherwise leave the process running unlocked.
    const forceExit = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    stopEventLoopLagMonitor();
    stopTrackerRunBackgroundSyncScheduler();
    await Promise.resolve(context.getClient()?.destroy()).catch(() => null);
    await context.releaseLocks().catch(() => null);
    process.exit(exitCode);
  };

  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('uncaughtException', (error) => void shutdown('uncaughtException', 1, error));

  // A stray rejection in one interaction must not stop the bot for everyone else.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
}

async function bootstrap() {
  loadConfig();
  const appConfig = getAppConfig();
  const releaseInstanceLock = await acquireSingleInstanceLock();
  const tokenLockKey = createHash('sha256').update(appConfig.discord.token).digest('hex').slice(0, 16);
  const releaseSharedTokenLock = await acquireSharedDiscordTokenLock(tokenLockKey, `A local Discord bot process using client ${appConfig.discord.clientId}`);

  let client: TrackerBotClient | null = null;
  registerProcessHandlers({
    getClient: () => client,
    releaseLocks: async () => {
      await releaseSharedTokenLock().catch(() => null);
      await releaseInstanceLock().catch(() => null);
    },
  });

  try {
    // Discards any cache directory a previous process quarantined but did not finish deleting.
    purgeQuarantinedBotRxStorage();
    startEventLoopLagMonitor();
    await assertTrackerKvPersistentStorage();
    registerBotRunInboundChangeHandler(({ userId, runs }) => {
      logger.debug('[rxdb] inbound run store updated', { userId, count: runs.length });
    });
    const kvStatus = await getTrackerKvStorageStatus();
    logger.info('Tracker KV storage initialized', kvStatus);
    await cleanupStalePendingRuns();

    client = new TrackerBotClient(
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
  } catch (error) {
    await releaseSharedTokenLock().catch(() => null);
    await releaseInstanceLock().catch(() => null);
    throw error;
  }
}

void bootstrap().catch(error => {
  logger.error('Failed to bootstrap tracker bot', error);
  // Locks are released above; exit explicitly so pm2 restarts instead of the process
  // lingering on whatever handles were opened before the failure.
  process.exit(1);
});
