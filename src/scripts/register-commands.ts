import { REST, Routes } from 'discord.js';
import { ZodError } from 'zod';
import { commandModules } from '../commands';
import { logger } from '../core/logger';
import { getAppConfig, loadConfig } from '../config';

type RegisterCommandOptions = {
  deploymentMode?: 'dev' | 'prod';
  forceGlobal: boolean;
  guildId?: string;
};

function parseRegisterCommandOptions(argv: string[]): RegisterCommandOptions {
  const options: RegisterCommandOptions = {
    forceGlobal: false,
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

    if (arg === '--global') {
      options.forceGlobal = true;
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

  const rest = new REST({ version: '10' }).setToken(appConfig.discord.token);
  const body = commandModules.map((command: { data: unknown }) => command.data);
  const targetGuildId = options.forceGlobal ? undefined : (options.guildId ?? appConfig.discord.guildId);

  logger.info(`Preparing command registration for ${appConfig.deploymentMode} mode`);

  if (targetGuildId) {
    logger.info(`Registering ${body.length} guild commands to ${targetGuildId}`);
    await rest.put(Routes.applicationGuildCommands(appConfig.discord.clientId, targetGuildId), { body });
  } else {
    logger.info(`Registering ${body.length} global commands`);
    await rest.put(Routes.applicationCommands(appConfig.discord.clientId), { body });
  }

  logger.info('Slash commands refreshed');
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
