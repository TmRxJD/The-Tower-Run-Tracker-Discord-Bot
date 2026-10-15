import type { ModalSubmitInteraction } from 'discord.js';

type DynamicFileLike = {
  url?: string;
  proxy_url?: string;
  attachment?: string;
  name?: string;
  filename?: string;
  content_type?: string;
  contentType?: string;
};

export type NormalizedFile = {
  url: string;
  name: string;
  contentType: string;
};

export function resolveSaveImportSourcePathFromFileName(name?: string | null): string | null {
  const normalized = String(name ?? '').trim();
  if (!normalized) return null;
  if (normalized.includes('/') || normalized.includes('\\')) return normalized;
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function looksLikeFile(value: unknown): value is DynamicFileLike {
  if (!value || typeof value !== 'object') return false;
  const record = toRecord(value);
  return 'name' in record || 'filename' in record || 'url' in record || 'attachment' in record || 'proxy_url' in record;
}

function findByCustomIdDeep(node: unknown, id: string, seen = new Set<unknown>()): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);
  const record = toRecord(node);
  if (record.customId === id) return record;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByCustomIdDeep(item, id, seen);
      if (found) return found;
    }
    return null;
  }
  for (const value of Object.values(record)) {
    const found = findByCustomIdDeep(value, id, seen);
    if (found) return found;
  }
  return null;
}

function toArray(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const record = toRecord(value);
  if (typeof record.values === 'function') {
    try {
      return Array.from((record.values as () => Iterable<unknown>)());
    } catch {
      return [];
    }
  }
  return Object.values(record);
}

export async function extractModalUploadedFile(
  submitted: ModalSubmitInteraction,
  customId: string,
): Promise<NormalizedFile | null> {
  const assign = (file: unknown): NormalizedFile | null => {
    if (!file || !looksLikeFile(file)) return null;
    const url = file.url || file.proxy_url || file.attachment || null;
    const name = file.name || file.filename || 'playerInfo.dat';
    const contentType = file.content_type || file.contentType || 'application/octet-stream';
    return url ? { url, name, contentType } : null;
  };

  // Prefer Discord's field-scoped accessor so unrelated attachments cannot be selected.
  if (typeof submitted.fields?.getUploadedFiles === 'function') {
    try {
      const files = submitted.fields.getUploadedFiles(customId);
      return files?.size === 1 ? assign(files.first()) : null;
    } catch {
      return null;
    }
  }

  try {
    const submittedRecord = toRecord(submitted);
    const attachmentContainer = toRecord(submittedRecord.attachments);
    const first = typeof attachmentContainer.first === 'function'
      ? (attachmentContainer.first as () => unknown)()
      : null;
    const modalAttachment = first || (Array.isArray(submittedRecord.attachments) ? submittedRecord.attachments[0] : null);
    const normalized = assign(modalAttachment);
    if (normalized) return normalized;
  } catch {
    /* ignore */
  }

  const fileComp = findByCustomIdDeep(submitted, customId);
  const candidates = [...toArray(fileComp?.files), ...toArray(fileComp?.attachments)];
  for (const candidate of candidates) {
    const normalized = assign(candidate);
    if (normalized) return normalized;
  }

  return null;
}

