import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { safeErrorDiagnostic } from './safe-error-diagnostic';
const handler = resolve(process.cwd(), 'src/features/track/handlers');

it('retains exception type, safe code, operation, stage and only local source locations', () => {
  const error = Object.assign(new TypeError('PRIVATE_PASTE_TOKEN'), { code: 50013 });
  error.stack = `TypeError: PRIVATE_PASTE_TOKEN\n    at PRIVATE_FUNCTION (${resolve(handler, 'share-handlers.ts')}:42:9)\n    at secret (https://private.invalid/token:1:2)\n    at private (C:/private/PRIVATE_SECRET.ts:1:2)`;
  expect(safeErrorDiagnostic(error, 'track_menu_sharelast', 'send')).toEqual({ exceptionType: 'TypeError', code: 50013, operation: 'track_menu_sharelast', stage: 'send', frames: ['src/features/track/handlers/share-handlers.ts:42:9'] });
});
it('rejects adversarial metadata, fake source filenames and throwing getters', () => {
  const marker = 'PRIVATE_PASTE_TOKEN';
  const error = Object.assign(new Error(marker), { name: marker, code: marker, body: marker });
  error.stack = `${marker}\n at ${marker} (${resolve(handler, marker + '.ts')}:1:2)`;
  expect(JSON.stringify(safeErrorDiagnostic(error, marker, marker as never))).not.toContain(marker);
  const hostile = Object.defineProperties({}, { name: { get() { throw Error(marker); } }, stack: { get() { throw Error(marker); } }, code: { get() { throw Error(marker); } } });
  expect(safeErrorDiagnostic(hostile, marker)).toEqual({ exceptionType: 'Unknown', code: undefined, operation: 'other', stage: 'unknown', frames: [] });
});
it('bounds stack scanning and accepts only known symbolic error codes', () => {
  const error = Object.assign(new Error('secret'), { code: 'ETIMEDOUT' });
  error.stack = 'secret\n' + Array(100).fill(` at fn (${resolve(handler, 'share-handlers.ts')}:5:2)`).join('\n');
  expect(safeErrorDiagnostic(error, 'share_embed_expand', 'lookup').frames).toHaveLength(6);
  expect(safeErrorDiagnostic(error, 'share_embed_expand').code).toBe('ETIMEDOUT');
});
it('keeps import operation and parse stage identifiable without exposing save content', () => {
  const result = safeErrorDiagnostic(new Error('PRIVATE_SAVE_CONTENT'), 'import_playerinfo_decode', 'parse');
  expect(result).toMatchObject({ operation: 'import_playerinfo_decode', stage: 'parse' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SAVE_CONTENT');
});
