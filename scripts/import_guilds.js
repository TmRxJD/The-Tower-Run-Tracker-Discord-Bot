const path = require('node:path');
const db = require('../lib/db');
db.init();

const config = require('../config.json');
const guildIds = config.guildIds || [];

if (!guildIds.length) {
    console.log('No guild IDs found in config.json');
    process.exit(0);
}

let added = 0;
let skipped = 0;

for (const id of guildIds) {
    try {
        const res = db.addGuild(id);
        if (res && res.changes) {
            added++;
        } else {
            skipped++;
        }
    } catch (err) {
        console.error(`Failed to add guild ${id}:`, err);
    }
}

console.log(`Import complete. Added: ${added}, Skipped(existing): ${skipped}. Total processed: ${guildIds.length}`);
process.exit(0);
