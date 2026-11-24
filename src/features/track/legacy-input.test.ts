import { afterEach, expect, it, vi } from 'vitest';
import { getSlashCommandRegistrationPayload } from '../../commands/slash-command-data';
import { buildTrackerCommandData } from '../../commands/tracker-command-shared';
import { createConfirmationButtons, createInitialEmbed, createMainMenuButtons } from './ui/tracker-ui';
import { TRACKER_IDS } from './track-custom-ids';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, 'false', 'true'])('legacy switch %s is reflected in slash definitions and actual menus', (setting) => {
  vi.stubEnv('TRACKER_BOT_ENABLE_LEGACY_INPUT', setting);
  const enabled = setting === 'true';
  const registration = getSlashCommandRegistrationPayload() as Array<ReturnType<typeof buildTrackerCommandData>>;
  for (const name of ['track', 'lifetime'] as const) {
    const payload = registration.find(command => command.name === name);
    expect(payload?.options?.some(option => option.name === 'screenshot')).toBe(enabled);
    const runtime = buildTrackerCommandData(name);
    expect(runtime.options?.some(option => option.name === 'screenshot')).toBe(enabled);
    const ids = JSON.stringify(createMainMenuButtons(name).map(row => row.toJSON()));
    expect(ids.includes(TRACKER_IDS.flow.manual)).toBe(enabled);
    expect(ids.includes(TRACKER_IDS.flow.addRun)).toBe(name === 'track' || enabled);
    expect(ids).toContain(TRACKER_IDS.flow.editLast);
    expect(ids).toContain(TRACKER_IDS.flow.import);
    if (!enabled) {
      const menu = createInitialEmbed({ mode: name, userLabel: 'fixture' }).toJSON();
      expect(JSON.stringify(menu)).not.toMatch(/Manual Entry|automatic data extraction|Paste or Scan/);
      expect(JSON.stringify(menu)).toMatch(/Battle Report export|Import Lifetime Stats/);
    }
  }
  const track = registration.find(command => command.name === 'track');
  expect(track?.options?.map(option => option.name)).toEqual(expect.arrayContaining(['paste', 'savefile']));
  expect(JSON.stringify(createConfirmationButtons('fixture').map(row => row.toJSON()))).toContain(TRACKER_IDS.review.editPrefix);
});
