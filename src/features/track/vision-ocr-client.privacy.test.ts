import { afterEach, expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({warn:vi.fn()}));
vi.mock('../../core/logger',()=>({logger:logs}));
vi.mock('../../config',()=>({getAppConfig:()=>({ai:{cloudApiKey:'fixture-key',cloudEndpoint:'https://example.invalid/v1',timeoutMs:1000}})}));
import { runDirectVisionOcr } from './vision-ocr-client';
const file = {data:Buffer.from('fixture'),filename:'PRIVATE_FILENAME',contentType:'image/png'};
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('never consumes or echoes a failing Vision response body',async()=>{
 const json=vi.fn().mockResolvedValue({error:{message:'PRIVATE_REPORT_SECRET'}});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:503,json}));
 await expect(runDirectVisionOcr(file)).rejects.toThrow('request failed (503)');
 expect(json).not.toHaveBeenCalled();expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('PRIVATE_');
});
it.each(['outer','inner','empty'])('bounds malformed/empty OCR %s diagnostics',async kind=>{
 const payload=kind==='inner'?{choices:[{message:{content:'{"textLines":[PRIVATE_REPORT_SECRET]}'}}]}:{choices:[{message:{content:'{"textLines":[],"runData":{}}'}}]};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:kind==='outer'?vi.fn().mockRejectedValue(Error('PRIVATE_REPORT_SECRET')):async()=>payload}));
 let message='';try{await runDirectVisionOcr(file);}catch(error){message=(error as Error).message;}
 expect(message).not.toContain('PRIVATE_');expect(message).toMatch(/Vision API/);
 expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('PRIVATE_');
});
