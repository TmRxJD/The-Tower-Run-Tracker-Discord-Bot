import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { safeErrorDiagnostic } from './safe-error-diagnostic';
import { annotateSubmissionValidation } from '../submission-failure-diagnostic';
const handler = resolve(process.cwd(), 'src/features/track/handlers');

it('retains exception type, safe code, operation, stage and only local source locations', () => {
  const error = Object.assign(new TypeError('PRIVATE_PASTE_TOKEN'), { code: 50013 });
  error.stack = `TypeError: PRIVATE_PASTE_TOKEN\n    at PRIVATE_FUNCTION (${resolve(handler, 'share-handlers.ts')}:42:9)\n    at secret (https://private.invalid/token:1:2)\n    at private (C:/private/PRIVATE_SECRET.ts:1:2)`;
  expect(safeErrorDiagnostic(error, 'track_menu_sharelast', 'send')).toMatchObject({ exceptionType: 'TypeError', code: 50013, operation: 'track_menu_sharelast', stage: 'send', frames: ['src/features/track/handlers/share-handlers.ts:42:9'], framesOrigin: 'error', stackPresent: true, errorShape: 'error', causeDepth: 0 });
});
it('rejects adversarial metadata, fake source filenames and throwing getters', () => {
  const marker = 'PRIVATE_PASTE_TOKEN';
  const error = Object.assign(new Error(marker), { name: marker, code: marker, body: marker });
  error.stack = `${marker}\n at ${marker} (${resolve(handler, marker + '.ts')}:1:2)`;
  expect(JSON.stringify(safeErrorDiagnostic(error, marker, marker as never))).not.toContain(marker);
  const hostile = Object.defineProperties({}, { name: { get() { throw Error(marker); } }, stack: { get() { throw Error(marker); } }, code: { get() { throw Error(marker); } } });
  expect(safeErrorDiagnostic(hostile, marker)).toMatchObject({ exceptionType: 'Unknown', code: undefined, operation: 'other', stage: 'unknown', frames: [], framesOrigin: 'none', stackPresent: false, errorShape: 'object' });
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
it('preserves bounded original cause frames and validation shape through a private paste wrapper', () => {
  const cause = new TypeError('PRIVATE_REPORT_TOKEN');
  cause.stack = `TypeError: PRIVATE_REPORT_TOKEN\n at PRIVATE_FUNCTION (${resolve(handler, 'review-data-helpers.ts')}:398:29)`;
  annotateSubmissionValidation(cause, { tier: 'PRIVATE_REPORT_TOKEN', wave: 1, notes: 'PRIVATE_NOTE' });
  const wrapper = Object.defineProperty(new Error('PRIVATE_REFERENCE'), 'cause', { value: cause });
  const result = safeErrorDiagnostic(wrapper, 'dataSubmission', 'submit');
  expect(result).toMatchObject({ exceptionType: 'TypeError', stage: 'validate', causeDepth: 1, framesOrigin: 'cause',
    frames: ['src/features/track/handlers/review-data-helpers.ts:398:29'], validation: { validator: 'battle-report', requiredFieldKinds: { tier: 'string', wave: 'number', duration: 'missing' } } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
});
it('identifies previously omitted handler contexts, HTTP status and non-Error shapes without arbitrary metadata', () => {
  expect(safeErrorDiagnostic({ status: 401, message: 'PRIVATE_URL' }, 'handleDirectAttachment', 'ocr-cloud')).toMatchObject({ operation: 'handleDirectAttachment', status: 401, errorShape: 'object', stackPresent: false });
  expect(safeErrorDiagnostic('PRIVATE_TOKEN', 'type_selection')).toMatchObject({ operation: 'type_selection', errorShape: 'string', framesOrigin: 'none' });
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('PRIVATE_PROXY'); }, getPrototypeOf() { throw Error('PRIVATE_PROXY'); } });
  expect(() => safeErrorDiagnostic(hostile, 'render_track_menu')).not.toThrow();
  const cycle = new Error('PRIVATE_CYCLE'); Object.defineProperty(cycle, 'cause', { value: cycle });
  expect(safeErrorDiagnostic(cycle, 'dataSubmission').causeDepth).toBe(0);
});
