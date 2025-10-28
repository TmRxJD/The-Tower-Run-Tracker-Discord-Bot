const fs = require('fs');

/**
 * Parse battle report text into key-value pairs
 * @param {string} reportText - The raw battle report text
 * @returns {Object} - Object with keys and values
 */
function parseReport(reportText) {
    const lines = reportText.split('\n').filter(line => line.trim());
    const data = {};

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        // Split on 2 or more spaces or tabs
        const parts = raw.split(/\s{2,}|\t+/);
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join(' ').trim();
            data[key] = value;
        } else {
            console.log(`❌ Malformed line [${i + 1}]: "${raw}"`);
        }
    }

    return data;
}

/**
 * Compare two parsed reports and highlight differences
 * @param {Object} report1 - First parsed report
 * @param {Object} report2 - Second parsed report
 * @param {string} label1 - Label for first report
 * @param {string} label2 - Label for second report
 */
function compareReports(report1, report2, label1 = 'Report 1', label2 = 'Report 2') {
    const keys1 = Object.keys(report1);
    const keys2 = Object.keys(report2);

    console.log(`\n=== REPORT COMPARISON ===`);
    console.log(`${label1}: ${keys1.length} fields`);
    console.log(`${label2}: ${keys2.length} fields`);

    // Check for missing keys
    const missingIn2 = keys1.filter(key => !(key in report2));
    const missingIn1 = keys2.filter(key => !(key in report1));

    if (missingIn2.length > 0) {
        console.log(`\n❌ Keys missing in ${label2}:`);
        missingIn2.forEach(key => console.log(`  "${key}": "${report1[key]}"`));
    }

    if (missingIn1.length > 0) {
        console.log(`\n❌ Keys missing in ${label1}:`);
        missingIn1.forEach(key => console.log(`  "${key}": "${report2[key]}"`));
    }

    // Check for value differences
    const commonKeys = keys1.filter(key => key in report2);
    const valueDifferences = [];

    commonKeys.forEach(key => {
        const val1 = report1[key];
        const val2 = report2[key];
        if (val1 !== val2) {
            valueDifferences.push({ key, val1, val2 });
        }
    });

    if (valueDifferences.length > 0) {
        console.log(`\n⚠️  Value differences:`);
        valueDifferences.forEach(diff => {
            console.log(`  "${diff.key}":`);
            console.log(`    ${label1}: "${diff.val1}"`);
            console.log(`    ${label2}: "${diff.val2}"`);
        });
    }

    // Check for formatting issues
    console.log(`\n=== FORMATTING ANALYSIS ===`);

    // Check for invisible characters in keys
    const allKeys = [...new Set([...keys1, ...keys2])];
    const keysWithInvisibleChars = allKeys.filter(key => {
        const visible = key.replace(/[\x00-\x1F\x7F-\x9F\u00A0\u2000-\u200B\u2028-\u2029\u3000]/g, '');
        return visible !== key;
    });

    if (keysWithInvisibleChars.length > 0) {
        console.log(`\n❌ Keys with invisible characters:`);
        keysWithInvisibleChars.forEach(key => {
            console.log(`  "${key}" -> hex: ${hex}`);
        });
    }

    // Check for potential multi-line values
    const report1Text = Object.entries(report1).map(([k, v]) => `${k}    ${v}`).join('\n');
    const report2Text = Object.entries(report2).map(([k, v]) => `${k}    ${v}`).join('\n');

    console.log(`\n=== RAW TEXT LENGTHS ===`);
    console.log(`${label1}: ${report1Text.length} characters`);
    console.log(`${label2}: ${report2Text.length} characters`);

    return {
        missingIn2,
        missingIn1,
        valueDifferences,
        keysWithInvisibleChars
    };
}

// The two reports from the user
const workingReport = `Battle Report
Battle Date    Oct 15, 2025 23:11
Game Time    13h 34m 30s
Real Time    3h 23m 38s
Tier    14
Wave    3987
Killed By    Ranged
Coins earned    17.69T
Coins per hour    5.21T
Cash earned    $2.47T
Interest earned    $4.82M
Gem Blocks Tapped    4
Cells Earned    213.02K
Reroll Shards Earned    78.39K
Combat
Damage dealt    191.65ac
Damage Taken    147.49Q
Damage Taken Wall    21.43Q
Damage Taken While Berserked    2.31s
Damage Gain From Berserk    x8.00
Death Defy    3
Lifesteal    268.46T
Projectiles Damage    2.93ac
Projectiles Count    879.27K
Thorn damage    918.69ab
Orb Damage    71.35ac
Enemies Hit by Orbs    87.89K
Land Mine Damage    71.90aa
Land Mines Spawned    116941
Rend Armor Damage    82.40ab
Death Ray Damage    33.36ac
Smart Missile Damage    835.98ab
Inner Land Mine Damage    211.17D
Chain Lightning Damage    66.54ac
Death Wave Damage    754.05aa
Tagged by Deathwave    141573
Swamp Damage    666.81ab
Black Hole Damage    15.03ac
Utility
Waves Skipped    2378
Recovery Packages    1460
Free Attack Upgrade    597
Free Defense Upgrade    0
Free Utility Upgrade    66
HP From Death Wave    250.67T
Coins From Death Wave    1.85B
Cash From Golden Tower    $198.32B
Coins From Golden Tower    8.90T
Coins From Black Hole    15.12B
Coins From Spotlight    3.24B
Coins From Orb    389.26M
Coins from Coin Upgrade    13.32B
Coins from Coin Bonuses    8.70T
Enemies Destroyed
Total Enemies    356359
Basic    128545
Fast    66225
Tank    66576
Ranged    57096
Boss    474
Protector    602
Total Elites    3501
Vampires    1189
Rays    1176
Scatters    1136
Saboteur    36
Commander    34
Overcharge    33
Destroyed By Orbs    80532
Destroyed by Thorns    142
Destroyed by Death Ray    6643
Destroyed by Land Mine    12379
Destroyed in Spotlight    323393
Bots
Flame Bot Damage    59.87aa
Thunder Bot Stuns    152.12K
Golden Bot Coins Earned    0
Destroyed in Golden Bot    0
Guardian
Damage    0
Summoned enemies    0
Guardian coins stolen    0
Coins Fetched    57.66B
Gems    0
Medals    0
Reroll Shards    252
Cannon Shards    0
Armor Shards    12
Generator Shards    9
Core Shards    12
Common Modules    0
Rare Modules    0`;

const failingReport = `Battle Report
Battle Date	Oct 17, 2025 14:06
Game Time	1d 2h 42m 21s
Real Time	5h 20m 33s
Tier	15
Wave	5217
Killed By	Boss
Coins earned	2.03q
Coins per hour	380.70T
Cash earned	$1.41T
Interest earned	$87.97M
Gem Blocks Tapped	6
Cells Earned	257.58K
Reroll Shards Earned	28.03K
Combat
Damage dealt	7.60aa
Damage Taken	766.90Q
Damage Taken Wall	37.53Q
Damage Taken While Berserked	6.81s
Damage Gain From Berserk	x8.00
Death Defy	18
Lifesteal	68.31T
Projectiles Damage	42.20D
Projectiles Count	4.99M
Thorn damage	16.31D
Orb Damage	5.48aa
Enemies Hit by Orbs	462.60K
Land Mine Damage	172.66N
Land Mines Spawned	222717
Rend Armor Damage	212.92N
Death Ray Damage	0
Smart Missile Damage	28.62D
Inner Land Mine Damage	2.85N
Chain Lightning Damage	1.09aa
Death Wave Damage	59.91N
Tagged by Deathwave	415349
Swamp Damage	0
Black Hole Damage	940.93D
Utility
Waves Skipped	2046
Recovery Packages	2305
Free Attack Upgrade	442
Free Defense Upgrade	320
Free Utility Upgrade	219
HP From Death Wave	0.00
Coins From Death Wave	905.08B
Cash From Golden Tower	$1.01T
Coins From Golden Tower	19.77T
Coins From Black Hole	6.50T
Coins From Spotlight	1.07T
Coins From Orb	38.30B
Coins from Coin Upgrade	49.73T
Coins from Coin Bonuses	1.95q
Enemies Destroyed
Total Enemies	718916
Basic	176437
Fast	175046
Tank	164337
Ranged	153986
Boss	505
Protector	750
Total Elites	4443
Vampires	1489
Rays	1502
Scatters	1452
Saboteur	0
Commander	3
Overcharge	2
Destroyed By Orbs	294691
Destroyed by Thorns	60
Destroyed by Death Ray	0
Destroyed by Land Mine	610
Destroyed in Spotlight	458455
Bots
Flame Bot Damage	0
Thunder Bot Stuns	0
Golden Bot Coins Earned	3.95T
Destroyed in Golden Bot	227307
Guardian
Damage	0
Summoned enemies	0
Guardian coins stolen	3.95T
Coins Fetched	3.65T
Gems	0
Medals	0
Reroll Shards	270
Cannon Shards	6
Armor Shards	3
Generator Shards	9
Core Shards	12
Common Modules	1
Rare Modules	0`;

// Parse both reports
console.log('Parsing reports...');
const parsedWorking = parseReport(workingReport);
const parsedFailing = parseReport(failingReport);

// Compare them
const comparison = compareReports(parsedWorking, parsedFailing, 'Working Report', 'Failing Report');

// Summary
console.log(`\n=== SUMMARY ===`);
console.log(`Working report has ${Object.keys(parsedWorking).length} fields`);
console.log(`Failing report has ${Object.keys(parsedFailing).length} fields`);
console.log(`Keys missing in failing: ${comparison.missingIn2.length}`);
console.log(`Keys missing in working: ${comparison.missingIn1.length}`);
console.log(`Value differences: ${comparison.valueDifferences.length}`);
console.log(`Keys with invisible chars: ${comparison.keysWithInvisibleChars.length}`);