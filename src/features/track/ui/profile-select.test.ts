import { describe, expect, it } from 'vitest';
import type { BotProfileOption } from '../upload-target-profile';
import {
  buildProfileSelectMenu,
  buildProfileSelectRow,
  MAIN_PROFILE_VALUE,
  resolveSelectedProfileId,
} from './profile-select';

const MAIN: BotProfileOption = { id: 'main-id', name: 'Main', isPrimary: true, index: 0, isDefault: false };
const ALT1: BotProfileOption = { id: 'alt-1', name: 'Alt One', isPrimary: false, index: 1, isDefault: true };
const ALT2: BotProfileOption = { id: 'alt-2', name: 'Alt Two', isPrimary: false, index: 2, isDefault: false };

describe('resolveSelectedProfileId (Main-safety mapping)', () => {
  it('maps the Main sentinel to null (unstamped)', () => {
    expect(resolveSelectedProfileId(MAIN_PROFILE_VALUE)).toBeNull();
  });

  it('maps null/undefined/empty to null (Main)', () => {
    expect(resolveSelectedProfileId(null)).toBeNull();
    expect(resolveSelectedProfileId(undefined)).toBeNull();
    expect(resolveSelectedProfileId('')).toBeNull();
  });

  it('passes through a real alt id unchanged', () => {
    expect(resolveSelectedProfileId('alt-2')).toBe('alt-2');
  });
});

describe('buildProfileSelectRow / buildProfileSelectMenu gating', () => {
  it('returns null when the user has zero or one profile (nothing to choose)', () => {
    expect(buildProfileSelectRow({ customId: 'c', options: [], selectedProfileId: null })).toBeNull();
    expect(buildProfileSelectRow({ customId: 'c', options: [MAIN], selectedProfileId: null })).toBeNull();
    expect(buildProfileSelectMenu({ customId: 'c', options: [MAIN], selectedProfileId: null })).toBeNull();
  });

  it('builds a row when there is more than one profile', () => {
    const row = buildProfileSelectRow({ customId: 'c', options: [MAIN, ALT1, ALT2], selectedProfileId: null });
    expect(row).not.toBeNull();
  });

  it('encodes Main as the sentinel value and marks it default when nothing is selected', () => {
    const menu = buildProfileSelectMenu({ customId: 'c', options: [MAIN, ALT1], selectedProfileId: null });
    const json = menu!.toJSON();
    const mainOption = json.options.find(option => option.label === 'Main');
    expect(mainOption?.value).toBe(MAIN_PROFILE_VALUE);
    expect(mainOption?.default).toBe(true);
  });

  it('marks the currently selected alt as default, not Main', () => {
    const menu = buildProfileSelectMenu({ customId: 'c', options: [MAIN, ALT1, ALT2], selectedProfileId: 'alt-2' });
    const json = menu!.toJSON();
    expect(json.options.find(option => option.value === 'alt-2')?.default).toBe(true);
    expect(json.options.find(option => option.value === MAIN_PROFILE_VALUE)?.default).toBe(false);
  });

  it('never emits a profile id as the value for the primary option', () => {
    const menu = buildProfileSelectMenu({ customId: 'c', options: [MAIN, ALT1], selectedProfileId: null });
    const json = menu!.toJSON();
    // Main must round-trip to null, never to its stored document id.
    for (const option of json.options) {
      if (option.label === 'Main') {
        expect(resolveSelectedProfileId(option.value)).toBeNull();
      }
    }
  });
});
