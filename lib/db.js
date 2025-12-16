const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, '..', 'data.sqlite3');
const db = new Database(DB_FILE);

// initialize tables
db.prepare(`CREATE TABLE IF NOT EXISTS guilds (
    id TEXT PRIMARY KEY,
    first_seen INTEGER
)`).run();

function init() {
    // noop for compatibility
}

function addGuild(id) {
    const stmt = db.prepare('INSERT OR IGNORE INTO guilds (id, first_seen) VALUES (?, ?)');
    return stmt.run(id, Date.now());
}

function removeGuild(id) {
    const stmt = db.prepare('DELETE FROM guilds WHERE id = ?');
    return stmt.run(id);
}

function listGuildIds() {
    const rows = db.prepare('SELECT id FROM guilds').all();
    return rows.map(r => r.id);
}

function close() {
    try {
        db.close();
    } catch (e) {
        // ignore
    }
}

module.exports = {
    init,
    addGuild,
    removeGuild,
    listGuildIds,
    _db: db,
    close,
};
