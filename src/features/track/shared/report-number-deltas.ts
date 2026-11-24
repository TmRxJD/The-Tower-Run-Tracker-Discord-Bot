import {
  computeTrackerRunDeltaBaseline as platformBaseline,
  getDeltaAnnotationForStat as platformAnnotation,
} from '@tmrxjd/platform/tools';
import { normalizeKnownRunMetrics } from './report-number';

export function computeTrackerRunDeltaBaseline(
  runs: Parameters<typeof platformBaseline>[0],
  runType: Parameters<typeof platformBaseline>[1],
  mode: Parameters<typeof platformBaseline>[2],
  now?: Parameters<typeof platformBaseline>[3],
  current?: Parameters<typeof platformBaseline>[4],
): ReturnType<typeof platformBaseline> {
  return platformBaseline(runs.map(run => normalizeKnownRunMetrics(run, true)), runType, mode, now,
    current ? normalizeKnownRunMetrics(current, true) : current);
}

export function getDeltaAnnotationForStat(
  run: Parameters<typeof platformAnnotation>[0],
  ...args: [Parameters<typeof platformAnnotation>[1], Parameters<typeof platformAnnotation>[2], Parameters<typeof platformAnnotation>[3]?]
): ReturnType<typeof platformAnnotation> {
  return platformAnnotation(normalizeKnownRunMetrics(run, true), ...args);
}
