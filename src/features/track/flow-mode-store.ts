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

export function getTrackerFlowMode(userId: string): TrackerUiMode {
  const record = byUser.get(userId);
  if (!record) return 'track';
  if (Date.now() - record.updatedAt > MODE_TTL_MS) {
    byUser.delete(userId);
    return 'track';
  }
  return record.mode;
}
