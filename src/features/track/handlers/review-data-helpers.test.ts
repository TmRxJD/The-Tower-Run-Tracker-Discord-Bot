import { parseBattleReportRunData } from '@tmrxjd/platform/parity';
import { describe, expect, it } from 'vitest';
import { buildRawParseText, buildSubmitPayload, resolveRawParseSourceData } from './review-data-helpers';
import type { RunDataRecord } from '../shared/track-review-records';

const updatedBattleReportFixture = `Battle Report
Battle Date    Apr 06, 2026 11:03
Game Time    18h 57m 32s
Real Time    3h 48m 47s
Tier    18
Wave    4970
Killed By
Coins Earned    1.30Q
Coins Per Hour    340.60q
Cells Earned    550.81K
Cells Per Hour    144.44K
Records
Highest Coins / Minute    11.40q
Largest Wave Skip    7
Most Coins From Wave Skip    6.69q
Most Cells From Wave Skip    2.10K
Largest Smart Missile Stack    17
Largest Golden Combo    782
Most Coins From Golden Combo    2.59q
Largest Inner Landmine Charge    1393932
Damage
Damage Dealt    44.09ab
Projectiles    190.86aa
Rend Armor    130.68D
Death Ray    0
Thorns    660.86D
Orbs    13.10ab
Land Mines    3.62D
Chain Lightning    25.02ab
Smart Missiles    1.86aa
Inner Land Mines    265.88aa
Poison Swamp    258.91aa
Death Wave    2.52D
Black Hole    1.91ab
Flame Bot    57.00O
Attack Chip    0
Electrons    3.35ab
Damage Taken
Tower    49.68T
Wall    8.36Q
Bonus Health Gained
From Death Wave    35.18T
Health Regenerated
Lifesteal    0
Tower Health Regen    0
Wall Health Regen    6.05q
Damage Blocked
Defense %    341.24Q
Defense Absolute    15.60B
Chrono Field    75.00Q
Chain Thunder    63.26Q
Flame Bot    27.48Q
Primordial Collapse    196.42Q
Negative Mass Projector    0
Utility
Recovery Packages    1714
Free Attack Upgrade    318
Free Defense Upgrade    0
Free Utility Upgrade    190
Enemy Attack Levels Skipped    2731
Enemy Health Levels Skipped    2764
Counts
Projectiles Count    10.19M
Land Mines Spawned    258880
Thunder Bot Stuns    13.57K
Waves Skipped    2703
Death Defy    0
Hits Absorbed By Energy Shield    2
Nuke    0
Second Wind    0
Demon Mode    0
Enemies Hit By
Projectiles    581.51K
Thorns    41
Orbs    322.60K
Death Ray    0
Chain Lightning    599.76K
Smart Missiles    208.13K
Inner Land Mines    398.82K
Poison Swamp    410.95K
Death Wave    249.56K
Black Hole    590.60K
Chrono Field    558.87K
Land Mines    563.16K
Thunder Bot    11.77K
Flame Bot    14.45K
Attack Chip    0
Orbital Augment    237.57K
Killed With Effect Active
Golden Tower    599945
Death Wave    249.56K
Spotlight    474861
Amplify Bot    47535
Golden Bot    372798
Death Penalty    0
Total Enemies
Total Enemies    600067
Basic    125176
Fast    147984
Tank    138061
Ranged    131269
Boss    604
Protector    683
Vampires    2108
Rays    2061
Scatters    1998
Saboteur    17
Commander    16
Overcharge    16
Summoned Enemies    57.67K
Coins
Coins Earned    1.30Q
Coin Bonus Upgrade    115.43q
Coins From Coin Bonuses    583.49q
Critical Coin    3.35q
Golden Tower    113.15q
Golden Combo    713.39q
Death Wave    46.64q
Spotlight    70.87q
Black Hole    105.75q
Orbs    24.49q
Golden Bot    97.78q
Wave Skip    467.07q
Coins / Wave    199.07B
Coins Fetched    1.94q
Bounty Coins    0
Cash
Cash Earned    $4.15T
Golden Tower    $330.66B
Interest earned    $57.78M
Currencies
Cells Earned    550.81K
Gems    140
Ad Gems    115
Gem Blocks Tapped    1
Fetch Gems    8
Medals    1
Reroll Shards Earned    50.33K
Reroll Shards Fetched    304
Cannon Shards    223
Armor Shards    215
Generator Shards    229
Core Shards    290
Common Modules    81
Rare Modules    6
Enemies Destroyed By
Projectiles    914
Thorns    3
Land Mines    34
Orbs    190647
Chain Lightning    388792
Smart Missiles    669
Inner Land Mines    4656
Poison Swamp    5237
Death Ray    0
Black Hole    8935
Flame Bot    1
Other    0`;

describe('review-data-helpers', () => {
  it('formats only scanned battle report fields in shared report order', () => {
    const text = buildRawParseText({
      values: {
        battleDate: 'Mar 26, 2026 06:10',
        gameTime: '20h 4m 30s',
        roundDuration: '4h 3m 56s',
        tier: '20',
        wave: '5169',
        totalCoins: '16.17Q',
        damageDealt: '1.32ad',
        totalEnemies: '678115',
        guardianSummonedEnemies: '72.44K',
      },
      tierDisplay: '20',
      type: 'Farming',
      notes: 'hello',
      reportTimestamp: '2026-03-26T06:10:00.000Z',
    });

    expect(text).toBe([
      'Battle Report',
      'Battle Date\tMar 26, 2026 06:10',
      'Game Time\t20h 4m 30s',
      'Real Time\t4h 3m 56s',
      'Tier\t20',
      'Wave\t5169',
      'Coins earned\t16.17Q',
      'Combat',
      'Damage Dealt\t1.32ad',
      'Enemies Destroyed',
      'Total Enemies\t678115',
      'Guardian',
      'Summoned enemies\t72.44K',
    ].join('\n'));
    expect(text).not.toContain('type');
    expect(text).not.toContain('notes');
    expect(text).not.toContain('reportTimestamp');
  });

  it('formats raw parse text from canonical scanned values when conflicting aliases exist', () => {
    const text = buildRawParseText({
      values: {
        wave: '7676',
        killedBy: 'Fast',
        totalDice: '16.80K',
      },
      wave: '7676',
      Wave: '167963',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      totalDice: '16.80K',
      rerollShards: '420',
    });

    expect(text).toContain('Wave\t7676');
    expect(text).toContain('Killed By\tFast');
    expect(text).toContain('Reroll Shards Earned\t16.80K');
    expect(text).not.toContain('Wave: 167963');
    expect(text).not.toContain('Killed By: Apathy');
  });

  it('renders updated battle report parses in the newer section order', () => {
    const text = buildRawParseText({
      values: {
        highestCoinsPerMinute: '11.40q',
        totalEnemies: '600067',
        basic: '125176',
        guardianSummonedEnemies: '57.67K',
        goldenBotCoinsEarned: '97.78q',
        coinsFetched: '1.94q',
        gemsEarned: '140',
        rareModulesFetched: '6',
        destroyedByProjectiles: '914',
        destroyedByOther: '0',
      },
    });

    expect(text).toContain(['Records', 'Highest Coins / Minute\t11.40q'].join('\n'));
      expect(text).toContain(['Total Enemies', 'Total Enemies\t600067', 'Basic\t125176', 'Summoned Enemies\t57.67K'].join('\n'));
    expect(text).toContain(['Coins', 'Golden Bot\t97.78q', 'Coins Fetched\t1.94q'].join('\n'));
    expect(text).toContain(['Currencies', 'Gems\t140', 'Rare Modules\t6'].join('\n'));
    expect(text).toContain(['Enemies Destroyed By', 'Projectiles\t914', 'Other\t0'].join('\n'));
    expect(text).not.toContain('Guardian\nSummoned enemies\t57.67K');
    expect(text).not.toContain('Bots\nGolden Bot Coins Earned\t97.78q');
  });

  it('round-trips the provided updated report into an accurate raw parse output', () => {
    const parsed = parseBattleReportRunData(updatedBattleReportFixture);

    expect(parsed).not.toBeNull();

    const text = buildRawParseText(parsed! as unknown as RunDataRecord);

    expect(text).toContain('Battle Date\tApr 06, 2026 11:03');
    expect(text).toContain('\nKilled By\n');
    expect(text).toContain(['Enemies Hit By', 'Projectiles\t581.51K', 'Thorns\t41', 'Orbs\t322.60K', 'Death Ray\t0'].join('\n'));
      expect(text).toContain(['Killed With Effect Active', 'Golden Tower\t599945', 'Death Wave\t249.56K', 'Spotlight\t474861', 'Amplify Bot\t47535', 'Golden Bot\t372798', 'Death Penalty\t0'].join('\n'));
    expect(text).toContain(['Coins', 'Coins Earned\t1.30Q', 'Coin Bonus Upgrade\t115.43q', 'Coins From Coin Bonuses\t583.49q'].join('\n'));
    expect(text).toContain(['Currencies', 'Cells Earned\t550.81K', 'Gems\t140', 'Ad Gems\t115'].join('\n'));
    expect(text).not.toContain('Killed By\tApathy');
    expect(text).not.toContain('Enemies Hit by Orbs\t322.60K');
    expect(text).not.toContain('Tagged by Death Wave\t249.56K');
    expect(text).not.toContain('Destroyed in Spotlight\t474861');
    expect(text).not.toContain('Destroyed in Golden Bot\t372798');
  });

  it('prefers canonical parser data when building the full parse source', () => {
    const source = resolveRawParseSourceData(
      {
        taggedByDeathWave: '17',
        destroyedInSpotlight: '22',
        notes: 'keep note',
      },
      {
        values: {
          taggedByDeathWave: '249.56K',
          destroyedInSpotlight: '474861',
        },
        taggedByDeathWave: '249.56K',
        destroyedInSpotlight: '474861',
      },
    );

    expect(source).toMatchObject({
      notes: 'keep note',
      taggedByDeathWave: '249.56K',
      destroyedInSpotlight: '474861',
      values: {
        taggedByDeathWave: '249.56K',
        destroyedInSpotlight: '474861',
      },
    });
  });

  it('builds a submit payload with normalized type and notes', async () => {
    const payload = await buildSubmitPayload('user-1', 'name', {
      tierDisplay: '7+',
      wave: '321',
      'Coins earned': '99',
      duration: '1h2m3s',
      killedBy: 'Boss',
      date: '2026-03-13',
      time: '09:10 PM',
      type: 'overnight',
      notes: 'stored note',
    }, true, true);

    expect(payload).toMatchObject({
      userId: 'user-1',
      username: 'name',
      note: 'stored note',
    });
    expect(payload.runData).toMatchObject({
      tier: '7+',
      wave: '321',
      totalCoins: '99',
      roundDuration: '1h2m3s',
      killedBy: 'Boss',
      date: '2026-03-13',
      time: '09:10 PM',
      type: 'Overnight',
      notes: 'stored note',
    });
  });

  it('fills missing submit payload fields with defaults when optional fields are excluded', async () => {
    const payload = await buildSubmitPayload('user-2', 'name', {}, false, false);

    expect(payload.note).toBe('');
    expect(payload.runData).toMatchObject({
      tier: '1',
      wave: '1',
      totalCoins: '0',
      totalCells: '0',
      totalDice: '0',
      roundDuration: '0h0m0s',
      killedBy: 'Apathy',
    });
    expect(payload.runData.type).toBeUndefined();
    expect(payload.runData.notes).toBeUndefined();
  });

  it('builds submit payloads from canonical fields when aliases conflict', async () => {
    const payload = await buildSubmitPayload('user-3', 'name', {
      wave: '7676',
      Wave: '167963',
      totalCoins: '76.37T',
      coins: '76.37T',
      totalCells: '128.82K',
      cells: '128.82K',
      totalDice: '16.80K',
      rerollShards: '420',
      killedBy: 'Fast',
      'Killed By': 'Apathy',
      roundDuration: '9h54m5s',
      date: '2026-03-21',
      time: '13:47:00',
    }, false, false);

    expect(payload.runData).toMatchObject({
      wave: '7676',
      totalCoins: '76.37T',
      totalCells: '128.82K',
      totalDice: '16.80K',
      killedBy: 'Fast',
    });
  });
});