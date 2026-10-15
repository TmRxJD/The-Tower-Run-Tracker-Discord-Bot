import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodePlayerInfoSaveBytes } from '@tmrxjd/platform/node';
import { executeSaveImports, planSaveImportTarget } from '@tmrxjd/platform/tools';
import fixtures from './save-format-fixtures.json';

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../services/idb', () => ({
  getTrackerKv: async (key: string) => state.get(key),
  setTrackerKv: async (key: string, value: unknown) => { state.set(key, value); },
}));
vi.mock('../../../services/bots-tracker-db', () => ({ getBotsTrackerLocalState: vi.fn(), saveBotsTrackerLocalState: vi.fn() }));
vi.mock('../../../rxdb/run-rxdb-store', () => ({ invalidateBotLocalRunsCache: vi.fn() }));
vi.mock('../local-run-store', () => ({ getLocalRuns: vi.fn(), getLocalSettings: vi.fn(), bulkUpsertLocalRuns: vi.fn(), queueCloudUpsertsBatch: vi.fn() }));
vi.mock('../tracker-api-client', () => ({ forceSyncQueuedRuns: vi.fn(), saveLifetimeEntry: vi.fn() }));
vi.mock('../run-local-provenance', () => ({ rememberOriginalRunTarget: vi.fn() }));
vi.mock('../../../rxdb/local-only-backup', () => ({ backupLocalOnlyRunsNow: vi.fn() }));
import { createDiscordSaveImportPort } from './save-import-port';

const decode = (root: Record<string, unknown>) => decodePlayerInfoSaveBytes(Buffer.from(JSON.stringify(root))).parsedRoot;
const port = (root?: Record<string, unknown>) => createDiscordSaveImportPort({ user: { id: 'synthetic', username: 'fixture' } } as never, null, root);
const key = (domain: string) => `tracker-domain-import:${domain}:synthetic`;
const stored = (domain: string) => (state.get(key(domain)) as {state: Record<string, unknown>}).state;
beforeEach(() => state.clear());

describe('published SDK save compatibility through the deployed platform entry point', () => {
  it.each(['binary', 'gzip', 'encrypted'] as const)('keeps legacy %s saves readable', format => {
    const result = decodePlayerInfoSaveBytes(Buffer.from(fixtures[format], 'base64'));
    expect(result.parsedRoot).toMatchObject({ versionNumber: 2910, researchLevel: [7, 0] });
    expect(planSaveImportTarget('labs', result.parsedRoot).canImport).toBe(true);
  });
  it('normalizes JSON, nested values, BOM and gzip JSON with the same byte API', () => {
    const raw = { VersionNumber: 2910, ResearchLevel: [7, 0], ModuleInventory: [{ Guid: 'synthetic', InfoIndex: 9, Level: 1 }], BattleHistory: [{ Tier: 8, Wave: 1234, CoinsEarned: 1e10, BattleDate: '2026-10-13T12:00:00Z' }] };
    const bytes = Buffer.from('\uFEFF \n'+JSON.stringify(raw));
    const result = decodePlayerInfoSaveBytes(bytes);
    expect(result.parsedRoot.inventory).toEqual([{ guid: 'synthetic', infoIndex: 9, level: 1 }]);
    expect(result.battleRunCount).toBe(1);
    expect(decodePlayerInfoSaveBytes(gzipSync(bytes)).parsedRoot).toEqual(result.parsedRoot);
  });
  it.each(['', '[]', '{}', '{"hello":1}', '{"ResearchLevel":["wrong"]}', '{"VersionNumber":1,', '{"ResearchLevel":[1],"__proto__":{}}', '{"VersionNumber":1,"versionNumber":2,"ResearchLevel":[1]}'])('rejects malformed or unrelated input (%s)', text => {
    expect(() => decodePlayerInfoSaveBytes(Buffer.from(text))).toThrow();
    expect(state.size).toBe(0);
  });
  it('rejects corrupt and truncated encrypted inputs', () => {
    const bytes=Buffer.from(fixtures.encrypted,'base64'); bytes[60]^=1;
    expect(() => decodePlayerInfoSaveBytes(bytes)).toThrow(/integrity/);
    expect(() => decodePlayerInfoSaveBytes(bytes.subarray(0,30))).toThrow();
  });
  it('preserves omitted queues, favorites and partial level maps through the actual persistence port', async () => {
    const root=decode({ResearchLevel:[7,0],LabLevel:[1,1]});
    const plan=planSaveImportTarget('labs',root);
    if(plan.payload?.key!=='labs')throw Error('Missing labs plan');
    const names=Object.keys(plan.payload.payload.currentLabLevels);
    expect(Object.values(plan.payload.payload.currentLabLevels)).toContain(0);
    const activeSlots=[{name:'retained',running:true}],labSpeedUps={retained:3},favoriteLabs=['retained'];
    state.set(key('labs'),{state:{activeSlots,labSpeedUps,favoriteLabs,currentLabLevels:{retained:9,[names[1]]:12}}});
    const outcomes=await executeSaveImports({parsedRoot:root,selectedKeys:['labs'],port:port(root)});
    expect(outcomes[0].status).toBe('imported');
    expect(stored('labs')).toMatchObject({activeSlots,labSpeedUps,favoriteLabs,currentLabLevels:{retained:9,[names[1]]:0}});
  });
  it('still replaces explicitly supplied inactive lab queues', async () => {
    const root=decode({ResearchLevel:[7],LabLevel:[1],LabResearchInt:[0],LabActiveBool:[false]});
    state.set(key('labs'),{state:{activeSlots:[{name:'old',running:true}]}});
    await executeSaveImports({parsedRoot:root,selectedKeys:['labs'],port:port(root)});
    expect(stored('labs').activeSlots).not.toEqual([{name:'old',running:true}]);
  });
  it('reads primary and assist levels without a migration flag and preserves missing slots', async () => {
    const root=decode({ResearchLevel:[1],SlotLevels:[101],ModuleEquipped:[{InfoIndex:9,CurrentRarity:15,Level:0}],AssistModuleSlots:[{Type:0,Level:43,EquippedModule:{InfoIndex:9,CurrentRarity:15,Level:0}}]});
    const plan=planSaveImportTarget('modules',root);
    if(plan.payload?.key!=='modules')throw Error('Missing modules plan');
    const slots=plan.payload.payload.equipped!.slots;
    expect(Object.values(slots).map(slot=>slot!.level)).toEqual([101,43]);
    state.set(key('modules'),{state:{inventory:[{moduleId:'keep'}],equipped:{slots:{'retained-slot':{level:91}}}}});
    await executeSaveImports({parsedRoot:root,selectedKeys:['modules'],port:port(root)});
    expect(stored('modules')).toMatchObject({inventory:[{moduleId:'keep'}],equipped:{slots:{...slots,'retained-slot':{level:91}}}});
  });
  it('retains explicitly migrated zero module levels', () => {
    const root=decode({ResearchLevel:[1],HasMigratedModuleLevelsToSlots:true,SlotLevels:[0],ModuleEquipped:[{InfoIndex:9,CurrentRarity:15,Level:17}]});
    const plan=planSaveImportTarget('modules',root);
    if(plan.payload?.key!=='modules')throw Error('Missing modules plan');
    expect(Object.values(plan.payload.payload.equipped!.slots)[0]?.level).toBe(0);
  });
  it('does not invent synchronicity flags when absent or unknown; explicit empty state clears flags', () => {
    const base={ResearchLevel:[1],BotsUnlocked:[true],BotsLevel:[1,1,1,1]};
    const payload=(extra:Record<string,unknown>)=>{const p=planSaveImportTarget('bots',decode({...base,...extra}));if(p.payload?.key!=='bots')throw Error('Missing bots plan');return p.payload.payload;};
    expect(payload({}).syncUnlocked).toBeUndefined();
    expect(payload({SynchronicityUnlocked:true,SynchronicityBots:[99999,null]}).syncUnlocked).toBeUndefined();
    expect(Object.values(payload({SynchronicityUnlocked:false,SynchronicityBots:[]}).syncUnlocked!)).not.toContain(true);
  });
});
