import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StorageModule = Awaited<ReturnType<typeof importStorage>>;

function importStorage() {
  return import('./bot-rx-storage.js');
}

const ENV_KEYS = ['TRACKER_BOT_RXDB_STORAGE', 'TRACKER_BOT_RXDB_DATA_DIR'] as const;

describe('bot RxDB storage quarantine', () => {
  let root: string;
  let dataDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  async function loadModule(): Promise<StorageModule> {
    vi.resetModules();
    return importStorage();
  }

  async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check();
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'rx-quarantine-'));
    dataDir = join(root, 'rxdb-bot-localstorage');
    process.env.TRACKER_BOT_RXDB_STORAGE = 'localstorage';
    process.env.TRACKER_BOT_RXDB_DATA_DIR = dataDir;
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults to the memory engine and keeps localstorage opt-in', async () => {
    delete process.env.TRACKER_BOT_RXDB_STORAGE;
    expect((await loadModule()).botRxStorageNeedsQuarantine()).toBe(false);

    process.env.TRACKER_BOT_RXDB_STORAGE = 'localstorage';
    expect((await loadModule()).botRxStorageNeedsQuarantine()).toBe(true);
  });

  it('only applies to the localstorage engine', async () => {
    process.env.TRACKER_BOT_RXDB_STORAGE = 'memory';
    const storage = await loadModule();

    expect(storage.botRxStorageNeedsQuarantine()).toBe(false);
    await expect(storage.quarantineBotRxStorage('test')).resolves.toBeNull();
  });

  it('moves the store aside, opens an empty one, and retires the old handle', async () => {
    const storage = await loadModule();
    storage.ensureBotRxStorageEnvironment();

    const before = (globalThis as { localStorage?: Storage }).localStorage!;
    before.setItem('doc-a', '1');
    before.setItem('doc-b', '2');
    expect(readdirSync(dataDir)).toHaveLength(2);

    const quarantined = await storage.quarantineBotRxStorage('test');

    expect(quarantined).toContain('.quarantine-');
    const after = (globalThis as { localStorage?: Storage }).localStorage!;
    expect(Object.is(after, before)).toBe(false);
    expect(after.getItem('doc-a')).toBeNull();
    expect(readdirSync(dataDir)).toHaveLength(0);
    // The stale handle must not be able to write into the replacement store.
    expect(() => before.setItem('doc-c', '3')).toThrow(/retired/);
    expect(() => before.removeItem('doc-a')).toThrow(/retired/);
  });

  it('purges quarantined stores from a detached process', async () => {
    const storage = await loadModule();
    storage.ensureBotRxStorageEnvironment();
    (globalThis as { localStorage?: Storage }).localStorage!.setItem('doc-a', '1');

    const quarantined = await storage.quarantineBotRxStorage('test');

    expect(quarantined).not.toBeNull();
    expect(await waitFor(() => !existsSync(quarantined!))).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
  });

  it('purges leftovers from an earlier run without touching the live store', async () => {
    const storage = await loadModule();
    storage.ensureBotRxStorageEnvironment();
    (globalThis as { localStorage?: Storage }).localStorage!.setItem('live', '1');

    const leftover = `${dataDir}.quarantine-1`;
    rmSync(leftover, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'old'), 'x');

    storage.purgeQuarantinedBotRxStorage();

    expect(await waitFor(() => !existsSync(leftover))).toBe(true);
    expect(readdirSync(dataDir)).toEqual(['live']);
  });

  it('refuses to quarantine repeatedly in a short window', async () => {
    const storage = await loadModule();
    storage.ensureBotRxStorageEnvironment();

    await storage.quarantineBotRxStorage('first');

    await expect(storage.quarantineBotRxStorage('second')).rejects.toThrow(/refusing to do it again/);
  });
});
