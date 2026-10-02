import { expect, it, vi } from 'vitest';
const log = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../../../core/logger', () => ({ logger: log }));
import { handleError, logError } from './error-handlers';
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
