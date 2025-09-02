const { google } = require('googleapis');
const { findPotentialDuplicateRun } = require('./trackerHelpers.js'); // Assuming this is the correct path

const DEBUG = true; // Global debug flag

function debugLog(message) {
    if (DEBUG) {
        console.log(message);
    }
}

const auth = new google.auth.GoogleAuth({
    keyFile: 'google_credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
});
const TEMPLATE_SHEET_ID = '141hjTCJlFAv9Wk1F-A2WszE0wI077TWC91xZDOoZXME';
const COLUMN_MAPPINGS = {
    tier: 'B',
    wave: 'C',
    totalCoins: 'D',
    totalCells: 'E',
    totalDice: 'F',
    roundDuration: 'G',
    killedBy: 'H',
    date: 'I',
    time: 'J',
    notes: 'K'
};

async function getSpreadsheetLink(username) {
    try {
        const userSpreadsheetId = await migrateSheetData(username, auth);
        const spreadsheetLink = `https://docs.google.com/spreadsheets/d/${userSpreadsheetId}`;
        return spreadsheetLink;
    } catch (error) {
        console.error(`[ERROR] Failed to retrieve spreadsheet link for ${username}:`, error);
        return await sendFinalReply('⚠️ Unable to retrieve your spreadsheet link at this time.');
    }
}

// Modify getSheetData to include a breakdown of runs by sheet tab
async function getSheetData(username) {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        const userSpreadsheetId = await migrateSheetData(username, auth);

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: userSpreadsheetId,
            range: 'Farming!B5:K', // Adjusted range to match the required columns
        });

        const rows = response.data.values || [];

        // Map rows to objects with the required fields
        const data = rows.map(row => ({
            tier: row[0] || '',
            wave: row[1] || '',            
            coins: row[2] || '',
            cells: row[3] || '',
            rerollShards: row[4] || '',
            duration: row[5] || '',
            killedBy: row[6] || '',
            date: row[7] || '',
            time: row[8] || '',
            notes: row[9] || ''
        }));

        // Get the last run entry distinctly
        const lastRunEntry = data.length > 0 ? data[data.length - 1] : null;

        // Fetch all sheet tabs to calculate run counts per tab
        const sheetTabsResponse = await sheets.spreadsheets.get({
            spreadsheetId: userSpreadsheetId,
            fields: 'sheets(properties(title))',
        });

        const runTypeCounts = {};
        for (const sheet of sheetTabsResponse.data.sheets) {
            const sheetTitle = sheet.properties.title;
            const sheetDataResponse = await sheets.spreadsheets.values.get({
                spreadsheetId: userSpreadsheetId,
                range: `${sheetTitle}!B5:B`, // Assuming column B contains the tier or wave data
            });

            const sheetRows = sheetDataResponse.data.values || [];
            runTypeCounts[sheetTitle] = sheetRows.length;
        }

        return { 
            lastRun: lastRunEntry,
            allRuns: data,
            runTypeCounts
        };
    } catch (error) {
        console.error(`[ERROR] Failed to retrieve sheet data for ${username}:`, error);
        throw new Error('Unable to retrieve sheet data');
    }
}

async function migrateSheetData(username, auth) {
    if (!auth) {
        console.error('[ERROR] No authentication provided for sheet migration');
        throw new Error('Authentication required');
    }

    const updatePermissions = async (fileId) => {
        try {
            await drive.permissions.create({
                fileId,
                requestBody: {
                    role: 'writer',
                    type: 'anyone'
                }
            });
        } catch (error) {
            console.error(`[ERROR] Failed to update permissions for file: ${fileId}`, error);
            throw new Error('Permission update failed');
        }
    };

    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });
    const newSheetName = `Tracker_${username}`;

    let folderId;
    const folderList = await drive.files.list({
        q: "name='Trackers' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id)'
    });
    
    if (folderList.data.files.length > 0) {
        folderId = folderList.data.files[0].id;
    } else {
        const folder = await drive.files.create({
            requestBody: {
                name: 'Trackers',
                mimeType: 'application/vnd.google-apps.folder'
            },
            fields: 'id'
        });
        folderId = folder.data.id;
    }

    const fileList = await drive.files.list({
        q: `(name='${newSheetName}') and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and '${folderId}' in parents`,
        fields: 'files(id, name, modifiedTime)'
    });
    
    const existingNewSheet = fileList.data.files.find(file => file.name === newSheetName);
    let oldSheetId = null;

    if (existingNewSheet) {
        oldSheetId = existingNewSheet.id;
        const templateFile = await drive.files.get({ fileId: TEMPLATE_SHEET_ID, fields: 'modifiedTime' });
        const templateModifiedTime = new Date(templateFile.data.modifiedTime);
        const currentSheetModifiedTime = new Date(existingNewSheet.modifiedTime);
        if (currentSheetModifiedTime >= templateModifiedTime) {
            await updatePermissions(existingNewSheet.id);
            return existingNewSheet.id;
        }
    }

    const copyResponse = await drive.files.copy({
        fileId: TEMPLATE_SHEET_ID,
        requestBody: {
            name: newSheetName,
            parents: [folderId] 
        }
    });
    
    const userSpreadsheetId = copyResponse.data.id;
    debugLog(`[SUCCESS] Created new sheet from template in "Trackers": ${newSheetName} (${userSpreadsheetId})`);
    
    if (existingNewSheet) {
        debugLog("[INFO] Extracting data from specific columns based on COLUMN_MAPPINGS...");

        const extractedColumns = {};

        for (const key in COLUMN_MAPPINGS) {
            const col = COLUMN_MAPPINGS[key];

            const range = `Farming!${col}5:${col}`;
            debugLog(`[DEBUG] Extracting range: ${range}`);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: existingNewSheet.id,
                range: range
            });

            const colValues = response.data.values || [];
            debugLog(`[DEBUG] Extracted ${colValues.length} rows from column ${col}`);
            extractedColumns[col] = [];

            colValues.forEach((row, index) => {
                let cellValue = row[0] || "";

                if (typeof cellValue === 'string' && cellValue.startsWith("'")) {
                    debugLog(`Column ${col}, row ${index + 5}: Removing leading apostrophe from: ${cellValue}`);
                    cellValue = cellValue.slice(1);
                }

                if (['B', 'C'].includes(col)) {
                    const parsed = parseInt(cellValue, 10);
                    if (!isNaN(parsed)) {
                        debugLog(`Column ${col}, row ${index + 5}: Converting "${cellValue}" to integer ${parsed}`);
                        cellValue = parsed;
                    } else {
                        debugLog(`Column ${col}, row ${index + 5}: Invalid integer value, setting to 0`);
                        cellValue = 0;
                    }
                } else if (['D', 'E', 'F'].includes(col)) {

                    if (typeof cellValue === 'string' && !/[KMBTqQ]/.test(cellValue)) {
                        const parsed = parseFloat(cellValue);
                        if (!isNaN(parsed)) {
                            debugLog(`Column ${col}, row ${index + 5}: Converting "${cellValue}" to number ${parsed}`);
                            cellValue = parsed;
                        } else {
                            debugLog(`Column ${col}, row ${index + 5}: Invalid numeric value, setting to 0`);
                            cellValue = 0;
                        }
                    }
                }
                extractedColumns[col][index] = cellValue;
            });
        }

        debugLog("[DEBUG] Extracted columns data:", JSON.stringify(extractedColumns, null, 2));

        const keys = Object.keys(COLUMN_MAPPINGS);
        const filteredData = [];
        const rowCount = extractedColumns['B'].length;
        for (let i = 0; i < rowCount; i++) {
            const bValue = extractedColumns['B'][i];
            const cValue = extractedColumns['C'][i];
            
            if (bValue !== 0 && bValue !== "" && cValue !== 0 && cValue !== "") {
                const row = keys.map(key => {
                    const col = COLUMN_MAPPINGS[key];
                    return extractedColumns[col][i] || "";  
                });
                filteredData.push(row);
            }
        }

        debugLog("[DEBUG] Filtered data:", JSON.stringify(filteredData, null, 2));

        for (const key of keys) {
            const col = COLUMN_MAPPINGS[key];
            const range = `Farming!${col}5:${col}`;
            debugLog(`[DEBUG] Updating range: ${range} in new sheet`);
            const colIndex = keys.indexOf(key);
            const values = filteredData.map(row => [ row[colIndex] ]);
            await sheets.spreadsheets.values.update({
                spreadsheetId: userSpreadsheetId,
                range: range,
                valueInputOption: 'RAW',
                requestBody: { values: values }
            });
            debugLog(`[INFO] Updated column ${col} with ${values.length} rows.`);
        }

        await applyFormatting(sheets, userSpreadsheetId);
    }

    await updatePermissions(userSpreadsheetId);
    return userSpreadsheetId;
}

async function setupSheetsAndLogData(username, processedResult) {
    const userSpreadsheetId = await migrateSheetData(username, auth);
    const sheets = google.sheets({
        version: 'v4',
        auth
    });
    let successfulLogDetails = [];
    let updateMsg;

    const existingRuns = await getSheetData(username).then(data => data.allRuns);
    const duplicateResult = findPotentialDuplicateRun(processedResult, existingRuns);

    const targetRow = duplicateResult.isDuplicate ? duplicateResult.duplicateRunId : null;
    const rowValues = Object.keys(COLUMN_MAPPINGS).map(key => {
        if (key === 'notes') {
            return processedResult[key] || ''; 
        }
        const value = processedResult[key];
        return (value === 0 || value) ? value : 0; 
    });

    if (targetRow !== null) {
        debugLog(`[INFO] Duplicate found at row ${targetRow}. Updating entry...`);
        const data = Object.entries(COLUMN_MAPPINGS).map(([key, column], index) => ({
            range: `Farming!${column}${targetRow}`,
            values: [
                [rowValues[index]]
            ]
        }));
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: userSpreadsheetId,
            resource: {
                valueInputOption: 'RAW',
                data
            }
        });
        updateMsg = `✏️ Existing entry updated!`;
        successfulLogDetails.push(`Updated entry at row ${targetRow} with data: ${JSON.stringify(processedResult)}`);
    } else {
        debugLog('[INFO] No duplicate found. Adding new entry...');
        const rangeCheck = `Farming!${COLUMN_MAPPINGS.tier}4:${COLUMN_MAPPINGS.tier}`;
        const sheetData = await sheets.spreadsheets.values.get({
            spreadsheetId: userSpreadsheetId,
            range: rangeCheck
        });
        const firstEmptyRow = sheetData.data.values ? sheetData.data.values.length + 4 : 4;
        const data = Object.entries(COLUMN_MAPPINGS).map(([key, column], index) => ({
            range: `Farming!${column}${firstEmptyRow}`,
            values: [
                [rowValues[index]]
            ]
        }));
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: userSpreadsheetId,
            resource: {
                valueInputOption: 'RAW',
                data
            }
        });
        updateMsg = `✅ Run logged successfully!`;
        successfulLogDetails.push(`Inserted new entry at row ${firstEmptyRow} with data: ${JSON.stringify(processedResult)}`);
    }
    await applyFormatting(sheets, userSpreadsheetId);

    return {
        updateMsg,
        successfulLogDetails
    };
}

async function applyFormatting(sheets, userSpreadsheetId) {
    debugLog("Getting sheet ID to format Columns B & C");
    const newSpreadsheetResponse = await sheets.spreadsheets.get({
        spreadsheetId: userSpreadsheetId,
        fields: "sheets(properties(sheetId,title))" 
    });

    const targetSheet = newSpreadsheetResponse.data.sheets.find(sheet => sheet.properties.title === 'Farming');

    if (targetSheet) {
        const sheetId = targetSheet.properties.sheetId;
        debugLog("Applying number format to sheet ID:", sheetId);

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: userSpreadsheetId,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId: sheetId,
                                startRowIndex: 3,        
                                startColumnIndex: 1,      
                                endColumnIndex: 3           
                            },
                            cell: {
                                userEnteredFormat: {
                                    numberFormat: {
                                        type: "NUMBER",
                                        pattern: "0"
                                    }
                                }
                            },
                            fields: "userEnteredFormat.numberFormat"
                        }
                    }
                ]
            }
        });

        debugLog("Number format applied to columns B & C successfully.");
    } else {
        debugLog("Sheet 'Farming' not found in the spreadsheet.");
    }
}

/**
 * Updates an existing run in the user's sheet by finding the duplicate row and updating it.
 * @param {string} username - The Discord username
 * @param {object} processedResult - The run data to update
 */
async function updateRunInSheet(username, processedResult) {
    const userSpreadsheetId = await migrateSheetData(username, auth);
    const sheets = google.sheets({ version: 'v4', auth });

    // Get all existing runs
    const existingRuns = await getSheetData(username).then(data => data.allRuns);
    const duplicateResult = findPotentialDuplicateRun(processedResult, existingRuns);
    const targetRow = duplicateResult.isDuplicate ? duplicateResult.duplicateRunId : null;

    if (targetRow === null) {
        throw new Error('No duplicate run found to update.');
    }

    // Prepare the row values in the correct order
    const rowValues = Object.keys(COLUMN_MAPPINGS).map(key => {
        if (key === 'notes') {
            return processedResult[key] || '';
        }
        const value = processedResult[key];
        return (value === 0 || value) ? value : 0;
    });

    // Prepare the batch update data for each column
    const data = Object.entries(COLUMN_MAPPINGS).map(([key, column], index) => ({
        range: `Farming!${column}${targetRow}`,
        values: [ [rowValues[index]] ]
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: userSpreadsheetId,
        resource: {
            valueInputOption: 'RAW',
            data
        }
    });

    await applyFormatting(sheets, userSpreadsheetId);
    return {
        updateMsg: `✏️ Existing entry updated at row ${targetRow}!`,
        updatedRow: targetRow,
        updatedData: processedResult
    };
}

module.exports = {
    getSheetData,
    migrateSheetData,
    getSpreadsheetLink,
    setupSheetsAndLogData,
    applyFormatting,
    updateRunInSheet
};