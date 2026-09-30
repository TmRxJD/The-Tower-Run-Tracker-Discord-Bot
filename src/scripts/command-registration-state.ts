import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Registering slash commands is slow when the bot is in many servers (a login, a guild
 * fetch, then one REST call per guild) and almost every deploy changes no commands. The
 * payload is hashed and compared with the hash of the last registration that fully
 * succeeded, so an unchanged payload skips all of that. `--force` bypasses the check.
 */
export interface RegistrationState {
  hash: string;
  registeredAt: string;
  commandCount: number;
}

/** Key order and array order never change what Discord stores, so neither may change the hash. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/**
 * `scope` ties the hash to whatever else decides where commands land (application id and
 * mode), so switching bot or environment always registers.
 */
export function hashCommandPayload(body: readonly unknown[], scope: string): string {
  // Builders serialise through toJSON, so normalise through JSON first.
  const plain = JSON.parse(JSON.stringify(body)) as Array<{ name?: unknown }>;
  const sorted = [...plain].sort((left, right) => String(left?.name ?? '').localeCompare(String(right?.name ?? '')));
  return createHash('sha256')
    .update(JSON.stringify({ scope, commands: canonicalize(sorted) }))
    .digest('hex');
}

export function registrationStatePath(mode: string, cwd = process.cwd()): string {
  return join(cwd, '.data', `registered-commands.${mode}.json`);
}

export async function readRegistrationState(path: string): Promise<RegistrationState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<RegistrationState>;
    return typeof parsed.hash === 'string' ? (parsed as RegistrationState) : null;
  } catch {
    // Missing or unreadable state just means "register".
    return null;
  }
}

export async function isRegistrationCurrent(path: string, hash: string): Promise<boolean> {
  return (await readRegistrationState(path))?.hash === hash;
}

/** Call only after every registration call succeeded, so a half-finished run is retried. */
export async function writeRegistrationState(path: string, hash: string, commandCount: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const state: RegistrationState = { hash, registeredAt: new Date().toISOString(), commandCount };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
