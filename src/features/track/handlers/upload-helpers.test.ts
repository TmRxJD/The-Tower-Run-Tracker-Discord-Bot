import { describe, expect, it } from 'vitest';
import { generateCoverageDescription, parseRunDataFromText } from './upload-helpers';

describe('upload-helpers single-line paste parsing', () => {
  it('parses the exact full single-line report without colliding wave, deathwave, enemy, or guardian fields', () => {
    const parsed = parseRunDataFromText(
      'Battle Report Battle Date    Mar 21, 2026 13:47 Game Time    2d 0h 25m 20s Real Time    9h 54m 5s Tier    11 Wave    7676 Killed By    Fast Coins earned    76.37T Coins per hour    7.71T Cash earned    $7.22B Interest earned    $127.02M Gem Blocks Tapped    5 Cells Earned    128.82K Reroll Shards Earned    16.80K Combat Damage Dealt    5.87N Damage Taken    4.50q Damage Taken Wall    780.27q Damage Taken While Berserked    0 Damage Gain From Berserk    x0.00 Death Defy    1 Lifesteal    0 Projectiles Damage    814.20Q Projectiles Count    17.47M Thorn damage    810.78O Orb Damage    4.83N Enemies Hit by Orbs    997.49K Land Mine Damage    6.43s Land Mines Spawned    373165 Rend Armor Damage    0 Death Ray Damage    0 Smart Missile Damage    0 Inner Land Mine Damage    89.56Q Chain Lightning Damage    0 Death Wave Damage    448.38q Tagged by Death Wave    167963 Swamp Damage    0 Black Hole Damage    231.63O Electrons Damage    0 Waves Skipped    1835 Recovery Packages    2362 Free Attack Upgrade    308 Free Defense Upgrade    5020 Free Utility Upgrade    629 HP From Death Wave    8.49T Coins From Death Wave    92.75B Cash From Golden Tower    $567.11M Coins From Golden Tower    2.41T Coins From Black Hole    783.39B Coins From Spotlight    109.24B Coins From Orb    0 Coins from Coin Upgrade    5.05T Coins from Coin Bonuses    67.45T Enemies Destroyed Total Enemies    1226980 Basic    475874 Fast    244031 Tank    232531 Ranged    207759 Boss    592 Protector    1145 Total Elites    6524 Vampires    2228 Rays    2077 Scatters    2219 Saboteur    0 Commander    0 Overcharge    0 Destroyed By Orbs    997490 Destroyed by Thorns    125748 Destroyed by Death Ray    0 Destroyed by Land Mine    58156 Destroyed in Spotlight    545137 Bots Flame Bot Damage    0 Thunder Bot Stuns    0 Golden Bot Coins Earned    215.00B Destroyed in Golden Bot    205121 Guardian Damage    0 Summoned enemies    95.22K Guardian coins stolen    0 Coins Fetched    175.61B Gems    8 Medals    4 Reroll Shards Fetched    420 Cannon Shards    30 Armor Shards    21 Generator Shards    21 Core Shards    27 Common Modules    3 Rare Modules    0',
    );

    expect(parsed).toMatchObject({
      tier: 11,
      wave: 7676,
      totalCoins: '76.37T',
      totalCells: '128.82K',
      totalDice: '16.80K',
      killedBy: 'Fast',
      deathWaveDamage: '448.38q',
      totalEnemies: '1226980',
      taggedByDeathWave: '167963',
      basic: '475874',
      fast: '244031',
      tank: '232531',
      ranged: '207759',
      boss: '592',
      protector: '1145',
      totalElites: '6524',
      destroyedByOrbs: '997490',
      destroyedInSpotlight: '545137',
      destroyedInGoldenBot: '205121',
      guardianSummonedEnemies: '95.22K',
      coinsFetched: '175.61B',
      gemsFetched: '8',
      medalsFetched: '4',
      rerollShardsFetched: '420',
      cannonShardsFetched: '30',
      armorShardsFetched: '21',
      generatorShardsFetched: '21',
      coreShardsFetched: '27',
      commonModulesFetched: '3',
      rareModulesFetched: '0',
    });
  });

  it('parses the flattened updated report from direct slash paste and preserves newer sections', () => {
    const parsed = parseRunDataFromText(
      'Battle Report Battle Date    Apr 06, 2026 11:03 Game Time    18h 57m 32s Real Time    3h 48m 47s Tier    18 Wave    4970 Killed By Coins Earned    1.30Q Coins Per Hour    340.60q Cells Earned    550.81K Cells Per Hour    144.44K Records Highest Coins / Minute    11.40q Largest Wave Skip    7 Most Coins From Wave Skip    6.69q Most Cells From Wave Skip    2.10K Largest Smart Missile Stack    17 Largest Golden Combo    782 Most Coins From Golden Combo    2.59q Largest Inner Landmine Charge    1393932 Damage Damage Dealt    44.09ab Projectiles    190.86aa Rend Armor    130.68D Death Ray    0 Thorns    660.86D Orbs    13.10ab Land Mines    3.62D Chain Lightning    25.02ab Smart Missiles    1.86aa Inner Land Mines    265.88aa Poison Swamp    258.91aa Death Wave    2.52D Black Hole    1.91ab Flame Bot    57.00O Attack Chip    0 Electrons    3.35ab Damage Taken Tower    49.68T Wall    8.36Q Bonus Health Gained From Death Wave    35.18T Health Regenerated Lifesteal    0 Tower Health Regen    0 Wall Health Regen    6.05q Damage Blocked Defense %    341.24Q Defense Absolute    15.60B Chrono Field    75.00Q Chain Thunder    63.26Q Flame Bot    27.48Q Primordial Collapse    196.42Q Negative Mass Projector    0 Utility Recovery Packages    1714 Free Attack Upgrade    318 Free Defense Upgrade    0 Free Utility Upgrade    190 Enemy Attack Levels Skipped    2731 Enemy Health Levels Skipped    2764 Counts Projectiles Count    10.19M Land Mines Spawned    258880 Thunder Bot Stuns    13.57K Waves Skipped    2703 Death Defy    0 Hits Absorbed By Energy Shield    2 Nuke    0 Second Wind    0 Demon Mode    0 Enemies Hit By Projectiles    581.51K Thorns    41 Orbs    322.60K Death Ray    0 Chain Lightning    599.76K Smart Missiles    208.13K Inner Land Mines    398.82K Poison Swamp    410.95K Death Wave    249.56K Black Hole    590.60K Chrono Field    558.87K Land Mines    563.16K Thunder Bot    11.77K Flame Bot    14.45K Attack Chip    0 Orbital Augment    237.57K Killed With Effect Active Golden Tower    599945 Death Wave    249.56K Spotlight    474861 Amplify Bot    47535 Golden Bot    372798 Death Penalty    0 Total Enemies Total Enemies    600067 Basic    125176 Fast    147984 Tank    138061 Ranged    131269 Boss    604 Protector    683 Vampires    2108 Rays    2061 Scatters    1998 Saboteur    17 Commander    16 Overcharge    16 Summoned Enemies    57.67K Coins Coins Earned    1.30Q Coin Bonus Upgrade    115.43q Coins From Coin Bonuses    583.49q Critical Coin    3.35q Golden Tower    113.15q Golden Combo    713.39q Death Wave    46.64q Spotlight    70.87q Black Hole    105.75q Orbs    24.49q Golden Bot    97.78q Wave Skip    467.07q Coins / Wave    199.07B Coins Fetched    1.94q Bounty Coins    0 Cash Cash Earned    $4.15T Golden Tower    $330.66B Interest earned    $57.78M Currencies Cells Earned    550.81K Gems    140 Ad Gems    115 Gem Blocks Tapped    1 Fetch Gems    8 Medals    1 Reroll Shards Earned    50.33K Reroll Shards Fetched    304 Cannon Shards    223 Armor Shards    215 Generator Shards    229 Core Shards    290 Common Modules    81 Rare Modules    6 Enemies Destroyed By Projectiles    914 Thorns    3 Land Mines    34 Orbs    190647 Chain Lightning    388792 Smart Missiles    669 Inner Land Mines    4656 Poison Swamp    5237 Death Ray    0 Black Hole    8935 Flame Bot    1 Other    0',
    );

    expect(parsed).toMatchObject({
      tier: 18,
      wave: 4970,
      killedBy: 'Apathy',
      totalCoins: '1.30Q',
      totalCells: '550.81K',
      totalDice: '50.33K',
      highestCoinsPerMinute: '11.40q',
      defensePercentBlocked: '341.24Q',
      enemyAttackLevelsSkipped: '2731',
      enemiesHitByProjectiles: '581.51K',
      killsWithGoldenTower: '599945',
      guardianSummonedEnemies: '57.67K',
      criticalCoinCoins: '3.35q',
      cashEarned: '4.15T',
      cashFromGoldenTower: '330.66B',
      gemsEarned: '140',
      rerollShardsFetched: '304',
      rareModulesFetched: '6',
      destroyedByProjectiles: '914',
      destroyedByChainLightning: '388792',
      destroyedByOther: '0',
    });
  });

  it('formats coverage description in the requested order and colors', () => {
    const description = generateCoverageDescription({
      totalEnemies: '100',
      killsWithGoldenTower: '10',
      enemiesHitByBlackHole: '20',
      destroyedInSpotlight: '30',
      taggedByDeathWave: '40',
      enemiesHitByOrbs: '50',
      destroyedInGoldenBot: '60',
      killsWithAmplifyBot: '70',
      guardianSummonedEnemies: '80',
    });

    expect(description).toBe([
      'Golden Tower: 10%',
      '🟨⬛⬛⬛⬛⬛⬛⬛⬛⬛',
      'Black Hole: 20%',
      '🟪🟪⬛⬛⬛⬛⬛⬛⬛⬛',
      'Spotlight: 30%',
      '⬜⬜⬜⬛⬛⬛⬛⬛⬛⬛',
      'Death Wave: 40%',
      '🟥🟥🟥🟥⬛⬛⬛⬛⬛⬛',
      'Orbs: 50%',
      '🟪🟪🟪🟪🟪⬛⬛⬛⬛⬛',
      'Golden Bot: 60%',
      '🟨🟨🟨🟨🟨🟨⬛⬛⬛⬛',
      'Amp Bot: 70%',
      '🟦🟦🟦🟦🟦🟦🟦⬛⬛⬛',
      'Summoned: 80%',
      '🟪🟪🟪🟪🟪🟪🟪🟪⬛⬛',
    ].join('\n'));
  });
});
