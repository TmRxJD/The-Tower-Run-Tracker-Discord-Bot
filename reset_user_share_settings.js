// Reset share settings for a specific user to defaults
const { deleteSetting } = require('./commands/utility/TrackerUtils/trackerHandlers/settingsDB.js');

const userId = '254065385643573248'; // The affected user

const shareKeys = [
    'includeTier',
    'includeWave',
    'includeDuration',
    'includeKilledBy',
    'includeTotalCoins',
    'includeTotalCells',
    'includeTotalDice',
    'includeCoinsPerHour',
    'includeCellsPerHour',
    'includeDicePerHour',
    'includeNotes',
    'includeScreenshot',
    'includeCoverage'
];

console.log(`Resetting share settings for user ${userId} to defaults...`);

shareKeys.forEach(key => {
    deleteSetting(userId, key);
    console.log(`Deleted setting: ${key}`);
});

console.log('Done. The user will now use default share settings.');