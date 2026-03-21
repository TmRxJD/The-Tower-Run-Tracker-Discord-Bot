import { Databases, Query } from 'node-appwrite';
import { getAppConfig } from '../config';
import { logger } from '../core/logger';
import { isUnauthorizedAppwriteError } from './appwrite-error-utils';

interface AccessCheck {
  databaseId: string;
  collectionId: string;
  label: string;
}

let hasRun = false;

function getChecks(): AccessCheck[] {
  const cfg = getAppConfig();
  return [
    {
      databaseId: cfg.appwrite.databaseId,
      collectionId: cfg.appwrite.analyticsCollectionId,
      label: 'analytics',
    },
    {
      databaseId: cfg.appwrite.databaseId,
      collectionId: cfg.appwrite.userSettingsCollectionId,
      label: 'user_settings',
    },
    {
      databaseId: cfg.appwrite.runsDatabaseId,
      collectionId: cfg.appwrite.runsCollectionId,
      label: 'runs',
    },
    {
      databaseId: cfg.appwrite.settingsDatabaseId,
      collectionId: cfg.appwrite.settingsCollectionId,
      label: 'settings',
    },
    {
      databaseId: cfg.appwrite.lifetimeDatabaseId,
      collectionId: cfg.appwrite.lifetimeCollectionId,
      label: 'lifetime',
    },
  ];
}

export function runAppwriteAccessDiagnostics(databases: Databases): void {
  const cfg = getAppConfig();
  if (cfg.deploymentMode !== 'dev' || hasRun) {
    return;
  }

  hasRun = true;

  void (async () => {
    const checks = getChecks();
    const failed: AccessCheck[] = [];
    let nonAuthIssueCount = 0;

    for (const check of checks) {
      try {
        await databases.listDocuments(check.databaseId, check.collectionId, [Query.limit(1)]);
      } catch (error) {
        if (isUnauthorizedAppwriteError(error)) {
          failed.push(check);
          continue;
        }

        logger.warn('Appwrite diagnostics encountered a non-auth error', {
          check,
          code: (error as { code?: unknown }).code,
          type: (error as { type?: unknown }).type,
        });
        nonAuthIssueCount += 1;
      }
    }

    if (failed.length === 0 && nonAuthIssueCount === 0) {
      logger.info('Appwrite diagnostics: all required dev collections are accessible');
      return;
    }

    if (failed.length === 0 && nonAuthIssueCount > 0) {
      logger.warn('Appwrite diagnostics: no auth failures detected, but some non-auth Appwrite issues were found');
      return;
    }

    logger.error('Appwrite diagnostics: dev key is loaded but lacks access to required collections', {
      endpoint: cfg.appwrite.endpoint,
      projectId: cfg.appwrite.projectId,
      missing: failed.map(item => `${item.databaseId}/${item.collectionId}`),
      hint: 'Verify API key project + scopes include databases.read/databases.write for these collections',
    });
  })();
}
