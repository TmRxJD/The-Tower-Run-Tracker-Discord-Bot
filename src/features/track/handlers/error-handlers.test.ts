import { expect, it, vi } from 'vitest';
const log = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../../../core/logger', () => ({ logger: log }));
import { handleError, logError } from './error-handlers';
import { resolve } from 'node:path';
it('correlates useful private-safe local diagnostics with a category/reference-only alert', async () => {
  log.error.mockClear(); const send = vi.fn().mockResolvedValue({});
  const error = Object.assign(new TypeError('PRIVATE_SECRET_FIXTURE'), { code: 50013 });
  error.stack = `TypeError: PRIVATE_SECRET_FIXTURE\n at PRIVATE_FUNCTION (${resolve(process.cwd(), 'src/features/track/handlers/share-handlers.ts')}:42:9)`;
  await handleError({ client: { channels: { fetch: async () => ({ send }) } }, error, context: 'track_menu_sharelast', stage: 'send' });
  const details = log.error.mock.calls[0][1];
  expect(details).toMatchObject({ exceptionType: 'TypeError', code: 50013, operation: 'track_menu_sharelast', stage: 'send', frames: ['src/features/track/handlers/share-handlers.ts:42:9'] });
  const alert = JSON.stringify(send.mock.calls);
  expect(alert).toContain(details.incident); expect(alert).toContain('share');
  for (const privateValue of ['PRIVATE_', '50013', 'TypeError', 'share-handlers.ts', 'track_menu_sharelast']) expect(alert).not.toContain(privateValue);
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('PRIVATE_');
});
it.each(['handle', 'log'])('publishes only safe metadata through %s', async api => {
  log.error.mockClear(); const send = vi.fn().mockResolvedValue({}); const client = { channels: { fetch: async () => ({ send }) } };
  const marker = 'PRIVATE_SECRET_FIXTURE'; const error = Object.assign(Error(marker), { code: 503 });
  const user = { id: marker, tag: marker }; const ocr = [{ text: marker }]; const url = `https://example.invalid/${marker}`;
  if (api === 'handle') await handleError({ client, user, error, context: marker, ocrOutput: ocr, attachmentUrl: url });
  else await logError(client, user, error, marker, ocr, url);
  expect(JSON.stringify(send.mock.calls)).not.toContain(marker); expect(JSON.stringify(log.error.mock.calls)).not.toContain(marker);
  const payload = send.mock.calls[0][0]; expect(payload.files).toBeUndefined(); expect(payload.allowedMentions.parse).toEqual([]);
});
it('does not leak delivery failures into local logs', async () => {
  log.error.mockClear(); await handleError({ client: { channels: { fetch: async () => { throw Error('PRIVATE_DELIVERY_SECRET'); } } }, error: Error('PRIVATE_ERROR_SECRET'), context: 'upload' });
  expect(JSON.stringify(log.error.mock.calls)).not.toContain('PRIVATE_');
});
