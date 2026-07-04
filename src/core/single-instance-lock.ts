import { constants as fsConstants } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lockFilePath = join(tmpdir(), 'trackerbot-dev-instance.lock');

interface LockMetadata {
  pid: number;
  startedAt: number;
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

    return {
      pid,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
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
  if (existing && await processExists(existing.pid)) {
    throw new Error(`${existing.label} is already running (pid ${existing.pid}). Stop it before starting another process that uses the same lock.`);
  }

  await rm(path, { force: true });

  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY);
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now(), label } satisfies LockMetadata));
  await handle.close();

  let released = false;
  return async () => {
    if (released) {
      return;
    }

    released = true;
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
