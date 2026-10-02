import { expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ocr:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()}));
vi.mock('../../../core/logger',()=>({logger:{info:mocks.info,warn:mocks.warn,error:mocks.error,debug:mocks.debug}}));
vi.mock('../../../core/bounded-download',()=>({downloadBoundedBuffer:vi.fn(async()=>Buffer.from('fixture'))}));
vi.mock('../tracker-api-client',async original=>({...await original<object>(),runOCR:mocks.ocr}));
import { verifyScreenshotMatchesPastedRun } from './upload-handlers';
it('never logs screenshot filenames, URLs, source strings or compared OCR/paste values',async()=>{
 const marker='PRIVATE_VERIFICATION_SECRET';
 mocks.ocr.mockResolvedValue({source:marker,runData:{tier:'5',wave:'321',totalCoins:'2B',totalCells:'3K',totalDice:'0',roundDuration:'1h',killedBy:marker}});
 await verifyScreenshotMatchesPastedRun({url:'https://example.invalid/'+marker,name:marker,contentType:'image/png'} as never,{tier:'5',wave:'321',totalCoins:'2B',totalCells:'3K',totalDice:'0',roundDuration:'1h',killedBy:'another '+marker});
 expect(mocks.warn).toHaveBeenCalledWith('Tracker screenshot verification mismatch detected',{mismatchCount:1});
 expect(JSON.stringify([mocks.warn.mock.calls,mocks.info.mock.calls,mocks.error.mock.calls,mocks.debug.mock.calls])).not.toContain(marker);
});
