import {describe,expect,it,vi} from 'vitest';
vi.mock('../../services/idb',()=>({
 getTrackerKv:async()=>({version:1,users:{},queue:[
  {id:'alt',op:'upsert',userId:'fixture',username:'fixture',localId:'a',runData:{localId:'a'},uploadProfileId:'alt-a'},
  {id:'main',op:'upsert',userId:'fixture',username:'fixture',localId:'b',runData:{localId:'b'},uploadProfileId:null},
  {id:'unknown',op:'upsert',userId:'fixture',username:'fixture',localId:'c',runData:{localId:'c'}},
 ].map(item=>({...item,createdAt:1,retryCount:0,nextRetryAt:1}))}),setTrackerKv:vi.fn()
}));
import {getQueueItems} from './local-run-store';
describe('queue restart profile metadata',()=>{
 it('keeps explicit alt, Main and unknown distinct after persisted hydration',async()=>{
  const q=await getQueueItems('fixture');
  expect(q.map(x=>x.uploadProfileId)).toEqual(['alt-a',null,undefined]);
 });
});
