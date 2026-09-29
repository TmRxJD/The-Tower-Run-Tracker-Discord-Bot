import { constants as fsConstants } from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lockFilePath = join(tmpdir(), 'trackerbot-dev-instance.lock');

/**
 * A live holder rewrites its lock every HEARTBEAT_INTERVAL_MS. A lock older than
 * HEARTBEAT_STALE_MS is dead even when its pid exists: Windows recycles pids quickly, and
 * the pid of a crashed bot is easily reassigned to another node process on the same host.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 60_000;

interface LockMetadata {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  label: string;
}

function isErrnoException (error: unknown): error is { code?: string } {
  return error !== null && typeof error === 'object' && 'code' in error;
}

async function processExists (pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockMetadata(path: string): Promise<LockMetadata | null> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LockMetadata>;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now();
    return {
      pid,
      startedAt,
      // Locks written before heartbeats existed fall back to their start time.
      heartbeatAt: typeof parsed.heartbeatAt === 'number' ? parsed.heartbeatAt : startedAt,
      label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label : 'Another local TrackerBot instance',
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function acquireNamedLock (path: string, label: string) {
  const existing = await readLockMetadata(path);
  const fresh = existing !== null && Date.now() - existing.heartbeatAt < HEARTBEAT_STALE_MS;
  if (existing && fresh && await processExists(existing.pid)) {
    throw new Error(`${existing.label} is already running (pid ${existing.pid}). Stop it before starting another process that uses the same lock.`);
  }

  await rm(path, { force: true });

  const startedAt = Date.now();
  const writeMetadata = (heartbeatAt: number) => JSON.stringify({ pid: process.pid, startedAt, heartbeatAt, label } satisfies LockMetadata);

  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
  await handle.writeFile(writeMetadata(startedAt));
  await handle.close();

  const heartbeat = setInterval(() => {
    writeFile(path, writeMetadata(Date.now())).catch(() => null);
  }, HEARTBEAT_INTERVAL_MS);
  // The lock must never be the reason the process stays alive.
  heartbeat.unref();

  let released = false;
  return async () => {
    if (released) {
      return;
    }

    released = true;
    clearInterval(heartbeat);
    await rm(path, { force: true }).catch(() => null);
  };
}

export async function acquireSingleInstanceLock () {
  return acquireNamedLock(lockFilePath, 'Another local TrackerBot instance');
}

export async function acquireSharedDiscordTokenLock (tokenKey: string, label: string) {
  const sharedLockPath = join(tmpdir(), `tower-discord-token-${tokenKey}.lock`);
  return acquireNamedLock(sharedLockPath, label);
}
