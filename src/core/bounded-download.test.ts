import {afterEach,describe,expect,it,vi} from 'vitest';
import {downloadBoundedBuffer} from './bounded-download';
afterEach(()=>vi.unstubAllGlobals());
describe('bounded attachment download',()=>{
 it('rejects oversized declared bodies before reading them',async()=>{
  const response=new Response('12345',{headers:{'content-length':'999'}});
  vi.stubGlobal('fetch',vi.fn(async()=>response));
  await expect(downloadBoundedBuffer('https://fixture.invalid',4)).rejects.toThrow('limit');
  expect(response.bodyUsed).toBe(true);
 });
 it('enforces streamed bytes even when content length is absent',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('12345')));
  await expect(downloadBoundedBuffer('https://fixture.invalid',4)).rejects.toThrow('limit');
 });
 it('preserves permitted bytes and supplies an abort deadline',async()=>{
  const fetchMock=vi.fn<typeof fetch>(async()=>new Response('1234'));vi.stubGlobal('fetch',fetchMock);
  expect((await downloadBoundedBuffer('https://fixture.invalid',4)).toString()).toBe('1234');
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
 });
});
