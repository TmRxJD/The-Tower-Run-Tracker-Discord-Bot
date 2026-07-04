import {

  applyBotsTrackerImportPayloadToSnapshot,

  buildBattleRunDedupKeysFromStoredRun,

  buildBotsTrackerLocalPersistPayload,

  canonicalizeTrackerRunData,

  normalizeBotsTrackerLocalSnapshot,

  normalizeWorkshopTrackerPayload,

  type SaveImportPersistencePort,

} from '@tmrxjd/platform/tools';

import {

  getBotsTrackerLocalState,

  saveBotsTrackerLocalState,

} from '../../../services/bots-tracker-db';

import { getTrackerKv, setTrackerKv } from '../../../services/idb';

import { invalidateBotLocalRunsCache } from '../../../rxdb/run-rxdb-store';

import { bulkUpsertLocalRuns, getLocalRuns, getLocalSettings, queueCloudUpsertsBatch } from '../local-run-store';

import { forceSyncQueuedRuns, saveLifetimeEntry } from '../tracker-api-client';

import type { MessageComponentInteraction, ModalSubmitInteraction } from 'discord.js';



type TrackMenuInteraction = MessageComponentInteraction | ModalSubmitInteraction;



const TRACKER_DOMAIN_PREFIX = 'tracker-domain-import:';



type DomainRecord = {

  state: Record<string, unknown>;

  updatedAt: number;

};



async function loadDomainState(userId: string, trackerKey: string): Promise<Record<string, unknown>> {

  const stored = await getTrackerKv<DomainRecord>(`${TRACKER_DOMAIN_PREFIX}${trackerKey}:${userId}`);

  return stored?.state ?? {};

}



async function saveDomainState(userId: string, trackerKey: string, state: Record<string, unknown>): Promise<void> {

  await setTrackerKv(`${TRACKER_DOMAIN_PREFIX}${trackerKey}:${userId}`, {

    state,

    updatedAt: Date.now(),

  } satisfies DomainRecord);

}



function mergePayloadIntoState(

  current: Record<string, unknown>,

  payload: Record<string, unknown>,

): Record<string, unknown> {

  return { ...current, ...payload };

}



function asRecord(value: unknown): Record<string, unknown> {

  return value as Record<string, unknown>;

}



export function createDiscordSaveImportPort(

  interaction: TrackMenuInteraction,

): SaveImportPersistencePort {

  const userId = interaction.user.id;

  const username = interaction.user.username;



  return {

    persistBattleReports: async (plan) => {

      invalidateBotLocalRunsCache(userId);

      const existingRuns = await getLocalRuns(userId);

      const existingKeys = new Set<string>();

      for (const run of existingRuns) {

        for (const key of buildBattleRunDedupKeysFromStoredRun(run as Record<string, unknown>)) {

          existingKeys.add(key);

        }

      }



      const importable = plan.importable.filter(run => {

        const candidateKeys = buildBattleRunDedupKeysFromStoredRun(run as Record<string, unknown>);

        return !candidateKeys.some(key => existingKeys.has(key));

      });



      if (!importable.length) {

        return { added: 0, updated: plan.importable.length };

      }



      const payload = importable.map(run => ({

        username,

        runData: canonicalizeTrackerRunData(run),

      }));

      const result = await bulkUpsertLocalRuns(userId, payload);



      const settings = await getLocalSettings(userId);

      if (settings.cloudSyncEnabled !== false) {

        const cloudBatch = payload.flatMap((item, index) => {

          if (result.wasUpdates[index]) return [];

          const savedLocalId = result.records[index]?.localId;

          return [{

            userId,

            username,

            localId: savedLocalId,

            runData: savedLocalId ? { ...item.runData, localId: savedLocalId } : item.runData,

            canonicalRunData: item.runData,

          }];

        });



        if (cloudBatch.length > 0) {

          await queueCloudUpsertsBatch(cloudBatch).catch(() => {});

          forceSyncQueuedRuns(userId).catch(() => {});

        }

      }



      return {

        added: result.added,

        updated: result.updated + (plan.importable.length - importable.length),

      };

    },



    persistLifetime: async (payload) => {

      await saveLifetimeEntry({

        userId,

        username,

        entryData: asRecord(payload),

      });

    },



    persistWorkshop: async (payload) => {

      const current = normalizeWorkshopTrackerPayload(await loadDomainState(userId, 'workshop'));

      const next = normalizeWorkshopTrackerPayload(mergePayloadIntoState(current, asRecord(payload)));

      await saveDomainState(userId, 'workshop', next);

    },



    persistLabs: async (payload) => {

      const current = await loadDomainState(userId, 'labs');

      await saveDomainState(userId, 'labs', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistUltimateWeapons: async (payload) => {

      const current = await loadDomainState(userId, 'ultimateWeapons');

      await saveDomainState(userId, 'ultimateWeapons', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistModules: async (payload) => {

      const current = await loadDomainState(userId, 'modules');

      await saveDomainState(userId, 'modules', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistCards: async (payload) => {

      const current = await loadDomainState(userId, 'cards');

      await saveDomainState(userId, 'cards', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistVault: async (payload) => {

      const current = await loadDomainState(userId, 'vault');

      await saveDomainState(userId, 'vault', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistBots: async (payload) => {

      const current = normalizeBotsTrackerLocalSnapshot(await getBotsTrackerLocalState(userId));

      const merged = applyBotsTrackerImportPayloadToSnapshot(current, payload);

      await saveBotsTrackerLocalState(userId, buildBotsTrackerLocalPersistPayload(merged));

    },



    persistGuardians: async (payload) => {

      const current = await loadDomainState(userId, 'guardians');

      await saveDomainState(userId, 'guardians', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistRelics: async (payload) => {

      const current = await loadDomainState(userId, 'relics');

      await saveDomainState(userId, 'relics', mergePayloadIntoState(current, asRecord(payload)));

    },



    persistDissonance: async (_payload, parsedRoot) => {

      const current = await loadDomainState(userId, 'dissonance');

      await saveDomainState(userId, 'dissonance', {

        ...current,

        parsedRootSnapshot: parsedRoot,

        syncedAt: Date.now(),

      });

    },

  };

}


