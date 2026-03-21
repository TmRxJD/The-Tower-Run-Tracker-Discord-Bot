import { describe, expect, it } from 'vitest';
import { parseRunDataFromText } from './upload-helpers';

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
});
