import { describe, expect, it, vi } from 'vitest';
import { Collection, type ModalSubmitInteraction } from 'discord.js';
import { extractModalUploadedFile, resolveSaveImportSourcePathFromFileName } from './save-upload';

describe('save upload selection', () => {
  it.each([
    ['tool_export.json','application/json'],
    ['TOOL_EXPORT.JSON','application/octet-stream'],
    ['playerInfo.dat',''],
    ['renamed-save','text/plain'],
  ])('accepts %s with MIME %s for byte validation', async (name, contentType) => {
    const file={name,contentType,url:'https://example.invalid/save'};
    const getUploadedFiles=vi.fn(()=>new Collection([['save',file]]));
    const modal={fields:{getUploadedFiles},attachments:{first:()=>({name:'wrong.png',url:'https://example.invalid/wrong'})}};
    expect(await extractModalUploadedFile(modal as unknown as ModalSubmitInteraction,'save-field')).toEqual({...file,contentType:contentType||'application/octet-stream'});
    expect(getUploadedFiles).toHaveBeenCalledWith('save-field');
  });
  it('does not fall back to unrelated attachments when the save field is empty', async () => {
    const modal={fields:{getUploadedFiles:()=>new Collection()},attachments:{first:()=>({name:'wrong.json',url:'https://example.invalid/wrong'})}};
    expect(await extractModalUploadedFile(modal as unknown as ModalSubmitInteraction,'save')).toBeNull();
  });
  it('rejects ambiguous multiple files', async () => {
    const file={name:'save',url:'https://example.invalid/save'};
    const modal={fields:{getUploadedFiles:()=>new Collection([['a',file],['b',file]])}};
    expect(await extractModalUploadedFile(modal as unknown as ModalSubmitInteraction,'save')).toBeNull();
  });
  it('retains the legacy attachment adapter', async () => {
    const file={filename:'playerInfo.dat',content_type:'application/octet-stream',proxy_url:'https://example.invalid/save'};
    expect(await extractModalUploadedFile({attachments:[file]} as unknown as ModalSubmitInteraction,'save')).toEqual({name:file.filename,contentType:file.content_type,url:file.proxy_url});
  });
  it('uses only actual supplied paths for misplaced legacy-save detection', () => {
    expect(resolveSaveImportSourcePathFromFileName('tool_export.json')).toBeNull();
    expect(resolveSaveImportSourcePathFromFileName('/sdcard/Android/data/com.TechTreeGames.TheTower/files/tool_export.json')).toContain('/files/tool_export.json');
  });
});
