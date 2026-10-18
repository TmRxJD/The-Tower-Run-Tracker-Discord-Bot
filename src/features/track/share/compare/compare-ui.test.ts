import { describe, expect, it } from 'vitest';
import { buildShareEmbed } from '../share-embed';
import { visibleCompareOptions, compareResult, comparePicker } from './compare-ui';
import { type CompareSession } from './compare-session';

const shared = { type: 'Farming', tier: '10', wave: '1000', totalCoins: '1B', totalCells: 0, roundDuration: '1h' };
const session = (description: string): CompareSession => ({ token: 'a'.repeat(24), sourceKey: 'owner:message', ownerId: 'owner', messageId: 'private', page: 0,
  revision: 0, busy: false, expiresAt: Date.now() + 1000, shared: { run: shared, sharerName: 'Alice' }, options: visibleCompareOptions(description), choices: [], recentOnly: false });
const desc = (run = shared, options = {}, collapsed = false) => buildShareEmbed({ user: { username: 'Alice' }, run, runTypeCounts: {}, options, collapsed }).data.description!;

describe('private comparison presentation', () => {
  it('pairs both values on each metric row without mobile-stacking embed fields', () => {
    const s = session(desc());
    const result = compareResult(s, { ...shared, totalCoins: '2B', totalCells: '5K', totalDice: null, roundDuration: '0s' }, 'Bob');
    const data = result.embeds[0].toJSON();
    const text = JSON.stringify(data);
    expect(data.fields).toBeUndefined();
    expect(data.description).toContain('S **1B** | Y **2B**');
    expect(text).toContain('(+100.00%)');
    expect(text).toContain('Unavailable');
    expect(text).not.toMatch(/Infinity|NaN/);
    expect(text).not.toContain('(+500000.00%)');
    expect(result.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(data.description!.length).toBeLessThanOrEqual(4096);
  });
  it('never reveals hidden shared metrics, notes, coverage or screenshots through values or deltas', () => {
    const s = session(desc(shared, { includeTotalCoins: false, includeCoinsPerHour: false, includeCoverage: false }));
    s.shared.run = { ...shared, notes: 'PRIVATE_NOTE', screenshotUrl: 'https://private.invalid/secret', fullRunData: { secret: 'PRIVATE_REPORT' } };
    const text = JSON.stringify(compareResult(s, { ...shared, totalCoins: '999B' }, 'Bob').embeds[0].toJSON());
    expect(s.options.includeTotalCoins).toBe(false);
    expect(s.options.includeCoinsPerHour).toBe(false);
    expect(text).not.toContain('Coins:');
    expect(text).not.toContain('PRIVATE_');
    expect(text).not.toContain('private.invalid');
  });
  it('keeps compact shares limited to visible tier, wave, coins and their visible hourly rate', () => {
    const s = session(desc(shared, {}, true));
    expect(s.options).toMatchObject({ includeTier: true, includeWave: true, includeTotalCoins: true, includeCoinsPerHour: true,
      includeTotalCells: false, includeDicePerHour: false, includeDuration: false });
    const text = JSON.stringify(compareResult(s, shared, 'Bob').embeds[0].toJSON());
    expect(text).not.toContain('Cells:');
    expect(text).not.toContain('Duration:');
  });
  it('paginates 25 run choices with revisioned, bounded custom IDs', () => {
    const s = session(desc());
    s.choices = Array.from({ length: 30 }, (_, i) => ({ source: 'local' as const, id: String(i), profileId: null, preview: { wave: i } }));
    const first = comparePicker(s);
    expect(first.components[0].toJSON().components[0]).toMatchObject({ options: expect.any(Array) });
    expect((first.components[0].toJSON().components[0] as { options: unknown[] }).options).toHaveLength(25);
    s.page = 1; s.revision = 2;
    const last = comparePicker(s);
    const select = last.components[0].toJSON().components[0] as { options: Array<{ value: string }>; custom_id: string };
    expect(select.options).toHaveLength(5);
    expect(select.options[0].value).toBe('25');
    expect(select.custom_id.endsWith(':2')).toBe(true);
    expect(select.custom_id.length).toBeLessThanOrEqual(100);
  });
});
