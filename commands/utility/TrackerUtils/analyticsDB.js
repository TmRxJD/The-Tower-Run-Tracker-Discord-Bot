// Analytics database for tracker bot
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'analytics.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS command_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        command_name TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS run_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        run_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Prepare statements
const insertUserStmt = db.prepare('INSERT OR IGNORE INTO users (user_id) VALUES (?)');
const insertCommandStmt = db.prepare('INSERT INTO command_usage (user_id, command_name) VALUES (?, ?)');
const insertRunStmt = db.prepare('INSERT INTO run_uploads (user_id, run_id) VALUES (?, ?)');

const getCommandsStmt = db.prepare('SELECT COUNT(*) as count FROM command_usage WHERE DATE(timestamp) = ?');
const getUniqueUsersStmt = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM command_usage WHERE DATE(timestamp) = ?');
const getNewUsersStmt = db.prepare('SELECT COUNT(*) as count FROM users WHERE DATE(first_seen) = ?');
const getRunsStmt = db.prepare('SELECT COUNT(*) as count FROM run_uploads WHERE DATE(timestamp) = ?');

function logCommandUsage(userId, commandName) {
    insertUserStmt.run(userId);
    insertCommandStmt.run(userId, commandName);
}

function logRunUpload(userId, runId) {
    insertRunStmt.run(userId, runId);
}

function getAnalytics(days) {
    const results = [];
    for (let i = 0; i < days; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

        const commands = getCommandsStmt.get(dateStr).count;
        const uniqueUsers = getUniqueUsersStmt.get(dateStr).count;
        const newUsers = getNewUsersStmt.get(dateStr).count;
        const runs = getRunsStmt.get(dateStr).count;

        results.push({ date: dateStr, commands, uniqueUsers, newUsers, runs });
    }
    return results;
}

module.exports = {
    logCommandUsage,
    logRunUpload,
    getAnalytics
};