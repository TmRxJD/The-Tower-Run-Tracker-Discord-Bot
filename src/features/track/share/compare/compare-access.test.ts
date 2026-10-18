import { beforeEach, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => vi.fn());
vi.mock('../../tracker-api-client', () => ({ getUserSettings: settings }));
import { resolveCompareAccess, sourceHasShareAction } from './compare-access';
import { TRACKER_IDS } from '../../track-custom-ids';
import { buildShareEmbed } from '../share-embed';

const ref = 'owner:S-' + 'a'.repeat(32);
const rows = (prefix: string, value = ref) => [{ components: [{ customId: prefix + value }] }];
beforeEach(() => { vi.clearAllMocks(); settings.mockResolvedValue({ shareNotes: false, shareCoverageBlackHole: false }); });

it('uses the same enabled expanded details as public Expand, even for a compact source', async () => {
  const result = await resolveCompareAccess(ref, { description: 'Tier: **10**\nWave: **100**\nCoins: **1B** (1B/hr)' }, rows(TRACKER_IDS.share.expandPrefix));
  expect(settings).toHaveBeenCalledWith('owner');
  expect(result.options).toMatchObject({ includeTotalCells: true, includeTotalDice: true, includeShardsPerHour: true,
    includeCoverage: true, includeCoverageBlackHole: false, includeNotes: false });
});
it('keeps report access separate and requires its exact source-share control', async () => {
  expect((await resolveCompareAccess(ref, {}, rows(TRACKER_IDS.share.reportPrefix))).canCompareReports).toBe(true);
  expect((await resolveCompareAccess(ref, {}, rows(TRACKER_IDS.share.reportPrefix, 'other:run'))).canCompareReports).toBe(false);
  expect(settings).not.toHaveBeenCalled();
  expect(sourceHasShareAction([{ components: [{ custom_id: TRACKER_IDS.share.reportPrefix + ref }] }], TRACKER_IDS.share.reportPrefix + ref)).toBe(true);
});
it('does not grant expanded or hidden coverage fields without public Expand', async () => {
  const embed = buildShareEmbed({ user: { username: 'fixture' }, run: { tier: '10', wave: '100', totalCoins: '1B' }, runTypeCounts: {}, collapsed: true }).data;
  const result = await resolveCompareAccess(ref, embed, []);
  expect(result.options).toMatchObject({ includeTotalCells: false, includeDuration: false, includeCoverage: false, includeNotes: false });
  expect(settings).not.toHaveBeenCalled();
});
it('includes already public expanded notes/coverage but keeps hidden coverage toggles off', async () => {
  const embed = buildShareEmbed({ user: { username: 'fixture' }, run: { wave: '100', notes: 'Public note', totalEnemies: 1000, killsWithGoldenTower: 500, killsWithBlackHole: 500 },
    runTypeCounts: {}, options: { includeCoverageBlackHole: false } }).data;
  const result = await resolveCompareAccess(ref, embed, []);
  expect(result.options).toMatchObject({ includeNotes: true, includeCoverage: true, includeCoverageGoldenTower: true, includeCoverageBlackHole: false });
});
