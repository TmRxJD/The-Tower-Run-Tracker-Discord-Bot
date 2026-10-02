import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lockFilePath = join(tmpdir(), 'trackerbot-dev-instance.lock');
const HEARTBEAT_INTERVAL_MS = 10_000;
interface LockMetadata { pid: number; startedAt: number; label: string; heartbeatAt?: number }
function code(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return code(error) === 'EPERM'; }
}
async function metadata(path: string): Promise<LockMetadata> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as LockMetadata;
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) throw new Error('Invalid lock owner metadata; inspect the lock before retrying.');
  return parsed;
}
async function removeOwnedMarker(path: string, marker: string): Promise<void> {
  try { await unlink(join(path, marker)); } catch (error) {
    if (code(error) === 'ENOENT') return;
    throw error;
  }
  await rmdir(path).catch(error => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
  });
}
async function inspectAndReclaim(path: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(path); } catch (error) {
    if (code(error) === 'ENOENT') return;
    if (code(error) !== 'ENOTDIR') throw error;
    const existing = await metadata(path);
    if (processExists(existing.pid)) throw new Error(`${existing.label} is already running (pid ${existing.pid}).`);
    // unlink cannot remove a replacement directory published by another starter.
    await unlink(path).catch(err => { if (code(err) !== 'ENOENT') throw err; });
    return;
  }
  if (entries.length === 0) {
    throw new Error('Lock ownership is being published or was interrupted; inspect the empty lock directory before retrying.');
  }
  if (entries.length !== 1 || !entries[0]?.startsWith('owner-')) throw new Error('Unrecognized lock contents; inspect the lock before retrying.');
  const marker = entries[0];
  let existing: LockMetadata;
  try { existing = await metadata(join(path, marker)); } catch (error) { if (code(error) === 'ENOENT') return; throw error; }
  // Heartbeat expiry cannot distinguish a stalled live holder from a recycled PID.
  if (processExists(existing.pid)) throw new Error(`${existing.label} is already running (pid ${existing.pid}).`);
  await removeOwnedMarker(path, marker);
}
async function acquireNamedLock(path: string, label: string): Promise<() => Promise<void>> {
  const marker = `owner-${randomUUID()}.json`;
  const startedAt = Date.now();
  let acquired = false;
  for (let attempt=0;attempt<5;attempt++) {
    try { await mkdir(path); acquired = true; break; } catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      await inspectAndReclaim(path);
    }
  }
  if (!acquired) throw new Error('Another TrackerBot starter owns or is acquiring the lock. Retry shortly.');
  try {
    await writeFile(join(path, marker), JSON.stringify({pid:process.pid, startedAt, heartbeatAt:startedAt, label} satisfies LockMetadata), {flag:'wx'});
  } catch (error) {
    await unlink(join(path, marker)).catch(() => {});
    await rmdir(path).catch(() => {});
    throw error;
  }
  let heartbeatWrite = Promise.resolve();
  const heartbeat = setInterval(() => {
    const now = new Date();
    heartbeatWrite = heartbeatWrite.then(() => utimes(join(path, marker), now, now)).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await heartbeatWrite;
    await removeOwnedMarker(path, marker);
  };
}
export async function acquireSingleInstanceLock() { return acquireNamedLock(lockFilePath, 'Another local TrackerBot instance'); }
export async function acquireSharedDiscordTokenLock(tokenKey: string, label: string) {
  return acquireNamedLock(join(tmpdir(), `tower-discord-token-${tokenKey}.lock`), label);
}
