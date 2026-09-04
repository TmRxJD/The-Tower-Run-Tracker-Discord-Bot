import { readdirSync } from 'node:fs';
import { logger } from '../core/logger';
import { getBotRxStorageDirectory } from './bot-rx-storage';

/**
 * Repairs the localstorage engine's indexes in place, without destroying any data.
 *
 * RxStorageInstanceLocalstorage.remove() deletes every document file first and the index
 * files last, so a process death in that window (a pm2 restart, a deploy, a crash) leaves
 * index entries pointing at documents that no longer exist. The next query calls
 * ensureNotFalsy(getDoc(docId)) on such a row and throws, which used to be recovered from
 * by wiping the whole shared database.
 *
 * That wipe was worse than the fault. It threw away every user's cache to fix one user's
 * dangling rows, and node-localstorage's removeItem is O(n) in stored keys — it walks the
 * entire key map on each removal — so removing everything is O(n^2) and fully synchronous:
 * measured at 3.6s for 5000 document files, well past the ~3s Discord allows for an
 * interaction ACK. The wipe therefore caused 10062 failures for every *other* user who ran
 * a command while it ran.
 *
 * Dropping the dangling index entries instead is a single pass, touches only the index
 * files, and leaves every document in place.
 */

/** Filenames are the URI-encoded storage keys, as written by node-localstorage. */
function decodeStorageKey(fileName: string): string | null {
  try {
    return decodeURIComponent(fileName);
  } catch {
    return null;
  }
}

type IndexFile = {
  /** The full storage key, e.g. `RxDB-ls-idx-<db>--<collection>--0<indexName>`. */
  key: string;
  /** Document key prefix for the same collection, e.g. `RxDB-ls-doc-<db>--<collection>--0-`. */
  documentKeyPrefix: string;
};

function parseIndexFile(decodedName: string): IndexFile | null {
  // `RxDB-ls-idx-<database>--<collection>--<version><indexName>`
  const match = /^RxDB-ls-idx-(.+?)--(.+?)--(\d+)/.exec(decodedName);
  if (!match) return null;
  const [, databaseName, collectionName, version] = match;
  return {
    key: decodedName,
    documentKeyPrefix: `RxDB-ls-doc-${databaseName}--${collectionName}--${version}-`,
  };
}

export type IndexRepairResult = {
  /** False when the active storage engine is not localstorage, so nothing was inspected. */
  applicable: boolean;
  /** Index entries dropped because their document file was gone. */
  removedEntries: number;
  /** Index files that were rewritten. */
  repairedIndexes: number;
};

export function repairBotRxStorageIndexes(): IndexRepairResult {
  const storageDirectory = getBotRxStorageDirectory();
  if (!storageDirectory) {
    return { applicable: false, removedEntries: 0, repairedIndexes: 0 };
  }

  const localStorage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
  if (!localStorage) {
    return { applicable: false, removedEntries: 0, repairedIndexes: 0 };
  }

  let fileNames: string[];
  try {
    fileNames = readdirSync(storageDirectory);
  } catch (error) {
    logger.warn('[rxdb-repair] could not read the storage directory', { storageDirectory, error });
    return { applicable: true, removedEntries: 0, repairedIndexes: 0 };
  }

  // One pass to learn which document keys actually exist on disk, so each index entry is a
  // set lookup rather than a stat.
  const presentKeys = new Set<string>();
  const indexFiles: IndexFile[] = [];
  for (const fileName of fileNames) {
    const decoded = decodeStorageKey(fileName);
    if (!decoded) continue;
    if (decoded.startsWith('RxDB-ls-doc-')) {
      presentKeys.add(decoded);
      continue;
    }
    if (decoded.startsWith('RxDB-ls-idx-')) {
      const parsed = parseIndexFile(decoded);
      if (parsed) indexFiles.push(parsed);
    }
  }

  let removedEntries = 0;
  let repairedIndexes = 0;

  for (const indexFile of indexFiles) {
    const raw = localStorage.getItem(indexFile.key);
    if (!raw) continue;

    let entries: [string, string][];
    try {
      entries = JSON.parse(raw) as [string, string][];
    } catch {
      // An index we cannot parse is not something this repair can reason about; leave it
      // for the caller's fallback rather than guessing at its contents.
      logger.warn('[rxdb-repair] skipping unparseable index', { key: indexFile.key });
      continue;
    }
    if (!Array.isArray(entries)) continue;

    const kept = entries.filter((entry) => {
      const documentId = Array.isArray(entry) ? entry[1] : undefined;
      if (typeof documentId !== 'string') return false;
      return presentKeys.has(indexFile.documentKeyPrefix + documentId);
    });

    if (kept.length !== entries.length) {
      removedEntries += entries.length - kept.length;
      repairedIndexes += 1;
      localStorage.setItem(indexFile.key, JSON.stringify(kept));
    }
  }

  return { applicable: true, removedEntries, repairedIndexes };
}
