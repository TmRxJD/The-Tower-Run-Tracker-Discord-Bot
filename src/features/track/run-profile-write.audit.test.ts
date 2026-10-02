import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({get:vi.fn(),update:vi.fn(),create:vi.fn()}));
vi.mock('../../persistence/appwrite-client',()=>({createAppwriteClient:()=>({databases:{getDocument:m.get,updateDocument:m.update,createDocument:m.create}})}));
vi.mock('./run-cloud-identity',()=>({resolveBotRunCloudIdentity:async()=>({cloudWriteUserId:'fixture-owner',activeUserId:'fixture-owner',lookupUserIds:['fixture-owner','fixture-discord'],permissionUserIds:['fixture-owner']})}));
import { writeTrackerRunCloudDocumentPair } from '@tmrxjd/platform/tools';
import { writeBotRunCloudDocumentPair } from './run-cloud-pair-client';
import { setPendingUploadProfile } from './upload-target-profile';
const params={userId:'fixture-discord',username:'fixture',runId:'fixture-run',run:{totalCoins:'2B',totalCells:0,totalDice:0,wave:'100',tier:'1',roundDuration:'1h'}};
describe('immutable upload target and verified existence',()=>{
 beforeEach(()=>{vi.resetAllMocks();m.get.mockRejectedValue({code:404,type:'document_not_found'});m.update.mockResolvedValue({});m.create.mockResolvedValue({});});
 it('uses the captured target even after another session changes the carrier',async()=>{
  setPendingUploadProfile('fixture-discord','fixture-alt-b');
  await writeBotRunCloudDocumentPair({...params,uploadProfileId:'fixture-alt-a'});
  expect(m.update.mock.calls[0][3].profileId).toBe('fixture-alt-a');
 });
 it('preserves explicit Main rather than a current alt',async()=>{
  setPendingUploadProfile('fixture-discord','fixture-alt-b');
  await writeBotRunCloudDocumentPair({...params,uploadProfileId:null});
  expect(m.update.mock.calls[0][3].profileId).toBeNull();
 });
 it('blocks unknown legacy targets for new runs without writing',async()=>{
  await expect(writeBotRunCloudDocumentPair(params)).rejects.toThrow('target profile');
  expect(m.update).not.toHaveBeenCalled();expect(m.create).not.toHaveBeenCalled();
 });
 it('allows legacy queued updates while preserving the verified cloud profile',async()=>{
  m.get.mockResolvedValue({$id:'fixture-run',userId:'fixture-owner',profileId:'fixture-alt-a'});
  await writeBotRunCloudDocumentPair(params);
  expect(m.update.mock.calls[0][3].profileId).toBe('fixture-alt-a');
 });
 it('rejects an existing run owned by an unrelated account',async()=>{
  m.get.mockResolvedValue({$id:'fixture-run',userId:'other-owner',profileId:null});
  await expect(writeBotRunCloudDocumentPair({...params,uploadProfileId:null})).rejects.toThrow('owner');
  expect(m.update).not.toHaveBeenCalled();
 });
 it('a shared writer read failure never permits a profile-changing update',async()=>{
  m.get.mockRejectedValue({code:503,type:'general_server_error'});
  await expect(writeTrackerRunCloudDocumentPair({databases:{getDocument:m.get,updateDocument:m.update,createDocument:m.create} as never,databaseId:'fixture-db',runId:'fixture-run',userId:'fixture-owner',username:'fixture',run:params.run,permissions:[],profileId:'fixture-alt-b'})).rejects.toMatchObject({code:503});
  expect(m.update).not.toHaveBeenCalled();expect(m.create).not.toHaveBeenCalled();
 });
});
