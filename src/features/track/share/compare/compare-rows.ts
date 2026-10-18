import { escapeMarkdown } from 'discord.js';
import { computeStatDelta, formatDeltaAnnotation, readTrackerMetricValue } from '@tmrxjd/platform/tools';

export interface CompareRow { section: string; key: string; label: string; shared: string | null; mine: string | null; difference?: string }
export interface ComparePage { text: string }
const MAX_VALUE_PART = 160;
const MAX_LABEL_PART = 120;
const PAGE_LIMIT = 2800;

function parts(value: string, size: number): string[] {
  const result: string[] = [];
  while (value.length) {
    let end = Math.min(value.length, size);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    result.push(value.slice(0, end)); value = value.slice(end);
  }
  return result.length ? result : [''];
}
const safe = (text: string) => escapeMarkdown(text.replace(/\r?\n/g, ' '));

/** Paired values share a physical Markdown row; no inline embed-field layout is involved. */
export function paginateCompareRows(rows: CompareRow[]): ComparePage[] {
  const pages: ComparePage[] = [];
  let text = '', section = '', count = 0;
  for (const row of rows) {
    const labels = parts(row.label, MAX_LABEL_PART);
    const left = parts(row.shared ?? 'Unavailable', MAX_VALUE_PART), right = parts(row.mine ?? 'Unavailable', MAX_VALUE_PART);
    const heading = labels.map(safe).join('\n');
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const line = `${index ? '**Continued**' : `**${heading}**`}\nS **${safe(left[index] ?? '—')}** | Y **${safe(right[index] ?? '—')}**${!index && row.difference ? ` · Δ ${safe(row.difference)}` : ''}`;
      const prefix = section !== row.section ? `**${safe(row.section)}**\n\n` : '';
      if (text && (text.length + prefix.length + line.length + 2 > PAGE_LIMIT || count >= 9)) {
        pages.push({ text: text.trim() }); text = ''; count = 0; section = '';
      }
      if (section !== row.section) { text += `**${safe(row.section)}**\n\n`; section = row.section; }
      text += line + '\n\n'; count++;
    }
  }
  if (text) pages.push({ text: text.trim() });
  return pages;
}

/** Report scalar differences use shared numeric parsing and zero/invalid-baseline guards. */
export function reportDifference(key: string, mine: string | null, shared: string | null): string {
  if (!mine || !shared || ['battleDate', 'gameTime', 'roundDuration', 'killedBy', 'tier'].includes(key)) return '';
  const scalar = (value: string) => readTrackerMetricValue(value.trim().replace(/%$/, ''));
  return formatDeltaAnnotation(computeStatDelta(scalar(mine), scalar(shared)));
}
