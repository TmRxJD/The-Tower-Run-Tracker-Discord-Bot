import { buildBattleReportSections } from '../handlers/review-data-helpers';
import type { RunDataRecord } from '../shared/track-review-records';

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/** The share payload keeps scanned-but-unshared stats under `fullRunData`. */
export function resolveBattleReportSource(run: Record<string, unknown>): RunDataRecord {
  const fullRunData = run.fullRunData;
  const merged = typeof fullRunData === 'object' && fullRunData !== null
    ? { ...(fullRunData as Record<string, unknown>), ...run }
    : { ...run };
  delete merged.fullRunData;
  return merged as RunDataRecord;
}

export function buildBattleReportMarkdown(run: Record<string, unknown>, options: { sharerName?: string } = {}): string | null {
  const source = resolveBattleReportSource(run);
  const sections = buildBattleReportSections(source);
  if (!sections.length) return null;

  const tier = readTrimmedString(source.tierDisplay) || readTrimmedString(source.tier);
  const wave = readTrimmedString(source.wave);
  const runType = readTrimmedString(source.type) || 'Farming';

  const subtitleParts = [runType];
  if (tier) subtitleParts.push(`Tier ${tier}`);
  if (wave) subtitleParts.push(`Wave ${wave}`);
  if (options.sharerName) subtitleParts.push(options.sharerName);

  const lines: string[] = ['# Battle Report', '', `_${subtitleParts.join(' · ')}_`];

  for (const { section, stats } of sections) {
    lines.push('', `## ${section}`, '');
    for (const stat of stats) {
      lines.push(stat.value === null ? `- **${stat.label}**` : `- **${stat.label}:** ${stat.value}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
