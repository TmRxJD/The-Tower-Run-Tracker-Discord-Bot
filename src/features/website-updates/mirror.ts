import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buildUpdateMessages, updateMessageSchema, type UpdateMessage } from './messages';
import { type PublishedRelease, UPDATES_CHANNEL, UPDATES_SOURCE } from './source';

const snowflake = z.string().regex(/^\d{17,22}$/);
const pendingSchema = z.object({
  nonce: z.string().regex(/^[a-f0-9]{24}$/), startedAt: z.number().int().positive(), message: updateMessageSchema,
});
export type PendingUpdate = z.infer<typeof pendingSchema>;
const partSchema = z.object({ messageId: snowflake.optional(), message: updateMessageSchema.optional(), pending: pendingSchema.optional() });
const recordSchema = z.object({ baseline: z.boolean(), hash: z.string(), parts: z.array(partSchema) });
export const mirrorStateSchema = z.object({
  version: z.literal(1), source: z.literal(UPDATES_SOURCE), channel: z.literal(UPDATES_CHANNEL),
  baselineAt: z.number().int().positive(), entries: z.record(z.string(), recordSchema),
});
export type MirrorState = z.infer<typeof mirrorStateSchema>;
export interface MirrorStore { load(): Promise<unknown>; save(state: MirrorState): Promise<void> }
export interface UpdateDelivery {
  send(message: UpdateMessage, nonce: string): Promise<string>;
  recover(pending: PendingUpdate): Promise<string | null>;
  edit(id: string, message: UpdateMessage): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface MirrorResult { baselined: number; sent: number; edited: number; recovered: number; removed: number }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Reload durable state on every poll, including after a failed checkpoint following a send. */
export async function mirrorPublishedUpdates(releases: PublishedRelease[], store: MirrorStore, delivery: UpdateDelivery): Promise<MirrorResult> {
  const result: MirrorResult = { baselined: 0, sent: 0, edited: 0, recovered: 0, removed: 0 };
  const raw = await store.load();
  if (raw == null) {
    const entries = Object.fromEntries(releases.map(release => [release.id, { baseline: true, hash: release.hash, parts: [] }]));
    await store.save(mirrorStateSchema.parse({ version: 1, source: UPDATES_SOURCE, channel: UPDATES_CHANNEL, baselineAt: Date.now(), entries }));
    result.baselined = releases.length;
    return result;
  }
  const state = mirrorStateSchema.parse(raw); // Corruption must never silently become a fresh baseline.
  for (const release of [...releases].reverse()) {
    let record = state.entries[release.id];
    if (record?.baseline) continue; // Historical edits do not trigger a historical replay.
    if (!record) {
      record = state.entries[release.id] = { baseline: false, hash: '', parts: [] };
      await store.save(state);
    }
    if (record.hash === release.hash && !record.parts.some(part => part.pending)) continue;
    // Resolve old uncertain sends before rendering a newer revision of the same release.
    for (const part of record.parts) {
      if (!part.pending) continue;
      const pending = part.pending;
      const recoveredId = await delivery.recover(pending); // A failed/incomplete search throws: do not resend.
      part.messageId = recoveredId ?? await delivery.send(pending.message, pending.nonce);
      part.message = pending.message;
      delete part.pending;
      await store.save(state);
      if (recoveredId) result.recovered++; else result.sent++;
    }
    const messages = buildUpdateMessages(release);
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const part = record.parts[index] ?? (record.parts[index] = {});
      if (part.messageId) {
        if (equal(part.message, message)) continue;
        await delivery.edit(part.messageId, message);
        part.message = message;
        await store.save(state);
        result.edited++;
      } else {
        const pending = { nonce: randomBytes(12).toString('hex'), startedAt: Date.now(), message };
        part.pending = pending;
        await store.save(state); // Intent + payload + nonce are durable before Discord sees the request.
        part.messageId = await delivery.send(message, pending.nonce);
        part.message = message;
        delete part.pending;
        await store.save(state);
        result.sent++;
      }
    }
    while (record.parts.length > messages.length) {
      const part = record.parts[record.parts.length - 1];
      if (part.messageId) await delivery.remove(part.messageId);
      record.parts.pop();
      await store.save(state);
      result.removed++;
    }
    record.hash = release.hash;
    await store.save(state);
  }
  return result;
}
