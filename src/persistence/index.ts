import type { Databases } from 'node-appwrite';
import { getAppConfig } from '../config';
import { createAppwriteClient } from './appwrite-client';
import { GuildsRepo } from './guilds-repo';
import { UsersRepo } from './users-repo';
import { AnalyticsRepo } from './analytics-repo';
import { runAppwriteAccessDiagnostics } from './appwrite-access-diagnostics';

export interface Persistence {
  guilds: GuildsRepo;
  users: UsersRepo;
  analytics: AnalyticsRepo;
}

export function createPersistence(): Persistence {
  const cfg = getAppConfig();
  const hasAppwriteCredential = Boolean(
    cfg.appwrite.apiKey?.trim()
    || process.env.APPWRITE_JWT?.trim()
    || process.env.APPWRITE_SESSION?.trim()
  );

  let databases: Databases | null = null;
  if (hasAppwriteCredential) {
    databases = createAppwriteClient().databases;
    runAppwriteAccessDiagnostics(databases);
  }

  return {
    guilds: new GuildsRepo(databases),
    users: new UsersRepo(databases),
    analytics: new AnalyticsRepo(databases),
  };
}
