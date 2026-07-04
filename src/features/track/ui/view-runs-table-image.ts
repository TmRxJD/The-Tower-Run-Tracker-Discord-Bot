import {
  buildTrackerRunTableColumnValue,
  normalizeTrackerRunTableColumnOrder,
  TRACKER_RUN_TABLE_COLUMN_OPTIONS,
  type TrackerRunTableColumn,
  type TrackerRunTableRow,
} from '@tmrxjd/platform/tools';
import { renderViewRunsTablePng } from './view-runs-chart';
import type { ViewRunsPresentationPrefs } from '../view-runs-store';

export const TRACK_COLUMN_OPTIONS = TRACKER_RUN_TABLE_COLUMN_OPTIONS;
export type ViewRunsTableRun = TrackerRunTableRow;

export type ViewRunsTableImageOptions = {
  runs: ViewRunsTableRun[];
  selectedColumns: string[];
  orientation: 'landscape' | 'portrait';
  title?: string;
  pageSize?: number;
  pageOffset?: number;
};

export function runIdentityKey(run: ViewRunsTableRun): string {
  const runId = String(run.runId ?? '').trim();
  if (runId) return `runId:${runId}`;
  const localId = String(run.localId ?? '').trim();
  if (localId) return `localId:${localId}`;
  const type = String(run.type ?? 'Farming').trim();
  const tier = String(run.tierDisplay ?? run.tier ?? '').trim();
  const wave = String(run.wave ?? '').trim();
  const duration = String(run.roundDuration ?? run.duration ?? '').trim();
  const date = String(run.runDate ?? run.date ?? '').trim();
  const time = String(run.runTime ?? run.time ?? '').trim();
  return `fp:${type}|${tier}|${wave}|${duration}|${date}|${time}`;
}

export function buildRunIndexMap(runs: ViewRunsTableRun[]): Map<string, number> {
  const result = new Map<string, number>();
  const total = runs.length;
  runs.forEach((run, index) => {
    const key = runIdentityKey(run);
    if (!result.has(key)) {
      result.set(key, Math.max(1, total - index));
    }
  });
  return result;
}

export const normalizeTrackColumnOrder = normalizeTrackerRunTableColumnOrder;
export const buildTrackColumnValue = buildTrackerRunTableColumnValue;

export async function buildViewRunsTableImage(
  page: ViewRunsTableRun[],
  runIndexMap: Map<string, number>,
  selectedColumns: readonly TrackerRunTableColumn[],
  orientation: 'landscape' | 'portrait',
  title = 'Run History',
): Promise<Buffer> {
  if (orientation === 'portrait') {
    const headers = ['Field', 'Value'];
    const rows: string[][] = [];

    page.forEach((run, index) => {
      const runNumber = runIndexMap.get(runIdentityKey(run)) ?? 0;
      rows.push(['Run', `#${runNumber}`]);
      selectedColumns.forEach((column) => {
        rows.push([column, buildTrackColumnValue(run, column)]);
      });
      if (index < page.length - 1) {
        rows.push(['', '']);
      }
    });

    return renderViewRunsTablePng({
      title,
      headers,
      rows,
    });
  }

  const headers = ['#', ...selectedColumns];
  const rows = page.map((run) => [
    String(runIndexMap.get(runIdentityKey(run)) ?? 0),
    ...selectedColumns.map((column) => buildTrackColumnValue(run, column)),
  ]);
  return renderViewRunsTablePng({
    title,
    headers,
    rows,
  });
}

export async function renderViewRunsTableImageFromPreferences(options: ViewRunsTableImageOptions): Promise<Buffer> {
  const {
    runs,
    selectedColumns,
    orientation,
    title = 'Run History',
    pageSize = 10,
    pageOffset = 0,
  } = options;

  const normalizedPageSize = Math.max(1, pageSize);
  const effectivePageSize = orientation === 'portrait' ? 1 : normalizedPageSize;
  const page = runs.slice(pageOffset, pageOffset + effectivePageSize);
  const runIndexMap = buildRunIndexMap(runs);
  const columns = normalizeTrackColumnOrder(selectedColumns);

  return buildViewRunsTableImage(page, runIndexMap, columns, orientation, title);
}

/**
 * Import/save-review table preview.
 * Honors layout prefs only — never applies Runs Viewer type/tier filters.
 */
export async function renderImportPreviewTableImage(
  runs: ViewRunsTableRun[],
  presentation: ViewRunsPresentationPrefs,
): Promise<Buffer> {
  const suffix = runs.length > 0
    ? ` (${runs.length} run${runs.length === 1 ? '' : 's'})`
    : '';

  return renderViewRunsTableImageFromPreferences({
    runs,
    selectedColumns: presentation.selectedColumns,
    orientation: presentation.orientation,
    title: `Runs to Import${suffix}`,
    pageSize: Math.max(1, runs.length),
    pageOffset: 0,
  });
}
