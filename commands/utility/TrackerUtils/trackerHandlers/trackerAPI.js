
require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');

const API_URL = process.env.TRACKER_API_URL;
const API_KEY = process.env.TRACKER_API_KEY;

const date = new Date().toISOString().split('T')[0];
const time = new Date().toISOString().split('T')[1].slice(0, 8);

const getHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': API_KEY
    })

// Helper to format date as YYYY-MM-DD
function formatDateToISO(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    let parts;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(dateStr)) {
        parts = dateStr.split(/[\/\-]/);
        let year, month, day;
        if (parts[2].length === 4) {
            year = parts[2];
            month = parts[0];
            day = parts[1];
            if (parseInt(parts[0]) > 12) {
                day = parts[0];
                month = parts[1];
            }
        } else {
            year = '20' + parts[2];
            month = parts[0];
            day = parts[1];
            if (parseInt(parts[0]) > 12) {
                day = parts[0];
                month = parts[1];
            }
        }
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return dateStr;
}

// Helper to format time as 24h (HH:MM:SS)
function formatTimeTo24h(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return time;
    if (/^\d{2}:\d{2}:\d{2}$/.test(timeStr)) return timeStr;
    const match = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)/i);
    if (match) {
        let hour = parseInt(match[1], 10);
        const minute = match[2];
        const second = match[3] || '00';
        const ampm = match[4].toUpperCase();
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
        return `${hour.toString().padStart(2, '0')}:${minute}:${second}`;
    }
    return timeStr;
}

/**
 * Log a run to the API, including screenshot upload
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {Object} runData - Run data to log
 * @param {Object} [settings] - Optional user settings to save alongside run
 * @param {Buffer|string} [screenshotBuffer] - Buffer or path to screenshot file
 * @param {string} [screenshotName] - Screenshot filename
 * @returns {Promise<Object>} - API response
 */
async function logRun(userId, username, runData, settings = {}, screenshotBuffer = null, screenshotName = null) {
    try {
        console.log(`[API] Logging run for user ${userId}:`, runData);


        // Prepare form data for multipart upload (Node.js FormData)
        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('username', username);
        formData.append('tier', String(runData.tier || '1'));
        formData.append('wave', String(runData.wave || '1'));
        formData.append('coins', String(runData.totalCoins || runData.coins || '0').replace(',', '.'));
        formData.append('cells', String(runData.totalCells || runData.cells || '0').replace(',', '.'));
        formData.append('rerollShards', String(runData.totalDice || runData.dice || '0').replace(',', '.'));
        formData.append('duration', String(runData.roundDuration || runData.duration || '0h0m0s'));
        formData.append('killedBy', String(runData.killedBy || 'Apathy'));
        formData.append('type', runData.type ? runData.type.charAt(0).toUpperCase() + runData.type.slice(1) : 'Farming');
        formData.append('runDate', formatDateToISO(runData.runDate || runData.date || date));
        formData.append('runTime', formatTimeTo24h(runData.runTime || runData.time || time));
        formData.append('note', String(runData.notes || ''));

        // Attach screenshot if provided (Buffer, filename)
        if (screenshotBuffer && screenshotName) {
            formData.append('file', screenshotBuffer, { filename: screenshotName });
        }

        // Attach settings if needed (optional)
        if (settings && Object.keys(settings).length > 0) {
            formData.append('settings', JSON.stringify(settings));
        }

        const response = await axios.post(
            `${API_URL}/run`,
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    Authorization: API_KEY,
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        const result = response.data;
        console.log(`[API] Run logged successfully:`, result);
        return result;
    } catch (error) {
        console.error('[API] Error logging run:', error);
        throw error;
    }
}


/**
 * Get the last run(s) for a user (no settings)
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} - Object containing lastRun and allRuns or null
 */
async function getLastRun(userId) {
    try {
        console.log(`[API] Getting run data for user ${userId}`);
        const response = await axios({
            url: `${API_URL}/runs`,
            method: 'GET',
            params: { userId },
            headers: getHeaders(),
            timeout: 10000
        });
        let apiResponse = response.data;
        let runs = [];
        if (apiResponse && apiResponse.runs && Array.isArray(apiResponse.runs)) {
            runs = apiResponse.runs;
            console.log(`[API] Found ${runs.length} runs via response.data.runs`);
        } else if (apiResponse && Array.isArray(apiResponse)) {
            runs = apiResponse;
            console.warn(`[API] Response was array of runs ${userId}`);
        } else {
            console.log(`[API] Unexpected response format or no runs found:`, apiResponse);
            return null;
        }
        if (runs.length === 0) {
            console.log(`[API] No runs found for user ${userId}`);
            return { lastRun: null, allRuns: [], runTypeCounts: {} };
        }
        runs.sort((a, b) => {
            const dateA = new Date(`${a.date || a.runDate}T${a.time || a.runTime}`);
            const dateB = new Date(`${b.date || b.runDate}T${b.time || b.runTime}`);
            return dateB - dateA;
        });
        const mostRecentRun = runs[0];
        // Count run types
        const runTypeCounts = {};
        for (const run of runs) {
            const type = run.type ? run.type.charAt(0).toUpperCase() + run.type.slice(1) : 'Farming';
            runTypeCounts[type] = (runTypeCounts[type] || 0) + 1;
        }
        console.log('[API] runTypeCounts:', runTypeCounts);
        console.log(`[API] Most recent run found:`, mostRecentRun);
        return { 
            lastRun: mostRecentRun, 
            allRuns: runs,
            runTypeCounts
        };
    } catch (error) {
        console.error('[API] Error getting last run:', error);
        return null;
    }
}

/**
 * Get user settings 
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} - User settings object or null
 */
async function getUserSettings(userId) {
    try {
        const response = await axios({
            url: `${API_URL}/settings`,
            method: 'GET',
            params: { userId },
            headers: getHeaders(),
            timeout: 10000
        });
        console.log(`[API] User settings retrieved:`, response.data);
        return response.data || null;
    } catch (error) {
        console.error('[API] Error getting user settings:', error);
        return null;
    }
}

/**
 * Edit user settings 
 * @param {string} userId - Discord user ID
 * @param {Object} settings - Settings object to update
 * @returns {Promise<boolean>} - Success/failure
 */
async function editUserSettings(userId, settings) {
    try {
        const response = await axios({
            url: `${API_URL}/settings`,
            method: 'PATCH',
            headers: getHeaders(),
            timeout: 10000,
            data: { userId, ...settings }
        });
        console.log(`[API] User settings updated successfully:`, response.data);
        return response.status === 200;
    } catch (error) {
        console.error('[API] Error editing user settings:', error);
        return false;
    }
}

/**
 * Edit an existing run
 * @param {string} userId - Discord user ID
 * @param {Object} runData - Run data including runId
 * @param {Object} [settings] - Optional user settings to save
 * @returns {Promise<boolean>} - Success/failure
 */
async function editRun(userId, username, runData, settings = {}) {
    try {
        console.log(`[API] Editing run ${runData.runId} for user ${userId}`);
        // Use the values directly, just format
        const runDate = formatDateToISO(runData.runDate || runData.date || date);
        const runTime = formatTimeTo24h(runData.runTime || runData.time || time);
        const runType = runData.type ? 
            runData.type.charAt(0).toUpperCase() + runData.type.slice(1) : 
            'Farming';

        // Use multipart if screenshotBuffer is present
        if (runData.screenshotBuffer && runData.screenshotName) {
            const formData = new FormData();
            formData.append('userId', userId);
            formData.append('username', username);
            formData.append('runId', runData.runId);
            formData.append('tier', String(runData.tier || '1'));
            formData.append('wave', String(runData.wave || '1'));
            formData.append('coins', String(runData.totalCoins || runData.coins || '0'));
            formData.append('cells', String(runData.totalCells || runData.cells || '0'));
            formData.append('rerollShards', String(runData.totalDice || runData.dice || '0'));
            formData.append('duration', String(runData.roundDuration || runData.duration || '0h0m0s'));
            formData.append('killedBy', String(runData.killedBy || 'Apathy'));
            formData.append('type', runType);
            formData.append('runDate', runDate);
            formData.append('runTime', runTime);
            formData.append('note', String(runData.notes || ''));
            formData.append('file', runData.screenshotBuffer, { filename: runData.screenshotName });
            if (settings && Object.keys(settings).length > 0) {
                formData.append('settings', JSON.stringify(settings));
            }
            const response = await axios.patch(
                `${API_URL}/run`,
                formData,
                {
                    headers: {
                        ...formData.getHeaders(),
                        Authorization: API_KEY,
                    },
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity
                }
            );
            console.log(`[API] Run edited successfully (multipart)`);
            return true;
        } else {
            const payload = {
                userId: userId,
                username: username,
                runId: runData.runId,
                tier: String(runData.tier || '1'),
                wave: String(runData.wave || '1'),
                coins: String(runData.totalCoins || runData.coins || '0'),
                cells: String(runData.totalCells || runData.cells || '0'),
                rerollShards: String(runData.totalDice || runData.dice || '0'),
                duration: String(runData.roundDuration || runData.duration || '0h0m0s'),
                killedBy: String(runData.killedBy || 'Apathy'),
                type: runType,
                runDate: runDate,
                runTime: runTime,
                note: String(runData.notes || ''),
            };
            console.log("[API] editRun Payload:", JSON.stringify(payload, null, 2));
            const response = await axios({
                url: `${API_URL}/run`,
                method: 'PATCH',
                headers: getHeaders(),
                timeout: 10000,
                data: payload
            });
            console.log(`[API] Run edited successfully`);
            return true;
        }
    } catch (error) {
        console.error('[API] Error editing run:', error);
        return false;
    }
}

/**
 * Get total number of runs for a user
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} - Total number of runs
 */
async function getTotalRunCount(userId) {
    try {
        console.log(`[API] Getting total run count for user ${userId}`);
        
        const lastRunData = await getLastRun(userId);
        
        if (lastRunData && lastRunData.allRuns) {
            const runCount = lastRunData.allRuns.length;
            console.log(`[API] Total run count for user ${userId} (from cached data):`, runCount);
            return runCount;
        }
        
        const response = await axios({
            url: `${API_URL}/runs`,
            method: 'GET',
            params: { userId },
            headers: getHeaders(),
            timeout: 10000,
        });

        let runCount = 0;
        
        if (response.data && response.data.runs && Array.isArray(response.data.runs)) {
            runCount = response.data.runs.length;
        } else if (response.data && Array.isArray(response.data)) {
            runCount = response.data.length;
        } else if (response.data && response.data.count !== undefined) {
            runCount = response.data.count;
        }
        
        console.log(`[API] Total run count for user ${userId}:`, runCount);
        return runCount;
    } catch (error) {
        console.error(`[API] Error getting run count for user ${userId}:`, error);
        return 0;
    }
}

/**
 * Remove the last run for a user
 * @param {string} userId - Discord user ID
 * @returns {Promise<boolean>} - Success/failure
 */
async function removeLastRun(userId, runId) {
    try {
        console.log(`[API] Removing last run for user ${userId}`);

        const response = await axios({
            url: `${API_URL}/run`,
            method: 'DELETE',
            headers: getHeaders(),
            timeout: 10000, // 10 second timeout
            data: { userId, runId }
        });

        console.log(`[API] Last run removed successfully`);
        return true;
    } catch (error) {
        console.error('[API] Error removing last run:', error);
        return false;
    }
}

/**
 * Get statistics for a user
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object>} - User statistics
 */
async function getUserStats(userId) {
    try {
        console.log(`[API] Getting stats for user ${userId}`);
        
        const response = await axios({
            url: `${API_URL}/runs`,
            method: 'GET',
            params: { userId },
            headers: getHeaders(),
            timeout: 10000, // 10 second timeout,
        });

        const data = await response.data;
        // just realized I never added resource stats here, coin c ells and reroll shards
        // yeah, could be nice to have them in the stats too
        const stats = {
            totalRuns: 0,
            highestWave: 0,
            highestTier: 0,
            longestRun: '0h0m0s',
            avgWave: 0,
            fastestRun: '0h0m0s',
            totalPlaytime: '0h0m0s'
        };

        const runTimesInSeconds = data.map(run => {
            if (!run.duration.includes('m')) {
                run.duraton = `0m${run.duration}`; // Add 0 minutes if not present
            }
            if (!run.duration.includes('h')) {
                run.duration = `0h${run.duration}`; // Add 0 hours if not present
            }
            const [hours, minutes, seconds] = run.duration.split(/h|m|s/).map(Number);
            return {
                totalSeconds: hours * 3600 + minutes * 60 + seconds,
                duration: run.duration
            }
        })
        stats.totalRuns = data.length;
        stats.highestWave = Math.max(...data.map(run => parseInt(run.wave, 10)));
        stats.highestTier = Math.max(...data.map(run => parseInt(run.tier, 10)));
        stats.longestRun = runTimesInSeconds.reduce((a, b) => a.totalSeconds > b.totalSeconds ? a : b).duration;
        avgWave = data.reduce((acc, run) => acc + parseInt(run.wave, 10), 0) / stats.totalRuns;
        stats.avgWave = avgWave.toFixed(2);
        stats.fastestRun = runTimesInSeconds.reduce((a, b) => a.totalSeconds < b.totalSeconds ? a : b).duration;

        console.log(`[API] User stats retrieved:`, stats);
        return data;
    } catch (error) {
        console.error('[API] Error getting user stats:', error);
        return {
            totalRuns: 0,
            highestWave: 0,
            highestTier: 0,
            longestRun: '0h0m0s',
            avgWave: 0,
            fastestRun: '0h0m0s',
            totalPlaytime: '0h0m0s'
        };
    }
}

/**
 * Clears all runs for a user
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} - Number of runs deleted
 */
async function clearUserRuns(userId) {
    try {
        console.log(`[API] Clearing all runs for user ${userId}`);
        const lastRunData = await getLastRun(userId);
        const runs = lastRunData?.allRuns || [];
        let deletedCount = 0;
        for (const run of runs) {
            const success = await removeLastRun(userId, run.runId);
            if (success) deletedCount++;
            // brief pause to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        console.log(`[API] Cleared ${deletedCount}/${runs.length} runs for user ${userId}`);
        return deletedCount;
    } catch (error) {
        console.error(`[API] Error clearing runs for user ${userId}:`, error);
        throw error;
    }
}

/**
 * Send an image buffer to the backend OCR endpoint and return the response
 * @param {Buffer} buffer - The image buffer
 * @param {string} filename - The name of the file
 * @param {string} contentType - The MIME type of the file
 * @returns {Promise<Object>} - OCR response from the backend
 */
async function runOCR(buffer, filename, contentType) {
    const FormData = require('form-data');
    try {
        const formData = new FormData();
        formData.append('file', buffer, {
            filename: filename,
            contentType: contentType
        });
        const apiUrl = API_URL || 'http://localhost:3000';
        const response = await axios.post(`${apiUrl}/ocr`, formData, {
            headers: {
                ...formData.getHeaders(),
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        return response.data;
    } catch (error) {
        console.error('[API] Error running backend OCR:', error);
        throw error;
    }
}

module.exports = {
    logRun,
    getLastRun,
    getUserSettings,
    editUserSettings,
    getTotalRunCount,
    removeLastRun,
    clearUserRuns,
    editRun,
    getUserStats,
    runOCR
};
