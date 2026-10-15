import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('retains baseline and delivered IDs across separate Node processes with real SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-updates-restart-'));
  const env = { ...process.env, TRACKER_BOT_DATA_DIR: directory, TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK: 'false' };
  const script = `
    const {mirrorPublishedUpdates}=require('./src/features/website-updates/mirror');
    const {parsePublishedUpdates}=require('./src/features/website-updates/source');
    const {getTrackerKv,setTrackerKv}=require('./src/services/idb');
    const store={load:()=>getTrackerKv('fixture-mirror'),save:s=>setTrackerKv('fixture-mirror',s,{requirePersistent:true})};
    const releases=v=>parsePublishedUpdates('# Update v'+v+'\\n**October 15, 2026**\\n\\nContent.');
    let sends=0;
    const delivery={send:async()=>{sends++;return '1400000000000000001'},recover:async()=>null,edit:async()=>{},remove:async()=>{}};
    (async()=>{
      if(process.argv[1]==='first') {
        await mirrorPublishedUpdates(releases('1.0.0'),store,delivery);
        await mirrorPublishedUpdates(releases('2.0.0'),store,delivery);
        if(sends!==1)throw Error('first send count');
      } else {
        await mirrorPublishedUpdates(releases('2.0.0'),store,delivery);
        if(sends!==0)throw Error('restart replayed');
        const state=await store.load();if(!Object.values(state.entries).some(x=>x.parts[0]?.messageId==='1400000000000000001'))throw Error('missing ID');
      }
      console.log('VERIFIED');process.exit(0);
    })().catch(e=>{console.error(e.message);process.exit(1)});
  `;
  for (const mode of ['first', 'restart']) {
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script, mode], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15_000 });
    expect(output).toContain('VERIFIED');
  }
}, 35_000);
