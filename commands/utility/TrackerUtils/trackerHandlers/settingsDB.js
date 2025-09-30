// Consolidated settings database handler
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SETTINGS_DIR = path.join(__dirname, '..', 'trackerSettings');
const SETTINGS_DB_PATH = path.join(SETTINGS_DIR, 'settings.db');

// Ensure directory exists
if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}

// Initialize database
const db = new Database(SETTINGS_DB_PATH);

// Create table if it doesn't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT,
        PRIMARY KEY (user_id, setting_key)
    )
`);

// Prepare statements
const insertOrReplaceStmt = db.prepare(`
    INSERT OR REPLACE INTO user_settings (user_id, setting_key, setting_value)
    VALUES (?, ?, ?)
`);

const selectStmt = db.prepare('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?');

const selectAllStmt = db.prepare('SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?');

const deleteStmt = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND setting_key = ?');

/**
 * Load a setting for a user
 */
function loadSetting(userId, key, defaultValue = null) {
    try {
        const row = selectStmt.get(userId, key);
        if (row) {
            return row.setting_value;
        }
        return defaultValue;
    } catch (error) {
        console.error('Error loading setting:', error);
        return defaultValue;
    }
}

/**
 * Save a setting for a user
 */
function saveSetting(userId, key, value) {
    try {
        insertOrReplaceStmt.run(userId, key, value);
    } catch (error) {
        console.error('Error saving setting:', error);
    }
}

/**
 * Load all settings for a user
 */
function loadAllSettings(userId) {
    try {
        const rows = selectAllStmt.all(userId);
        const settings = {};
        rows.forEach(row => {
            settings[row.setting_key] = row.setting_value;
        });
        return settings;
    } catch (error) {
        console.error('Error loading all settings:', error);
        return {};
    }
}

/**
 * Save multiple settings for a user
 */
function saveMultipleSettings(userId, settings) {
    try {
        const insertMany = db.transaction((userId, settings) => {
            for (const [key, value] of Object.entries(settings)) {
                insertOrReplaceStmt.run(userId, key, value);
            }
        });
        insertMany(userId, settings);
    } catch (error) {
        console.error('Error saving multiple settings:', error);
    }
}

/**
 * Delete a setting for a user
 */
function deleteSetting(userId, key) {
    try {
        deleteStmt.run(userId, key);
    } catch (error) {
        console.error('Error deleting setting:', error);
    }
}

module.exports = {
    loadSetting,
    saveSetting,
    loadAllSettings,
    saveMultipleSettings,
    deleteSetting
};