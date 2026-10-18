import { describe, expect, it } from 'vitest';
import { expandedComparePages, battleReportComparePages } from './compare-model';
import { paginateCompareRows, reportDifference } from './compare-rows';
import { compareResult } from './compare-ui';
import { type CompareSession } from './compare-session';

const shared = { runId: 'shared', type: 'Farming', tier: '18', wave: '5000', roundDuration: '2h', totalCoins: '2T', totalCells: '10K', totalDice: '20K',
  cannonShardsFetched: 0, armorShardsFetched: 1, generatorShardsFetched: 2, coreShardsFetched: 3, deathDefy: 0,
  totalEnemies: 1000, killsWithGoldenTower: 500, killsWithBlackHole: 250, notes: 'Public note',
  fullRunData: { damageDealt: '10T', deathRayDamage: '2T', interestEarned: '1M', freeAttackUpgrade: 10, destroyedByProjectiles: 5,
    privateSaveData: { password: 'SECRET_SAVE' } } };
const mine = { ...shared, runId: 'mine', totalCoins: '4T', totalCells: '20K', totalDice: 0, notes: 'My private note', killsWithGoldenTower: 750,
  fullRunData: { ...shared.fullRunData, damageDealt: '20T', deathRayDamage: 0, interestEarned: '2M' } };
const context = { run: shared, sharerName: 'Alice' };

describe('expanded and full battle-report paired rows', () => {
  it('contains expanded cells, dice, shards, rates, coverage and notes with paired values on every row', () => {
    const pages = expandedComparePages(context, mine, {});
    const text = pages.map(page => page.text).join('\n');
    expect(text).toContain('S **10K** | Y **20K**');
    expect(text).toContain('S **20K** | Y **0**');
    expect(text).toContain('S **20K** | Y **0** · Δ (-100.00%)');
    expect(text).toContain('S **5K** | Y **10K**');
    expect(text).toContain('Per hour');
    expect(text).toContain('Golden Tower');
    expect(text).toContain('S **50%** | Y **75%**');
    expect(text).toContain('S **Public note** | Y **My private note**');
    expect(pages.length).toBeGreaterThan(1);
    expect(text).not.toContain('SECRET_SAVE');
    for (const page of pages) {
      expect(page.text.length).toBeLessThanOrEqual(2800);
      for (const row of page.text.split('\n').filter(line => line.startsWith('S '))) expect(row).toMatch(/^S .+ \| Y .+/);
    }
  });
  it('compares full report damage, utility, records and rewards beyond summary stats in canonical order', () => {
    const result = battleReportComparePages(shared, mine);
    const text = result.pages.map(page => page.text).join('\n');
    expect(text).toContain('Damage Dealt');
    expect(text).toContain('S **10T** | Y **20T** · Δ (+100.00%)');
    expect(text).toContain('S **2T** | Y **0** · Δ (-100.00%)');
    expect(text).toContain('S **1M** | Y **2M** · Δ (+100.00%)');
    expect(text).toContain('Free Attack Upgrade');
    expect(text.indexOf('**Damage**')).toBeLessThan(text.indexOf('**Enemies Destroyed By**'));
    expect(text).not.toMatch(/SECRET_SAVE|password|privateSaveData/);
    expect(result.sharedAvailable).toBe(true);
  });
  it('handles old/missing report captures and missing/zero denominators without inventing differences', () => {
    expect(battleReportComparePages({}, {})).toMatchObject({ pages: [], sharedAvailable: false, mineAvailable: false });
    const result = battleReportComparePages(shared, {});
    expect(result.pages.map(page => page.text).join('\n')).toContain('Y **Unavailable**');
    expect(reportDifference('deathRayDamage', '1T', '0')).toBe('');
    expect(reportDifference('deathRayDamage', null, '1T')).toBe('');
    expect(reportDifference('battleDate', '2026', '2025')).toBe('');
    expect(reportDifference('defensePercentBlocked', '75%', '50%')).toBe('(+50.00%)');
    const detail = expandedComparePages({ run: {}, sharerName: 'Alice' }, { totalCoins: 0, roundDuration: '2h' }, {}).map(page => page.text).join('\n');
    expect(detail).toContain('S **Unavailable** | Y **0**');
    expect(detail).not.toContain('S **0**');
    expect(detail).not.toContain('Δ');
  });
  it('compares the displayed hourly rates even if saved rate fields are stale', () => {
    const first = { ...shared, coinsPerHour: '100', cellsPerHour: '100', rerollShardsPerHour: '100' };
    const second = { ...mine, coinsPerHour: '100', cellsPerHour: '100', rerollShardsPerHour: '100' };
    const text = expandedComparePages({ run: first, sharerName: 'Alice' }, second, {}).map(page => page.text).join('\n');
    expect(text).toContain('S **1T** | Y **2T** · Δ (+100.00%)');
    expect(text).toContain('S **5K** | Y **10K** · Δ (+100.00%)');
    expect(text).toContain('S **10K** | Y **0** · Δ (-100.00%)');
  });
  it('preserves long labels/text and large values across pages without stacked embed fields', () => {
    const left = 'A'.repeat(1100), right = 'B'.repeat(900), label = 'Long metric label '.repeat(8);
    const pages = paginateCompareRows([{ section: 'Fixture', key: 'long', label, shared: left, mine: right }]);
    const text = pages.map(page => page.text).join('\n');
    expect((text.match(/A/g) ?? []).length).toBe(1100);
    expect((text.match(/B/g) ?? []).length).toBe(900);
    const session = { token: 'a'.repeat(24), revision: 1, ownerId: 'viewer', sourceKey: 'source', expiresAt: Date.now() + 1000, page: 0, busy: false,
      choices: [], recentOnly: false, options: {}, shared: context, canCompareReports: true, view: 'details', selected: { choice: { source: 'local', id: 'fixture', profileId: null, preview: {} }, run: mine, name: 'Bob', details: pages } } as CompareSession;
    const payload = compareResult(session, mine, 'Bob');
    expect(payload.embeds[0].toJSON().fields).toBeUndefined();
    expect(payload.embeds[0].toJSON().description!.length).toBeLessThanOrEqual(4096);
    expect(payload.components[0].toJSON().components).toHaveLength(5);
  });
});
