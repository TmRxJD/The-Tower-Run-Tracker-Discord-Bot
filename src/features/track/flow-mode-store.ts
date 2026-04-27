import type { TrackerUiMode } from '../../config/tracker-ui-config';

type ModeState = {
  mode: TrackerUiMode;
  updatedAt: number;
};

const MODE_TTL_MS = 30 * 60 * 1000;
const byUser = new Map<string, ModeState>();

export function setTrackerFlowMode(userId: string, mode: TrackerUiMode) {
  byUser.set(userId, { mode, updatedAt: Date.now() });
}

type InitialRunTypeState = {
  runType: string;
  updatedAt: number;
};

const INITIAL_RUN_TYPE_TTL_MS = 30 * 60 * 1000;
const initialRunTypeByUser = new Map<string, InitialRunTypeState>();

export function setTrackerInitialRunType(userId: string, runType: string) {
  initialRunTypeByUser.set(userId, { runType, updatedAt: Date.now() });
}

export function getTrackerInitialRunType(userId: string): string | undefined {
  const record = initialRunTypeByUser.get(userId);
  if (!record) return undefined;
  if (Date.now() - record.updatedAt > INITIAL_RUN_TYPE_TTL_MS) {
    initialRunTypeByUser.delete(userId);
    return undefined;
  }
  return record.runType;
}

export function getTrackerFlowMode(userId: string): TrackerUiMode {
  const record = byUser.get(userId);
  if (!record) return 'track';
  if (Date.now() - record.updatedAt > MODE_TTL_MS) {
    byUser.delete(userId);
    return 'track';
  }
  return record.mode;
}
