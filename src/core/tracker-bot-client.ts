import { Client, ClientOptions } from 'discord.js';
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
  }
}
