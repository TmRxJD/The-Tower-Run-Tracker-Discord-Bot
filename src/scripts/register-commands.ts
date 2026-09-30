import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { ZodError } from 'zod';
import { getSlashCommandRegistrationPayload } from '../commands/slash-command-data';
import { validateBotBootstrapConfig } from '../core/bootstrap-contract';
import { logger } from '../core/logger';
import { getAppConfig, loadConfig } from '../config';
import {
  hashCommandPayload,
  isRegistrationCurrent,
  registrationStatePath,
  writeRegistrationState,
} from './command-registration-state';

type RegisterCommandOptions = {
  deploymentMode?: 'dev' | 'prod';
  guildId?: string;
  /** Register even if the command payload matches the last successful registration. */
  force?: boolean;
};

function parseRegisterCommandOptions(argv: string[]): RegisterCommandOptions {
  const options: RegisterCommandOptions = {
  };

  for (const arg of argv) {
    if (arg === '--prod') {
      options.deploymentMode = 'prod';
      continue;
    }

    if (arg === '--dev') {
      options.deploymentMode = 'dev';
      continue;
    }

    if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      if (mode === 'dev' || mode === 'prod') {
        options.deploymentMode = mode;
      }
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg.startsWith('--guild-id=')) {
      const guildId = arg.slice('--guild-id='.length).trim();
      if (guildId) {
        options.guildId = guildId;
      }
    }
  }

  return options;
}

async function registerCommands() {
  const options = parseRegisterCommandOptions(process.argv.slice(2));
  if (options.deploymentMode) {
    process.env.DEPLOYMENT_MODE = options.deploymentMode;
  }

  loadConfig();
  const appConfig = getAppConfig();
  const runtime = validateBotBootstrapConfig(appConfig);

  const rest = new REST({ version: '10' }).setToken(runtime.loginToken);
  const body = getSlashCommandRegistrationPayload();
  const isProd = runtime.deploymentMode === 'prod';

  const payloadHash = hashCommandPayload(body, `${runtime.clientId}:${runtime.deploymentMode}`);
  const statePath = registrationStatePath(runtime.deploymentMode);
  // Checked before logging in or touching any guild: with the bot in many servers, that
  // work is what makes registration slow, and most deploys change no commands. console.log
  // rather than logger because these scripts run at the error log level.
  if (!options.force && !options.guildId && await isRegistrationCurrent(statePath, payloadHash)) {
    console.log(`Slash commands unchanged since the last registration (${body.length} commands); skipping. Use --force to register anyway.`);
    return;
  }

  logger.info(`Preparing command registration for ${runtime.deploymentMode} mode`);

  if (isProd) {
    // Prod: register globally so commands work in every server the bot joins,
    // including new servers added after deployment. Clear all guild-scoped
    // overrides first to prevent duplicates.
    const targetGuildIds = await resolveTargetGuildIds(runtime.loginToken, options.guildId);
    for (const guildId of targetGuildIds) {
      logger.info(`Clearing guild-scoped commands from ${guildId}`);
      await rest.put(Routes.applicationGuildCommands(runtime.clientId, guildId), { body: [] });
    }
    logger.info(`Registering ${body.length} global commands`);
    await rest.put(Routes.applicationCommands(runtime.clientId), { body });
    logger.info('Global slash commands registered — changes propagate within ~1 hour');
  } else {
    // Dev: register guild-scoped for instant propagation. Clear global commands
    // to prevent duplicates if the app previously had global commands registered.
    logger.info('Clearing global commands to avoid duplicate guild/global command entries');
    await rest.put(Routes.applicationCommands(runtime.clientId), { body: [] });
    const targetGuildIds = await resolveTargetGuildIds(runtime.loginToken, options.guildId);
    for (const guildId of targetGuildIds) {
      logger.info(`Registering ${body.length} guild commands to ${guildId}`);
      await rest.put(Routes.applicationGuildCommands(runtime.clientId, guildId), { body });
    }
    logger.info(`Slash commands refreshed across ${targetGuildIds.length} guild(s)`);
  }

  // A single-guild run only covers that guild, so it must not mark everything as registered.
  if (!options.guildId) {
    await writeRegistrationState(statePath, payloadHash, body.length);
  }
  console.log(`Registered ${body.length} slash commands.`);
}

async function resolveTargetGuildIds(loginToken: string, explicitGuildId?: string): Promise<string[]> {
  if (explicitGuildId) {
    return [explicitGuildId];
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(loginToken);
    const guilds = await client.guilds.fetch();
    const guildIds = [...guilds.keys()].sort((left, right) => left.localeCompare(right));
    if (guildIds.length === 0) {
      throw new Error('The bot is not currently in any guilds, so there are no commands to register.');
    }
    return guildIds;
  } finally {
    await client.destroy();
  }
}

void registerCommands().catch(error => {
  if (error instanceof ZodError) {
    logger.error('Failed to register commands: invalid environment configuration', error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
    })));
    process.exitCode = 1;
    return;
  }

  logger.error('Failed to register commands', error);
  process.exitCode = 1;
});
