import { createAppwriteClient } from './appwrite-client';
import { GuildsRepo } from './guilds-repo';
import { UsersRepo } from './users-repo';
import { AnalyticsRepo } from './analytics-repo';
import { ConfigsRepo } from './configs-repo';
import { runAppwriteAccessDiagnostics } from './appwrite-access-diagnostics';

export interface Persistence {
  guilds: GuildsRepo;
  users: UsersRepo;
  analytics: AnalyticsRepo;
  configs: ConfigsRepo;
}

export function createPersistence(): Persistence {
  const { databases } = createAppwriteClient();
  runAppwriteAccessDiagnostics(databases);
  return {
    guilds: new GuildsRepo(databases),
    users: new UsersRepo(databases),
    analytics: new AnalyticsRepo(databases),
    configs: new ConfigsRepo(databases),
  };
}
