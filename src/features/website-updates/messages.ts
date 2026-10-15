import { z } from 'zod';
import { UPDATES_SOURCE, type PublishedRelease } from './source';

export const updateMessageSchema = z.object({
  title: z.string().min(1).max(256),
  description: z.string().min(1).max(3800),
  footer: z.string().min(1).max(2048),
});
export type UpdateMessage = z.infer<typeof updateMessageSchema>;

/** Keep all meaningful text; break at paragraphs/lines where possible and never split a surrogate pair. */
export function buildUpdateMessages(release: PublishedRelease): UpdateMessage[] {
  let remaining = release.markdown.replace(/\]\((\/[^)]*)\)/g, (_match, path: string) => `](${new URL(path, UPDATES_SOURCE).href})`);
  const chunks: string[] = [];
  while (remaining.length) {
    let end = Math.min(3800, remaining.length);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf('\n', end - 1);
      if (newline > 1900) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks.map((description, index) => updateMessageSchema.parse({
    title: release.title.slice(0, 256), description,
    footer: `${release.date} · Website Updates · Part ${index + 1} of ${chunks.length}`,
  }));
}
