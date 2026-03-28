import type { Client } from 'discord.js';
import { z } from 'zod';
import type { AppConfig } from '../config';

export const BotBootstrapRuntimeSchema = z.object({
  deploymentMode: z.enum(['dev', 'prod']),
  loginToken: z.string().min(1),
  clientId: z.string().min(1),
  registrationGuildId: z.string().min(1).optional(),
});

export type BotBootstrapRuntime = z.infer<typeof BotBootstrapRuntimeSchema>;

export function validateBotBootstrapConfig(appConfig: AppConfig): BotBootstrapRuntime {
  return BotBootstrapRuntimeSchema.parse({
    deploymentMode: appConfig.deploymentMode,
    loginToken: appConfig.discord.token,
    clientId: appConfig.discord.clientId,
    registrationGuildId: appConfig.discord.guildId,
  });
}

export function createBotBootstrapContext<TClient extends Client>(client: TClient, appConfig: AppConfig) {
  return {
    client,
    appConfig,
    runtime: validateBotBootstrapConfig(appConfig),
  };
}