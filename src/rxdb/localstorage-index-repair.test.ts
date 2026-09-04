import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairBotRxStorageIndexes } from './localstorage-index-repair';

const DOC_KEY = 'RxDB-ls-doc-tracker_bot_rxdb_shared--run_part_1--0-';
const INDEX_KEY = 'RxDB-ls-idx-tracker_bot_rxdb_shared--run_part_1--0_deleted|botScopeUserId|id';

type MutableGlobal = typeof globalThis & { localStorage?: Storage };

describe('repairBotRxStorageIndexes', () => {
  let directory: string;
  let previousMode: string | undefined;
  let previousDir: string | undefined;
  let previousLocalStorage: Storage | undefined;

  /** node-localstorage stores one file per key, named with the URI-encoded key. */
  const fileFor = (key: string) => join(directory, encodeURIComponent(key));

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'idx-repair-'));
    previousMode = process.env.TRACKER_BOT_RXDB_STORAGE;
    previousDir = process.env.TRACKER_BOT_RXDB_DATA_DIR;
    process.env.TRACKER_BOT_RXDB_STORAGE = 'localstorage';
    process.env.TRACKER_BOT_RXDB_DATA_DIR = directory;

    previousLocalStorage = (globalThis as MutableGlobal).localStorage;
    (globalThis as MutableGlobal).localStorage = {
      getItem: (key: string) => {
        try {
          return readFileSync(fileFor(key), 'utf8');
        } catch {
          return null;
        }
      },
      setItem: (key: string, value: string) => writeFileSync(fileFor(key), value, 'utf8'),
    } as unknown as Storage;
  });

  afterEach(() => {
    if (previousMode === undefined) delete process.env.TRACKER_BOT_RXDB_STORAGE;
    else process.env.TRACKER_BOT_RXDB_STORAGE = previousMode;
    if (previousDir === undefined) delete process.env.TRACKER_BOT_RXDB_DATA_DIR;
    else process.env.TRACKER_BOT_RXDB_DATA_DIR = previousDir;
    (globalThis as MutableGlobal).localStorage = previousLocalStorage;
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * remove() deletes document files before index files, so a process death in between
   * leaves index rows pointing at documents that are gone. query() calls
   * ensureNotFalsy(getDoc(id)) on such a row and throws.
   */
  it('drops index entries whose document file is gone and keeps the rest', () => {
    writeFileSync(fileFor(`${DOC_KEY}alive`), JSON.stringify({ id: 'alive' }), 'utf8');
    writeFileSync(
      fileFor(INDEX_KEY),
      JSON.stringify([['idx-a', 'alive'], ['idx-b', 'deleted-doc']]),
      'utf8',
    );

    const result = repairBotRxStorageIndexes();

    expect(result.applicable).toBe(true);
    expect(result.removedEntries).toBe(1);
    expect(result.repairedIndexes).toBe(1);
    expect(JSON.parse(readFileSync(fileFor(INDEX_KEY), 'utf8'))).toEqual([['idx-a', 'alive']]);
  });

  it('leaves a healthy index untouched', () => {
    writeFileSync(fileFor(`${DOC_KEY}alive`), JSON.stringify({ id: 'alive' }), 'utf8');
    writeFileSync(fileFor(INDEX_KEY), JSON.stringify([['idx-a', 'alive']]), 'utf8');

    const result = repairBotRxStorageIndexes();

    expect(result.removedEntries).toBe(0);
    expect(result.repairedIndexes).toBe(0);
  });

  it('reports itself inapplicable when the engine is not localstorage', () => {
    process.env.TRACKER_BOT_RXDB_STORAGE = 'memory';
    expect(repairBotRxStorageIndexes().applicable).toBe(false);
  });
});
