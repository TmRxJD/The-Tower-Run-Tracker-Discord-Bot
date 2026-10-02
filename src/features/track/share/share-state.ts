import { TransientCache } from '../../../core/transient-cache';
export type ShareableRun = {
  run: Record<string, unknown>;
  runTypeCounts: Record<string, number>;
  screenshotUrl?: string | null;
};

const shareableRuns = new TransientCache<string, ShareableRun>();

export function setShareableRun(userId: string, payload: ShareableRun) {
  shareableRuns.set(userId, payload);
}

export function getShareableRun(userId: string): ShareableRun | null {
  return shareableRuns.get(userId) ?? null;
}

export function clearShareableRun(userId: string) {
  shareableRuns.delete(userId);
}
