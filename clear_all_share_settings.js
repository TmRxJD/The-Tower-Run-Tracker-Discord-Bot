// Clear all share settings for all users to force defaults
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'commands', 'utility', 'TrackerUtils', 'trackerSettings');
const dbPath = path.join(dbDir, 'settings.db');

// Ensure directory exists
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

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

const deleteStmt = db.prepare('DELETE FROM user_settings WHERE setting_key = ?');

let totalDeleted = 0;
shareKeys.forEach(key => {
    const result = deleteStmt.run(key);
    totalDeleted += result.changes;
    console.log(`Deleted ${result.changes} entries for ${key}`);
});

console.log(`Total entries deleted: ${totalDeleted}`);
db.close();