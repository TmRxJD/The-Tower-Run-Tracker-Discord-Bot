import { expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('retains acknowledged queue, original target and share after abrupt process termination and UI eviction', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tracker-ack-restart-'));
  const env = { ...process.env, TRACKER_BOT_DATA_DIR: dataDir, TRACKER_BOT_ALLOW_MEMORY_KV_FALLBACK: 'false', TRACKER_BOT_RXDB_STORAGE: 'memory' };
  const alias = `const mod=require('node:module'),path=require('node:path'),fs=require('node:fs');const original=mod._resolveFilename;mod._resolveFilename=function(request,...args){if(request==='@tmrxjd/platform/tools'&&fs.existsSync(path.resolve('platform-audit/dist/tools/index.js')))request=path.resolve('platform-audit/dist/tools/index.js');return original.call(this,request,...args);};`;
  const writer = spawn(process.execPath, ['-e', `
    ${alias}
    (async()=>{
      const q=require('./dist/features/track/local-run-store');
      const p=require('./dist/features/track/run-local-provenance');
      const s=require('./dist/features/track/share/share-snapshot-store');
      const ui=require('./dist/features/track/share/share-state');
      await q.updateLocalSettings('fixture-offline-crash',{cloudSyncEnabled:false});
      await require('./dist/features/track/tracker-api-client').logRun({userId:'fixture-offline-crash',username:'fixture',uploadProfileId:'alt-crash-original',runData:{localId:'offline-crash-local',tier:'5',wave:'321',totalCoins:'2B',totalCells:'3K',totalDice:0,roundDuration:'1h'}});
      await p.rememberOriginalRunTarget('fixture-durable','local-1','alt-original');
      await p.rememberOriginalRunTarget('fixture-durable','local-1','alt-later');
      await q.queueCloudUpsert({automaticRecovery:true,duplicateCheckPending:true,userId:'fixture-durable',username:'fixture',localId:'local-1',runData:{localId:'local-1',totalCoins:0},uploadProfileId:'alt-original'});
      if(!await s.saveShareSnapshot({ref:'fixture-snapshot',userId:'fixture-durable',run:{totalCoins:0},runTypeCounts:{Farming:7},sharerName:'fixture'})) throw Error('snapshot failed');
      ui.setShareableRun('fixture-durable',{run:{totalCoins:0},runTypeCounts:{Farming:7}});
      for(let i=0;i<1100;i++)ui.setShareableRun('churn-'+i,{run:{},runTypeCounts:{}});
      if(ui.getShareableRun('fixture-durable')!==null)throw Error('UI cache not evicted');
      await require('./dist/features/track/run-history-snapshot').saveVerifiedHistorySnapshot('fixture-durable',[{$id:'cloud-1',userId:'fixture-durable',type:'Farming',tier:'5',wave:'123',coins:'100',duration:'1h',runDate:'2026-10-18',runTime:'01:00'}]);
      process.stdout.write('ACK\\n');setInterval(()=>{},1000);
    })().catch(()=>process.exit(2));
  `], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Isolated durable writer timed out')), 10_000);
      writer.stdout.on('data', data => { if (String(data).includes('ACK')) { clearTimeout(timeout); resolve(); } });
      writer.on('exit', code => { clearTimeout(timeout); reject(new Error(`Isolated writer exited before acknowledgement (${code})`)); });
    });
  } finally { writer.kill('SIGKILL'); }
  await new Promise<void>(resolve => writer.exitCode !== null ? resolve() : writer.once('exit', () => resolve()));
  const result = await promisify(execFile)(process.execPath, ['-e', `
    ${alias}
    (async()=>{
      const q=await require('./dist/features/track/local-run-store').getQueueItems('fixture-durable');
      const p=await require('./dist/features/track/run-local-provenance').getOriginalRunTarget('fixture-durable','local-1');
      const s=await require('./dist/features/track/share/share-snapshot-store').readShareSnapshot('fixture-snapshot');
      if(q.length!==1||q[0].duplicateCheckPending!==true||q[0].automaticRecovery!==true||q[0].uploadProfileId!=='alt-original'||p.profileId!=='alt-original'||s.run.totalCoins!==0||s.runTypeCounts.Farming!==7)throw Error('restart mismatch');
      await require('./dist/rxdb/local-only-backup').restoreLocalOnlyRuns();
      const offline=await require('./dist/features/track/local-run-store').getLocalRuns('fixture-offline-crash');
      const target=await require('./dist/features/track/run-local-provenance').getOriginalRunTarget('fixture-offline-crash','offline-crash-local');
      if(offline.length!==1||offline[0].localId!=='offline-crash-local'||offline[0].runId||offline[0].totalCoins!=='2B'||offline[0].totalCells!=='3K'||Number(offline[0].totalDice)!==0||target.profileId!=='alt-crash-original')throw Error('offline restart mismatch');
      const view=await require('./dist/features/track/run-upload-history').prepareBotRunUploadHistory('fixture-durable',{localFirst:true,localOnly:true});
      const pendingRows=await view.getRuns();
      if(view.verified!==false||view.completeLocal!==true||pendingRows.length!==2||!pendingRows.some(row=>row.localId==='local-1'&&Number(row.totalCoins)===0)||!pendingRows.some(row=>row.runId==='cloud-1'))throw Error('pending offline view lost');
      process.stdout.write('VERIFIED');process.exit(0);
    })().catch(()=>process.exit(3));
  `], { cwd: process.cwd(), env, timeout: 10_000 });
  expect(result.stdout).toContain('VERIFIED');
}, 25_000);
