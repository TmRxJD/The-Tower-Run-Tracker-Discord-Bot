import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hashCommandPayload,
  isRegistrationCurrent,
  readRegistrationState,
  registrationStatePath,
  writeRegistrationState,
} from './command-registration-state';

const ping = { name: 'ping', description: 'Ping', options: [{ name: 'echo', type: 3, required: false }] };
const track = { name: 'track', description: 'Track a run', type: 1 };

describe('hashCommandPayload', () => {
  it('is stable for identical payloads', () => {
    expect(hashCommandPayload([ping, track], 'app:prod')).toBe(hashCommandPayload([ping, track], 'app:prod'));
  });

  it('ignores command order and object key order', () => {
    const reordered = { options: ping.options, description: 'Ping', name: 'ping' };
    expect(hashCommandPayload([track, reordered], 'app:prod')).toBe(hashCommandPayload([ping, track], 'app:prod'));
  });

  it('changes when a command is added, removed or edited', () => {
    const base = hashCommandPayload([ping, track], 'app:prod');
    expect(hashCommandPayload([ping], 'app:prod')).not.toBe(base);
    expect(hashCommandPayload([ping, track, { name: 'new', description: 'New' }], 'app:prod')).not.toBe(base);
    expect(hashCommandPayload([ping, { ...track, description: 'Track your run' }], 'app:prod')).not.toBe(base);
    expect(hashCommandPayload([{ ...ping, options: [{ ...ping.options[0], required: true }] }, track], 'app:prod')).not.toBe(base);
  });

  it('changes with the scope so another bot or mode always registers', () => {
    expect(hashCommandPayload([ping], 'app-1:prod')).not.toBe(hashCommandPayload([ping], 'app-2:prod'));
    expect(hashCommandPayload([ping], 'app-1:prod')).not.toBe(hashCommandPayload([ping], 'app-1:dev'));
  });

  it('hashes builders through toJSON and ignores undefined fields', () => {
    const builder = { toJSON: () => ({ name: 'ping', description: 'Ping', options: [{ name: 'echo', type: 3, required: false }] }) };
    expect(hashCommandPayload([builder], 's')).toBe(hashCommandPayload([{ ...ping, extra: undefined }], 's'));
  });
});

describe('registration state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmd-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is not current when nothing was ever registered', async () => {
    expect(await isRegistrationCurrent(registrationStatePath('prod', dir), 'abc')).toBe(false);
  });

  it('is current only for the hash that was written', async () => {
    const path = registrationStatePath('prod', dir);
    await writeRegistrationState(path, 'abc', 3);

    expect(await isRegistrationCurrent(path, 'abc')).toBe(true);
    expect(await isRegistrationCurrent(path, 'different')).toBe(false);
    expect(await readRegistrationState(path)).toMatchObject({ hash: 'abc', commandCount: 3 });
  });

  it('keeps prod and dev state separate', async () => {
    await writeRegistrationState(registrationStatePath('prod', dir), 'prod-hash', 1);
    expect(await isRegistrationCurrent(registrationStatePath('dev', dir), 'prod-hash')).toBe(false);
  });

  it('treats a corrupt state file as not registered', async () => {
    const path = registrationStatePath('prod', dir);
    await writeRegistrationState(path, 'abc', 1);
    writeFileSync(path, '{ not json');

    expect(await isRegistrationCurrent(path, 'abc')).toBe(false);
  });

  it('writes readable json', async () => {
    const path = registrationStatePath('prod', dir);
    await writeRegistrationState(path, 'abc', 2);
    expect(JSON.parse(readFileSync(path, 'utf8')).hash).toBe('abc');
  });
});
