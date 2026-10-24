import type { ClientOptions } from 'discord.js';
import { Client } from 'discord.js';
import { recordDiagnostic } from './diagnostics';
import { performanceTraceIdentity } from './performance-trace';
import type { AppConfig } from '../config';
import { CommandRegistry } from './command-registry';
import { ComponentRegistry } from './component-registry';
import type { Persistence } from '../persistence';

export class TrackerBotClient extends Client {
  public readonly commands = new CommandRegistry();
  public readonly components = new ComponentRegistry();
  public readonly appConfig: AppConfig;
  public persistence?: Persistence;

  constructor(options: ClientOptions, appConfig: AppConfig) {
    super(options);
    this.appConfig = appConfig;
    // Omit routes, URLs, bucket hashes and major parameters (including webhook tokens).
    this.rest.on('rateLimited', info => recordDiagnostic('discord.rest.rate_limit', {
      ...performanceTraceIdentity(),
      global: info.global, retryAfterMs: info.retryAfter,
      timeToResetMs: info.timeToReset, sublimitTimeoutMs: info.sublimitTimeout,
    }));
  }
}
