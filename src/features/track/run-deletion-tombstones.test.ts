import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({value:[] as string[],fail:false}));
vi.mock('../../services/idb',()=>({
 getTrackerKv:async()=>{if(m.fail)throw Error('fixture storage failure');return [...m.value];},
 setTrackerKv:async(_key:string,value:string[])=>{if(m.fail)throw Error('fixture storage failure');await Promise.resolve();m.value=value;}
}));
import {getPermanentlyDeletedRunIds,markRunPermanentlyDeleted} from './run-deletion-tombstones';
describe('durable deletion receipts',()=>{
 beforeEach(()=>{m.value=[];m.fail=false;});
 it('keeps all concurrent deletion receipts instead of last-write-wins',async()=>{
  await Promise.all(['a','b','c'].map(id=>markRunPermanentlyDeleted('fixture',id)));
  expect([...await getPermanentlyDeletedRunIds('fixture')].sort()).toEqual(['a','b','c']);
 });
 it('propagates storage errors so removal cannot claim a durable receipt',async()=>{
  m.fail=true;
  await expect(markRunPermanentlyDeleted('fixture','d')).rejects.toThrow('storage failure');
 });
});
