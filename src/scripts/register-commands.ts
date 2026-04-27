import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { ZodError } from 'zod';
import { commandModules } from '../commands';
import { validateBotBootstrapConfig } from '../core/bootstrap-contract';
import { logger } from '../core/logger';
import { getAppConfig, loadConfig } from '../config';

type RegisterCommandOptions = {
  deploymentMode?: 'dev' | 'prod';
  guildId?: string;
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
  const body = commandModules.map((command: { data: unknown }) => command.data);
  const targetGuildIds = await resolveTargetGuildIds(runtime.loginToken, options.guildId);

  logger.info(`Preparing command registration for ${runtime.deploymentMode} mode`);

  logger.info('Clearing global commands to avoid duplicate guild/global command entries');
  await rest.put(Routes.applicationCommands(runtime.clientId), { body: [] });

  for (const guildId of targetGuildIds) {
    logger.info(`Registering ${body.length} guild commands to ${guildId}`);
    await rest.put(Routes.applicationGuildCommands(runtime.clientId, guildId), { body });
  }

  logger.info(`Slash commands refreshed across ${targetGuildIds.length} guild(s)`);
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
    client.destroy();
  }
}

registerCommands().catch(error => {
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
