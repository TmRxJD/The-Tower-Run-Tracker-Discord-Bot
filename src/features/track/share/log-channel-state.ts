import { getTrackerKv, setTrackerKv } from '../../../services/idb';

type RunRecord = Record<string, unknown>;

export type AutoLogMessageRef = {
  channelId: string;
  messageId: string;
  updatedAt: number;
};

function normalizeDuration(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return '';
  const hours = /(\d+)h/.exec(text)?.[1] ?? '0';
  const minutes = /(\d+)m/.exec(text)?.[1] ?? '0';
  const seconds = /(\d+)s/.exec(text)?.[1] ?? '0';
  return `${hours}h${minutes}m${seconds}s`;
}

function buildFingerprintKey(run: RunRecord): string | null {
  const runId = String(run.runId ?? run.id ?? '').trim();
  const localId = String(run.localId ?? '').trim();
  const tier = String(run.tierDisplay ?? run.tier ?? '').trim();
  const wave = String(run.wave ?? '').trim();
  const duration = normalizeDuration(run.duration ?? run.roundDuration ?? '');
  const coins = String(run.totalCoins ?? run.coins ?? '').trim();
  if (!tier || !wave || !duration || !coins) return null;

  return `fp:${tier}|${wave}|${duration}|${coins}`;
}

export function buildAutoLogRunKey(run: RunRecord | null | undefined): string | null {
  if (!run) return null;

  const runId = String(run.runId ?? run.id ?? '').trim();
  if (runId) return `runId:${runId}`;

  const localId = String(run.localId ?? '').trim();
  if (localId) return `localId:${localId}`;

  return buildFingerprintKey(run);
}

export function buildAutoLogRunKeys(run: RunRecord | null | undefined): string[] {
  if (!run) return [];

  const keys = new Set<string>();
  const runId = String(run.runId ?? run.id ?? '').trim();
  if (runId) keys.add(`runId:${runId}`);

  const localId = String(run.localId ?? '').trim();
  if (localId) keys.add(`localId:${localId}`);

  const fingerprintKey = buildFingerprintKey(run);
  if (fingerprintKey) keys.add(fingerprintKey);

  return [...keys];
}

function autoLogMessageKey(userId: string, runKey: string): string {
  return `tracker:auto-log-message:v1:${userId}:${runKey}`;
}

export async function getAutoLogMessageRef(userId: string, run: RunRecord | null | undefined): Promise<AutoLogMessageRef | null> {
  const runKeys = buildAutoLogRunKeys(run);
  for (const runKey of runKeys) {
    const value = await getTrackerKv<AutoLogMessageRef>(autoLogMessageKey(userId, runKey));
    if (value) return value;
  }
  return null;
}

export async function setAutoLogMessageRef(userId: string, run: RunRecord | null | undefined, value: AutoLogMessageRef | null): Promise<void> {
  const runKeys = buildAutoLogRunKeys(run);
  for (const runKey of runKeys) {
    await setTrackerKv(autoLogMessageKey(userId, runKey), value);
  }
}