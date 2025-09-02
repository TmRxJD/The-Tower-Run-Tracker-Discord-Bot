// filepath: d:\Projects\chad-bot\commands\utility\migrateToNewTracker.js
const {
    SlashCommandBuilder,
    EmbedBuilder,
    Colors
} = require('discord.js');
const { google } = require('googleapis');
const trackerApi = require('./trackerAPI.js');
const { parseDurationToHours, findPotentialDuplicateRun } = require('./trackerHelpers.js');

// Google authentication setup
const auth = new google.auth.GoogleAuth({
    keyFile: 'google_credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
});

// Track migration status and message info for updating progress
const migrationStatus = new Map();

/**
 * Finds the most recently updated Tracker sheet for a user from Google Drive
 * @param {string} username - Discord username
 * @returns {Promise<string|null>} - Spreadsheet ID or null if not found
 */
async function findLatestTrackerSheet(username) {
    try {
        console.log(`[MIGRATE] Finding latest tracker sheet for ${username}`);
        const drive = google.drive({ version: 'v3', auth });
        
        // Step 1: Find the Trackers folder
        const folderResponse = await drive.files.list({
            q: "name='Trackers' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields: 'files(id, name)'
        });
        
        if (!folderResponse.data.files || folderResponse.data.files.length === 0) {
            console.log('[MIGRATE] Trackers folder not found');
            return null;
        }
        
        const folderId = folderResponse.data.files[0].id;
        console.log(`[MIGRATE] Found Trackers folder: ${folderId}`);
        
        // Step 2: Find all sheets for this user, sorted by last modified
        const namePattern = `Tracker_${username}`;
        
        const filesResponse = await drive.files.list({
            q: `'${folderId}' in parents and name contains '${namePattern}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
            orderBy: 'modifiedTime desc',
            fields: 'files(id, name, modifiedTime)',
            pageSize: 10 // Limit to 10 most recent
        });
        
        if (!filesResponse.data.files || filesResponse.data.files.length === 0) {
            console.log(`[MIGRATE] No tracker sheets found for ${username}`);
            return null;
        }
        
        // Return the most recently modified sheet
        const latestSheet = filesResponse.data.files[0];
        console.log(`[MIGRATE] Found latest sheet for ${username}: ${latestSheet.name} (${latestSheet.id}), last modified: ${latestSheet.modifiedTime}`);
        
        return latestSheet.id;
    } catch (error) {
        console.error(`[MIGRATE] Error finding latest tracker sheet:`, error);
        return null;
    }
}

/**
 * Detects and removes duplicates from sheet data
 * @param {Array<Object>} runs - Extracted run data from sheet
 * @returns {Array<Object>} - Deduplicated run data
 */
function removeDuplicatesFromSheetData(runs) {
    if (!runs || !Array.isArray(runs) || runs.length <= 1) {
        return runs || [];
    }
    
    console.log(`[MIGRATE] Checking for duplicates among ${runs.length} runs`);
    
    // Map to track unique runs by fingerprint
    const uniqueRuns = new Map();
    const duplicates = [];
    
    for (const run of runs) {
        // Create a comprehensive fingerprint with all key fields
        const fingerprint = createRunFingerprint(run);
        
        if (uniqueRuns.has(fingerprint)) {
            duplicates.push(run);
        } else {
            uniqueRuns.set(fingerprint, run);
        }
    }
    
    console.log(`[MIGRATE] Found ${duplicates.length} duplicates within sheet data`);
    return Array.from(uniqueRuns.values());
}

/**
 * Creates a detailed fingerprint for a run
 * @param {Object} run - Run data
 * @returns {string} - Unique fingerprint
 */
function createRunFingerprint(run) {
    // Normalize all fields to strings
    const tier = String(run.tier || '0');
    const wave = String(run.wave || '0');
    const duration = String(run.duration || run.roundDuration || '0h0m0s');
    const coins = String(run.coins || run.totalCoins || '0');
    const cells = String(run.cells || run.totalCells || '0');
    const dice = String(run.dice || run.totalDice || '0');
    const type = String(run.type || 'farming').toLowerCase();
    const killedBy = String(run.killedBy || '').toLowerCase();
    
    // Create a comprehensive fingerprint with all fields that can identify a unique run
    return `${tier}|${wave}|${duration}|${coins}|${cells}|${dice}|${type}|${killedBy}`;
}

/**
 * Migrates data from an old spreadsheet to the new tracker
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {Object} interaction - Discord interaction for progress updates
 * @return {Promise<Object>} - Migration results
 */
async function migrateUserData(userId, username, interaction) {
    try {
        console.log(`[MIGRATE] Starting migration for user ${username} (${userId})`);
        
        // Update progress
        await updateMigrationProgress(interaction, {
            status: 'starting',
            userId,
            username,
            message: `Finding tracker sheet for ${username}...`
        });
        
        // Initialize tracking objects
        const results = {
            totalRunsFound: 0,
            totalRunsImported: 0,
            duplicatesSkipped: 0,
            internalDuplicates: 0,
            errors: 0,
            tabResults: {}
        };
        
        // Step 1: Find user's spreadsheetId directly from Google Drive
        const spreadsheetId = await findLatestTrackerSheet(username);
        
        if (!spreadsheetId) {
            console.log(`[MIGRATE] No spreadsheet found for user ${username}`);
            return {
                ...results,
                error: "No spreadsheet found for this user"
            };
        }
        
        await updateMigrationProgress(interaction, {
            status: 'processing',
            userId,
            username,
            message: `Found spreadsheet. Reading data...`,
            spreadsheetId
        });
        
        // Step 2: Initialize Google Sheets API client
        const sheetsAPI = google.sheets({ version: 'v4', auth });
        
        // Step 3: Define tabs to process and their corresponding types
        const tabsToProcess = [
            { name: 'Farming', type: 'farming' },
            { name: 'Overnight', type: 'overnight' },
            { name: 'Tournament', type: 'tournament' },
            { name: 'Milestones', type: 'milestone' }
        ];
        
        // First, get all existing runs from tracker API for duplicate checking
        const existingRunsData = await trackerApi.getLastRun(userId);
        
        // Create a set of fingerprints for quick duplicate checking
        const existingFingerprints = new Set();
        
        if (existingRunsData && existingRunsData.allRuns && Array.isArray(existingRunsData.allRuns)) {
            existingRunsData.allRuns.forEach(run => {
                // Create consistent fingerprint
                const fingerprint = createRunFingerprint(run);
                existingFingerprints.add(fingerprint);
            });
            console.log(`[MIGRATE] Found ${existingFingerprints.size} existing runs to check against`);
        }
        
        // Step 4: Process each tab
        for (const tab of tabsToProcess) {
            try {
                await updateMigrationProgress(interaction, {
                    status: 'processing',
                    userId,
                    username,
                    message: `Processing ${tab.name} tab...`,
                    currentTab: tab.name
                });
                
                console.log(`[MIGRATE] Processing ${tab.name} tab for user ${username}`);
                
                // Initialize tab-specific results
                results.tabResults[tab.name] = {
                    runsFound: 0,
                    runsImported: 0,
                    duplicatesSkipped: 0,
                    internalDuplicates: 0,
                    errors: 0
                };
                
                // Get range info to determine how many rows to read
                const metaData = await sheetsAPI.spreadsheets.get({
                    spreadsheetId,
                    ranges: [`${tab.name}!B:K`],
                    fields: 'sheets.properties'
                });
                
                const rowCount = metaData.data.sheets[0].properties.gridProperties.rowCount;
                if (rowCount <= 4) {
                    console.log(`[MIGRATE] ${tab.name} tab has no rows (count: ${rowCount})`);
                    continue; // Skip if only header rows or empty
                }
                
                // Read the data from the sheet (skipping header rows)
                const response = await sheetsAPI.spreadsheets.values.get({
                    spreadsheetId,
                    range: `${tab.name}!B5:K${rowCount}`,
                    valueRenderOption: 'UNFORMATTED_VALUE'
                });
                
                const rows = response.data.values || [];
                if (rows.length === 0) {
                    console.log(`[MIGRATE] ${tab.name} tab has no data rows`);
                    continue;
                }
                
                console.log(`[MIGRATE] Found ${rows.length} total rows in ${tab.name} tab`);
                
                // Track valid run data for batch processing
                const validRuns = [];
                
                // Update progress
                await updateMigrationProgress(interaction, {
                    status: 'processing',
                    userId, 
                    username,
                    message: `Processing ${rows.length} rows from ${tab.name}...`,
                    currentTab: tab.name,
                    rowsFound: rows.length
                });
                currentDate = new Date().toISOString().split('T')[0]; // Get current date in YYYY-MM-DD format
                currentTime = new Date().toLocaleTimeString('en-US', { hour12: false }).slice(0, 8); // Get current time in HH:MM:SS format
                // Process each row
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    
                    // Skip empty rows or rows with no tier (first column)
                    if (!row || row.length === 0 || !row[0]) continue;                    
                    
                    // Map spreadsheet columns (B through K)
                    const tier = parseInt(row[0]) || 1;          // Column B
                    const wave = parseInt(row[1]) || 1;          // Column C
                    const coins = String(row[2] || '0');         // Column D
                    const cells = String(row[3] || '0');         // Column E
                    const dice = String(row[4] || '0');          // Column F
                    const duration = row[5] || '0h0m0s';         // Column G
                    const killedBy = String(row[6] || 'Unknown'); // Column H
                    let runDate = String(row[7] || '').includes('T') ? row[7].split('T')[0] : row[7] || currentDate; // Column I
                    let runTime = String(row[8] || '').includes('T') ? row[8].split('T')[1].slice(0, 8) : row[8] || currentTime; // Column J
                    const notes = String(row[9] || '');          // Column K

                    // --- Date formatting ---
                    if (runDate && typeof runDate === 'string') {
                        // Try to parse MM/DD/YYYY, DD/MM/YYYY, or YYYY-MM-DD
                        let parts;
                        if (/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
                            // Already in YYYY-MM-DD
                        } else if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(runDate)) {
                            parts = runDate.split(/[\/\-]/);
                            let year, month, day;
                            if (parts[2].length === 4) {
                                // MM/DD/YYYY or DD/MM/YYYY
                                year = parts[2];
                                month = parts[0];
                                day = parts[1];
                                if (parseInt(parts[0]) > 12) {
                                    // DD/MM/YYYY
                                    day = parts[0];
                                    month = parts[1];
                                }
                            } else {
                                // MM/DD/YY or DD/MM/YY
                                year = '20' + parts[2];
                                month = parts[0];
                                day = parts[1];
                                if (parseInt(parts[0]) > 12) {
                                    day = parts[0];
                                    month = parts[1];
                                }
                            }
                            runDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
                        }
                    }

                    // --- Time formatting (AM/PM to 24h) ---
                    if (runTime && typeof runTime === 'string' && /AM|PM/i.test(runTime)) {
                        // Example: 02:30:45 PM
                        const match = runTime.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)/i);
                        if (match) {
                            let hour = parseInt(match[1], 10);
                            const minute = match[2];
                            const second = match[3] || '00';
                            const ampm = match[4].toUpperCase();
                            if (ampm === 'PM' && hour < 12) hour += 12;
                            if (ampm === 'AM' && hour === 12) hour = 0;
                            runTime = `${hour.toString().padStart(2, '0')}:${minute}:${second}`;
                        }
                    }

                    // Create run data object using the API's expected format
                    const runData = {
                        type: tab.type,
                        tier,
                        wave,
                        duration,
                        roundDuration: duration,
                        totalCoins: coins,
                        coins,
                        totalCells: cells,
                        cells,
                        totalDice: dice,
                        dice,
                        killedBy,
                        runDate,
                        runTime,
                        notes
                    };
                    
                    validRuns.push(runData);
                    results.tabResults[tab.name].runsFound++;
                    results.totalRunsFound++;
                }
                
                // Progress update about found runs
                await updateMigrationProgress(interaction, {
                    status: 'processing',
                    userId,
                    username,
                    message: `Found ${validRuns.length} valid runs in ${tab.name}. Checking for duplicates...`,
                    currentTab: tab.name,
                    validRuns: validRuns.length
                });
                
                // Step 5: Remove internal duplicates from sheet data
                const uniqueRuns = removeDuplicatesFromSheetData(validRuns);
                results.tabResults[tab.name].internalDuplicates = validRuns.length - uniqueRuns.length;
                results.internalDuplicates += results.tabResults[tab.name].internalDuplicates;
                
                // Progress update about duplicate removal
                await updateMigrationProgress(interaction, {
                    status: 'processing',
                    userId,
                    username,
                    message: `Removed ${results.tabResults[tab.name].internalDuplicates} internal duplicates from ${tab.name}. Importing ${uniqueRuns.length} runs...`,
                    currentTab: tab.name
                });
                
                // Step 6: Process deduplicated runs
                if (uniqueRuns.length > 0) {
                    // Filter against existing runs in the tracker
                    const newRuns = [];
                    for (const run of uniqueRuns) {
                        // Use the robust duplicate check from trackerHelpers
                        const duplicateCheck = findPotentialDuplicateRun(run, existingRunsData?.allRuns || []);
                        if (duplicateCheck.isDuplicate) {
                            // Skip this run as it already exists in the tracker
                            results.tabResults[tab.name].duplicatesSkipped++;
                            results.duplicatesSkipped++;
                        } else {
                            // Track this run for importing
                            newRuns.push(run);
                            // Add to set so we don't import it again if it appears in another tab
                            // (Optional: add a fingerprint if you want to keep the set logic)
                        }
                    }
                    
                    // Progress update about external duplicates
                    await updateMigrationProgress(interaction, {
                        status: 'processing',
                        userId,
                        username,
                        message: `Found ${results.tabResults[tab.name].duplicatesSkipped} runs already in tracker. Importing ${newRuns.length} new runs from ${tab.name}...`,
                        currentTab: tab.name
                    });
                    
                    // Process in smaller chunks to avoid rate limits
                    const BATCH_SIZE = 10; // Adjust based on API limits
                    
                    for (let i = 0; i < newRuns.length; i += BATCH_SIZE) {
                        const chunk = newRuns.slice(i, i + BATCH_SIZE);
                        
                        // Update progress for each batch
                        await updateMigrationProgress(interaction, {
                            status: 'processing',
                            userId,
                            username,
                            message: `Importing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(newRuns.length/BATCH_SIZE)} from ${tab.name}...`,
                            currentTab: tab.name,
                            progress: {
                                current: i,
                                total: newRuns.length
                            }
                        });
                        
                        // Process each run in the chunk
                        for (const run of chunk) {
                            try {
                                // Submit to API
                                await trackerApi.logRun(userId, username, run);
                                results.tabResults[tab.name].runsImported++;
                                results.totalRunsImported++;
                            } catch (runError) {
                                console.error(`[MIGRATE] Error importing run:`, runError);
                                results.tabResults[tab.name].errors++;
                                results.errors++;
                            }
                        }
                        
                        // Pause briefly between chunks to avoid rate limits
                        if (i + BATCH_SIZE < newRuns.length) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
                
                // Final update for this tab
                await updateMigrationProgress(interaction, {
                    status: 'tab_complete',
                    userId,
                    username,
                    message: `Completed ${tab.name}! Imported ${results.tabResults[tab.name].runsImported} runs.`,
                    currentTab: tab.name,
                    tabResults: results.tabResults[tab.name]
                });
                
                console.log(`[MIGRATE] ${tab.name} tab results: ${results.tabResults[tab.name].runsImported} imported, ${results.tabResults[tab.name].duplicatesSkipped} duplicates`);
                
            } catch (tabError) {
                console.error(`[MIGRATE] Error processing tab ${tab.name}:`, tabError);
                results.tabResults[tab.name] = results.tabResults[tab.name] || {};
                results.tabResults[tab.name].errors = (results.tabResults[tab.name].errors || 0) + 1;
                results.errors++;
                
                // Update progress with error
                await updateMigrationProgress(interaction, {
                    status: 'error',
                    userId,
                    username,
                    message: `Error processing ${tab.name} tab: ${tabError.message}`,
                    currentTab: tab.name,
                    error: tabError.message
                });
            }
        }
        
        // Final progress update
        await updateMigrationProgress(interaction, {
            status: 'complete',
            userId,
            username,
            message: `Migration complete! Imported ${results.totalRunsImported} runs.`,
            results
        });
        
        console.log(`[MIGRATE] Migration completed for user ${username}:`, results);
        return results;
        
    } catch (error) {
        console.error(`[MIGRATE] Critical error during migration:`, error);
        
        // Update progress with error
        await updateMigrationProgress(interaction, {
            status: 'error',
            userId,
            username,
            message: `Migration failed: ${error.message}`,
            error: error.message
        });
        
        return {
            totalRunsFound: 0,
            totalRunsImported: 0,
            duplicatesSkipped: 0,
            internalDuplicates: 0,
            errors: 1,
            criticalError: true,
            error: error.message
        };
    }
}

/**
 * Updates the migration progress message
 * @param {Object} interaction - Discord interaction
 * @param {Object} progress - Progress data
 * @returns {Promise<void>}
 */
async function updateMigrationProgress(interaction, progress) {
    if (!interaction) return;
    
    try {
        const { userId, username, status, message, results } = progress;
        
        // Create embed with current progress
        const embed = new EmbedBuilder()
            .setTitle(`Migration Progress: ${username || userId}`)
            .setDescription(message || 'Processing...')
            .setColor(getStatusColor(status))
            .setTimestamp();
        
        // Add fields based on status
        if (status === 'complete' && results) {
            embed.addFields(
                { name: 'Total Runs Found', value: `${results.totalRunsFound}`, inline: true },
                { name: 'Duplicates Removed', value: `${results.internalDuplicates}`, inline: true },
                { name: 'Already in Tracker', value: `${results.duplicatesSkipped}`, inline: true },
                { name: 'Runs Imported', value: `${results.totalRunsImported}`, inline: true },
                { name: 'Errors', value: `${results.errors}`, inline: true }
            );
            
            // Add tab-specific results if available
            for (const [tabName, tabResults] of Object.entries(results.tabResults || {})) {
                if (tabResults.runsFound > 0) {
                    embed.addFields({
                        name: `${tabName} Tab`,
                        value: `Found: ${tabResults.runsFound}\nImported: ${tabResults.runsImported}\nInternal Dupes: ${tabResults.internalDuplicates}\nAlready in Tracker: ${tabResults.duplicatesSkipped}`,
                        inline: true
                    });
                }
            }
        } else if (status === 'tab_complete' && progress.tabResults) {
            // Show results for a completed tab
            const tabResults = progress.tabResults;
            embed.addFields({
                name: `${progress.currentTab || 'Tab'} Results`,
                value: `Found: ${tabResults.runsFound}\nImported: ${tabResults.runsImported}\nInternal Dupes: ${tabResults.internalDuplicates}\nAlready in Tracker: ${tabResults.duplicatesSkipped}`,
                inline: false
            });
        } else if (progress.progress) {
            // Show progress bar for batch imports
            const { current, total } = progress.progress;
            const percent = Math.floor((current / total) * 100);
            
            embed.addFields({
                name: 'Progress',
                value: `${current}/${total} (${percent}%)`,
                inline: true
            });
        }
        
        // Add footer with status
        embed.setFooter({ text: `Status: ${getStatusText(status)}` });
        
        // Simplify update logic: always edit the original reply to avoid unknown message errors
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[MIGRATE] Error updating progress message:', error);
        // Don't throw - this should never break the migration
    }
}

/**
 * Gets the appropriate color based on migration status
 */
function getStatusColor(status) {
    switch (status) {
        case 'error': return Colors.Red;
        case 'complete': return Colors.Green;
        case 'tab_complete': return Colors.Green;
        case 'processing': return Colors.Blue;
        case 'starting': return Colors.Yellow;
        default: return Colors.Grey;
    }
}

/**
 * Gets the status text based on status code
 */
function getStatusText(status) {
    switch (status) {
        case 'error': return 'Error';
        case 'complete': return 'Completed';
        case 'tab_complete': return 'Tab Complete';
        case 'processing': return 'Processing';
        case 'starting': return 'Starting';
        default: return 'Unknown';
    }
}

/**
 * Gets the status of a migration operation
 * @param {string} userId - Discord user ID
 * @returns {Object|null} - Migration status or null if not found
 */
function getMigrationStatus(userId) {
    return migrationStatus.get(userId) || null;
}

/**
 * Sets the migration status
 * @param {string} userId - Discord user ID 
 * @param {Object} status - Migration status object
 */
function setMigrationStatus(userId, status) {
    migrationStatus.set(userId, {
        ...status,
        timestamp: Date.now()
    });
}

// Export only the migrateUserData helper for initial import on first use
module.exports = {
    migrateUserData
};