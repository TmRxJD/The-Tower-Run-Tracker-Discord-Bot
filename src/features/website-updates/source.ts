import { createHash } from 'node:crypto';
import { z } from 'zod';

export const UPDATES_SOURCE = 'https://the-tower-run-tracker.com/changelog.md';
export const UPDATES_CHANNEL = '1373110039669379082';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const datePattern = /^(?:-\s*)?\*\*([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\*\*\s*$/;
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export const releaseSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  title: z.string().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  markdown: z.string().min(1).max(MAX_SOURCE_BYTES),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PublishedRelease = z.infer<typeof releaseSchema>;
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Only the Markdown deployed behind the header Updates button is publication evidence. */
export function parsePublishedUpdates(input: string): PublishedRelease[] {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text.startsWith('# ') || Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new Error('Invalid Updates document');
  // Mask fenced code without changing offsets; sample headings in code are not releases.
  const headings: Array<{ index: number; title: string }> = [];
  let fence: string | null = null;
  for (const match of text.matchAll(/^.*$/gm)) {
    const line = match[0];
    const boundary = /^\s*(`{3,}|~{3,})/.exec(line);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence && line.startsWith('# ')) headings.push({ index: match.index, title: line.slice(2).replace(/\*\*/g, '').trim() });
  }
  if (fence) throw new Error('Unclosed Updates code block');
  const releases = new Map<string, PublishedRelease>();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (/\b(unreleased|draft|planned)\b/i.test(heading.title)) continue;
    const section = text.slice(heading.index, headings[index + 1]?.index ?? text.length)
      .replace(/\n[\t ]*-{3,}[\t ]*\s*$/, '').trim();
    const lines = section.split('\n');
    const dateLine = lines.slice(1).findIndex(line => line.trim().length > 0) + 1;
    const match = datePattern.exec(lines[dateLine]?.trim() ?? '');
    if (!match) throw new Error('Published Updates entry has no supported release date');
    const month = months.indexOf(match[1].slice(0, 3).toLowerCase());
    const date = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
    if (month < 0 || date.getUTCMonth() !== month || date.getUTCDate() !== Number(match[2])) throw new Error('Invalid Updates date');
    const day = date.toISOString().slice(0, 10);
    const version = /\bv\d+(?:\.\d+)+\b/i.exec(heading.title)?.[0].toLowerCase();
    const id = hashText(`${version ?? heading.title.toLowerCase()}|${day}`).slice(0, 32);
    const markdown = lines.slice(dateLine + 1).join('\n').trim();
    const release = releaseSchema.parse({ id, title: heading.title, date: day, markdown, hash: hashText(`${heading.title}\n${day}\n${markdown}`) });
    // The file has duplicate legacy releases. The first (newest-positioned) copy wins.
    if (!releases.has(id)) releases.set(id, release);
  }
  if (!releases.size) throw new Error('Updates contains no published releases');
  return [...releases.values()];
}

export async function fetchPublishedUpdates(): Promise<PublishedRelease[]> {
  const response = await fetch(UPDATES_SOURCE, {
    cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { 'Cache-Control': 'no-cache', Accept: 'text/markdown, text/plain' },
  });
  if (!response.ok || !response.body) throw new Error(`Updates source HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) throw new Error('Updates source exceeds size limit');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return parsePublishedUpdates(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
