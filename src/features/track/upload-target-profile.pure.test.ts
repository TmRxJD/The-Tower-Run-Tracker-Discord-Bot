import { describe, expect, it } from 'vitest';
import {
  formatProfileDisplayName,
  peekPendingUploadProfile,
  setPendingUploadProfile,
  type BotProfileOption,
} from './upload-target-profile';

const MAIN: BotProfileOption = { id: 'main-id', name: 'Main', isPrimary: true, index: 0, isDefault: false };
const ALT1: BotProfileOption = { id: 'alt-1', name: 'Alt One', isPrimary: false, index: 1, isDefault: true };

describe('pending upload-target map', () => {
  it('defaults to null (Main) for an unseen user', () => {
    expect(peekPendingUploadProfile('unseen-user')).toBeNull();
  });

  it('round-trips a set value and treats it as a peek (non-consuming)', () => {
    setPendingUploadProfile('user-a', 'alt-1');
    expect(peekPendingUploadProfile('user-a')).toBe('alt-1');
    // Peek does not clear the target — a multi-run import must stamp every run the same.
    expect(peekPendingUploadProfile('user-a')).toBe('alt-1');
  });

  it('keys by user id so one user cannot read another user target', () => {
    setPendingUploadProfile('user-a', 'alt-1');
    setPendingUploadProfile('user-b', null);
    expect(peekPendingUploadProfile('user-a')).toBe('alt-1');
    expect(peekPendingUploadProfile('user-b')).toBeNull();
  });

  it('trims the user id on both set and peek so whitespace cannot fork the key', () => {
    setPendingUploadProfile('  user-c  ', 'alt-9');
    expect(peekPendingUploadProfile('user-c')).toBe('alt-9');
  });

  it('resetting to Main clears a previously targeted alt', () => {
    setPendingUploadProfile('user-d', 'alt-1');
    setPendingUploadProfile('user-d', null);
    expect(peekPendingUploadProfile('user-d')).toBeNull();
  });
});

describe('formatProfileDisplayName (Main-safe fallbacks)', () => {
  const options = [MAIN, ALT1];

  it('renders Main for null/undefined', () => {
    expect(formatProfileDisplayName(options, null)).toBe('Main');
    expect(formatProfileDisplayName(options, undefined)).toBe('Main');
  });

  it('renders Main for an unknown (deleted) profile id rather than a wrong name', () => {
    expect(formatProfileDisplayName(options, 'ghost-id')).toBe('Main');
  });

  it('renders the alt name for a known alt id', () => {
    expect(formatProfileDisplayName(options, 'alt-1')).toBe('Alt One');
  });

  it('renders Main when the id resolves to the primary profile', () => {
    expect(formatProfileDisplayName(options, 'main-id')).toBe('Main');
  });
});
