const {
    SlashCommandBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder
} = require('discord.js');
const {
    google
} = require('googleapis');
const path = require('path');
const sharp = require('sharp');

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
    dateTime: 'I',
    notes: 'K'
};
const SUCCESS_LOG_CHANNEL_ID = '1344016135498240130';
const ERROR_LOG_CHANNEL_ID = '1344016216087592960';

async function preprocessImage(buffer) {    
    try {
        let currentBuffer = buffer;
        let currentSize = currentBuffer.length;
        const MAX_SIZE = 188743680; 
        let reductionFactor = 1;  

        const reductionStep = 0.9; 

        const processed = await sharp(currentBuffer)
            .greyscale() 
            .negate() 
            .normalize() 
            .gamma(1.5)  
            .sharpen()   
            .threshold(128)
            .trim() 
            .toFormat('tiff', { compression: 'lzw' })
            .toBuffer();

        currentBuffer = processed;
        currentSize = currentBuffer.length;
        
        if (currentSize > MAX_SIZE) {
            console.log(`[DEBUG] Image too large. Current size: ${currentSize / 1024 / 1024} MB`);
            
            while (currentSize > MAX_SIZE && reductionFactor > 0.5) {
                console.log(`[DEBUG] Reducing image quality. Current size: ${currentSize / 1024 / 1024} MB`);

                const reduced = await sharp(currentBuffer)
                    .toFormat('tiff', { 
                        compression: 'lzw', 
                        quality: Math.max(50, 85 * reductionFactor)
                    })
                    .toBuffer();

                currentBuffer = reduced; 
                currentSize = currentBuffer.length; 
                reductionFactor *= reductionStep; 

                console.log(`[DEBUG] Reduced image size to: ${currentSize / 1024 / 1024} MB`);
            }
        }

        return currentBuffer;

    } catch (error) {
        console.error('[ERROR] Image preprocessing failed:', error);
        throw error;
    }
}

function formatOCRExtraction(gutenyeResult, dateTime, notes) {
    console.log("Starting formatOCRExtraction...");

    const lines = gutenyeResult.map(item => item.text);
    console.log("OCR lines extracted:", lines);

    const fixCommas = (text) => {
        if (typeof text !== 'string') {
            text = String(text); 
        }
        
        const fixedText = text.replace(/,/g, '.');
        return fixedText;
    };

    const fixOCRMisreads = (text) => {
        if (!text || typeof text !== 'string') {
            console.log("fixOCRMisreads: Input is invalid or not a string.");
            return '0';
        }

        const regex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)([KMBTqQ]*)/;
        const match = text.match(regex);

        if (!match) {
            console.log("fixOCRMisreads: Regex match failed for text:", text);
            return text;
        }

        let numberPart = match[1];
        let notationPart = match[2]; 

        if (parseFloat(numberPart) === 0) {
            console.log("fixOCRMisreads: Number part is 0, removing notation.");
            notationPart = '';
        }

        numberPart = numberPart
            .replace(/O/g, '0')
            .replace(/B/g, '8')
            .replace(/S/g, '5')
            .replace(/I/g, '1')
            .replace(/l/g, '1')
            .replace(/Z/g, '2')
            .replace(/G/g, '6')
            .replace(/[^0-9.]/g, ''); 

        if (notationPart) {
            const result = numberPart + notationPart;
            console.log("fixOCRMisreads: Returning number with notation:", result);
            return result;
        }

        const parsedNumber = parseInt(numberPart, 10);
        console.log("fixOCRMisreads: Returning parsed number:", parsedNumber);
        return parsedNumber;
    };

    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const fuzzyContains = (line, expected) => normalize(line).includes(normalize(expected));

    const getTierAndWave = (lines) => {
        let tier = 'Unknown';
        let wave = 'Unknown';

        for (const line of lines) {
            if (fuzzyContains(line, "Tier")) {
                const match = line.match(/Tier\s*(\d+)/i);
                if (match) {
                    tier = parseInt(match[1], 10);
                }
            }
            if (fuzzyContains(line, "Wave")) {
                const match = line.match(/Wave\s*(\d+)/i);
                if (match) {
                    wave = parseInt(match[1], 10);
                }
            }
        }
        return { tier, wave };
    };

    const { tier, wave } = getTierAndWave(lines);

    const getField = (lines, expectedField) => {
        for (const line of lines) {
            if (fuzzyContains(line, expectedField)) {
                const regex = /(\d+[\.,]?\d*)([a-zA-Z]*)/;
                const match = line.match(regex);
                if (match) {
                    const value = match[1] + (match[2] || '');
                    return value;
                }
                if (line.includes("Killed By")) {
                    return line.replace("Killed By", "").trim();
                }
            }
        }
        return '0';
    };

    const processField = (rawValue) => {
        let fixed = fixOCRMisreads(fixCommas(rawValue));

        if (typeof fixed === 'string' && /[KMBTqQ]/.test(fixed)) {
            return fixed;
        }

        return parseInt(fixed, 10);
    };

    let totalCoins = processField(getField(lines, "Coins Earned"));
    let totalCells = processField(getField(lines, "Cells Earned"));
    let totalDice = processField(getField(lines, "Reroll Shards Earned"));

    console.log("Total Coins:", totalCoins);
    console.log("Total Cells:", totalCells);
    console.log("Total Dice:", totalDice);

    const formatDuration = (duration) => {
        if (!duration) return 'Unknown';
        const cleaned = duration.replace(/\s+/g, '').toLowerCase();
        const hoursMatch = cleaned.match(/(\d+)h/);
        const minutesMatch = cleaned.match(/(\d+)m/);
        const secondsMatch = cleaned.match(/(\d+)s/);
        const hours = hoursMatch ? hoursMatch[1] : '0';
        const minutes = minutesMatch ? minutesMatch[1] : '0';
        const seconds = secondsMatch ? secondsMatch[1] : '0';
        console.log(`Formatted duration: ${hours}h${minutes}m${seconds}s`);
        return `${hours}h${minutes}m${seconds}s`;
    };

    let roundDuration = 'Unknown';
    for (const line of lines) {
        if (fuzzyContains(line, "Real Time")) {
            const realTimeMatch = line.match(/real time\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
            if (realTimeMatch) {
                const hours = realTimeMatch[1] || '';  
                const minutes = realTimeMatch[2] || '';  
                const seconds = realTimeMatch[3] || '';  
                roundDuration = `${hours}${minutes}${seconds}`;
                roundDuration = formatDuration(roundDuration);
            }
            break; 
        }
    }

    const killedByRaw = getField(lines, "Killed By");
    const killedBy = killedByRaw && killedByRaw !== 'Unknown' ? killedByRaw : 'Apathy';
    console.log("Killed By:", killedBy);

    const formatDateTime = (dateTime) => {
        if (!dateTime) return 'Unknown Date';
        const date = new Date(dateTime);
        const formattedDate = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear().toString().slice(-2)}`;
        console.log("Formatted DateTime:", formattedDate);
        return formattedDate;
    };

    const formattedDateTime = formatDateTime(dateTime);

    const extractedData = {
        tier: tier,
        wave: wave,
        totalCoins: totalCoins,  
        totalCells: totalCells,
        totalDice: totalDice,
        roundDuration: roundDuration,
        killedBy: killedBy,
        dateTime: formattedDateTime,
        notes: notes
    };
    return extractedData;
}

async function applyFormatting(sheets, userSpreadsheetId) {
    console.log("Getting sheet ID to format Columns B & C");
    const newSpreadsheetResponse = await sheets.spreadsheets.get({
        spreadsheetId: userSpreadsheetId,
        fields: "sheets(properties(sheetId,title))" 
    });

    const targetSheet = newSpreadsheetResponse.data.sheets.find(sheet => sheet.properties.title === 'Farming');

    if (targetSheet) {
        const sheetId = targetSheet.properties.sheetId;
        console.log("Applying number format to sheet ID:", sheetId);

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

        console.log("Number format applied to columns B & C successfully.");
    } else {
        console.error("Sheet 'Farming' not found in the spreadsheet.");
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
    console.log(`[SUCCESS] Created new sheet from template in "Trackers": ${newSheetName} (${userSpreadsheetId})`);
    
    if (existingNewSheet) {
        console.log("[INFO] Extracting data from specific columns based on COLUMN_MAPPINGS...");

        const extractedColumns = {};

        for (const key in COLUMN_MAPPINGS) {
            const col = COLUMN_MAPPINGS[key];

            const range = `Farming!${col}5:${col}`;
            console.log(`[DEBUG] Extracting range: ${range}`);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: existingNewSheet.id,
                range: range
            });

            const colValues = response.data.values || [];
            console.log(`[DEBUG] Extracted ${colValues.length} rows from column ${col}`);
            extractedColumns[col] = [];

            colValues.forEach((row, index) => {
                let cellValue = row[0] || "";

                if (typeof cellValue === 'string' && cellValue.startsWith("'")) {
                    console.log(`Column ${col}, row ${index + 5}: Removing leading apostrophe from: ${cellValue}`);
                    cellValue = cellValue.slice(1);
                }

                if (['B', 'C'].includes(col)) {
                    const parsed = parseInt(cellValue, 10);
                    if (!isNaN(parsed)) {
                        console.log(`Column ${col}, row ${index + 5}: Converting "${cellValue}" to integer ${parsed}`);
                        cellValue = parsed;
                    } else {
                        console.log(`Column ${col}, row ${index + 5}: Invalid integer value, setting to 0`);
                        cellValue = 0;
                    }
                } else if (['D', 'E', 'F'].includes(col)) {

                    if (typeof cellValue === 'string' && !/[KMBTqQ]/.test(cellValue)) {
                        const parsed = parseFloat(cellValue);
                        if (!isNaN(parsed)) {
                            console.log(`Column ${col}, row ${index + 5}: Converting "${cellValue}" to number ${parsed}`);
                            cellValue = parsed;
                        } else {
                            console.log(`Column ${col}, row ${index + 5}: Invalid numeric value, setting to 0`);
                            cellValue = 0;
                        }
                    }
                }
                extractedColumns[col][index] = cellValue;
            });
        }

        console.log("[DEBUG] Extracted columns data:", JSON.stringify(extractedColumns, null, 2));

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

        console.log("[DEBUG] Filtered data:", JSON.stringify(filteredData, null, 2));

        for (const key of keys) {
            const col = COLUMN_MAPPINGS[key];
            const range = `Farming!${col}5:${col}`;
            console.log(`[DEBUG] Updating range: ${range} in new sheet`);
            const colIndex = keys.indexOf(key);
            const values = filteredData.map(row => [ row[colIndex] ]);
            await sheets.spreadsheets.values.update({
                spreadsheetId: userSpreadsheetId,
                range: range,
                valueInputOption: 'RAW',
                requestBody: { values: values }
            });
            console.log(`[INFO] Updated column ${col} with ${values.length} rows.`);
        }

        await applyFormatting(sheets, userSpreadsheetId);
    }

    await updatePermissions(userSpreadsheetId);
    return userSpreadsheetId;
}

async function checkForDuplicates(sheets, spreadsheetId, processedData) {
  const rowsToCheck = Array.isArray(processedData) ? processedData : [processedData];

  try {
    console.log(`[INFO] Starting duplicate check...`);
    const sheetResponse = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [
        'Farming!B5:B',  // Tier
        'Farming!C5:C',  // Wave
        'Farming!D5:D',  // Coins
        'Farming!E5:F',  // Cells
        'Farming!F5:H',  // Dice
        'Farming!G5:J',  // Duration
        'Farming!H5:L',  // KilledBy
      ]
    });

    const tierData = sheetResponse.data.valueRanges[0]?.values || [];
    const waveData = sheetResponse.data.valueRanges[1]?.values || [];
    const coinsData = sheetResponse.data.valueRanges[2]?.values || [];
    const cellsData = sheetResponse.data.valueRanges[3]?.values || [];
    const diceData = sheetResponse.data.valueRanges[4]?.values || [];
    const durationData = sheetResponse.data.valueRanges[5]?.values || [];
    const killedByData = sheetResponse.data.valueRanges[6]?.values || [];
    const existingEntries = new Map();
    const minRows = Math.min(
      tierData.length,
      waveData.length,
      coinsData.length,
      cellsData.length,
      diceData.length,
      durationData.length,
      killedByData.length
    );
    console.log(`[INFO] Existing entries length: ${minRows}`);

    for (let i = 0; i < minRows; i++) {
      const key = `${(tierData[i]?.[0] || '').trim()}|${(waveData[i]?.[0] || '').trim()}|${(coinsData[i]?.[0] || '').trim()}|${(cellsData[i]?.[0] || '').trim()}|${(diceData[i]?.[0] || '').trim()}|${(durationData[i]?.[0] || '').trim()}|${(killedByData[i]?.[0] || '').trim()}`;
      const rowNumber = i + 4; 
      if (!existingEntries.has(key)) {
        existingEntries.set(key, [rowNumber]);
      } else {
        existingEntries.get(key).push(rowNumber);
      }
      console.log(`[INFO] Stored existing entry: ${key} at row ${rowNumber}`);
    }

    const rowsToDelete = [];
    for (const [key, rowIndexes] of existingEntries) {
      if (rowIndexes.length > 1) {
        rowIndexes.sort((a, b) => b - a);
        const duplicates = rowIndexes.slice(1);
        console.log(`[INFO] For key "${key}", keeping row ${rowIndexes[rowIndexes.length - 1]} and marking duplicates: ${duplicates.join(', ')}`);
        rowsToDelete.push(...duplicates);
      }
    }
    if (rowsToDelete.length > 0) {
      rowsToDelete.sort((a, b) => b - a);
      console.log(`[INFO] Removing existing duplicates: Rows ${rowsToDelete.join(', ')}`);
      for (const row of rowsToDelete) {
        console.log(`[INFO] Deleting row ${row}`);
        await removeEntry(sheets, spreadsheetId, row);
      }
    }

    const cleanSheetResponse = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [
        'Farming!B3:B',
        'Farming!C3:C',
        'Farming!D3:D',
        'Farming!F3:F',
        'Farming!H3:H',
        'Farming!J3:J',
        'Farming!L3:L',
      ]
    });
    const ctierData = cleanSheetResponse.data.valueRanges[0]?.values || [];
    const cwaveData = cleanSheetResponse.data.valueRanges[1]?.values || [];
    const ccoinsData = cleanSheetResponse.data.valueRanges[2]?.values || [];
    const ccellsData = cleanSheetResponse.data.valueRanges[3]?.values || [];
    const cdiceData = cleanSheetResponse.data.valueRanges[4]?.values || [];
    const cdurationData = cleanSheetResponse.data.valueRanges[5]?.values || [];
    const ckilledByData = cleanSheetResponse.data.valueRanges[6]?.values || [];

    const cleanedEntries = new Map();
    const cMinRows = Math.min(
      ctierData.length,
      cwaveData.length,
      ccoinsData.length,
      ccellsData.length,
      cdiceData.length,
      cdurationData.length,
      ckilledByData.length
    );
    console.log(`[INFO] Cleaned entries length: ${cMinRows}`);
    for (let i = 0; i < cMinRows; i++) {
      const key = `${(ctierData[i]?.[0] || '').trim()}|${(cwaveData[i]?.[0] || '').trim()}|${(ccoinsData[i]?.[0] || '').trim()}|${(ccellsData[i]?.[0] || '').trim()}|${(cdiceData[i]?.[0] || '').trim()}|${(cdurationData[i]?.[0] || '').trim()}|${(ckilledByData[i]?.[0] || '').trim()}`;
      cleanedEntries.set(key, i + 4);
    }
    console.log(`[INFO] Cleaned entries map built.`);

    for (const newRow of rowsToCheck) {
      const newKey = `${(newRow.tier || '')}|${(newRow.wave || '')}|${(newRow.totalCoins || '')}|${(newRow.totalCells || '')}|${(newRow.totalDice || '')}|${(newRow.roundDuration || '').trim()}|${(newRow.killedBy || '').trim()}`;
      console.log(`[INFO] Checking new row with key: ${newKey}`);

      if (cleanedEntries.has(newKey)) {
        const duplicateRow = cleanedEntries.get(newKey);
        console.log(`[INFO] New row is an exact duplicate of row ${duplicateRow}`);
        await removeEntry(sheets, spreadsheetId, duplicateRow);
        return duplicateRow;
      }

      for (const [existingKey, rowIndex] of cleanedEntries) {
        const existingFields = existingKey.split('|');
        const newRowFields = newKey.split('|');
        let matchCount = 0;
        const criteriaIndexes = [1, 2, 3, 4, 5];
        for (const index of criteriaIndexes) {
          if (existingFields[index] === newRowFields[index]) {
            matchCount++;
          }
        }
        if (matchCount >= 3) {
          console.log(`[INFO] New row is a partial duplicate (3+ fields match) of row ${rowIndex}`);
          await removeEntry(sheets, spreadsheetId, rowIndex);
          return rowIndex;
        }
      }
    }

    console.log(`[INFO] No duplicates found`);
    return null;
  } catch (error) {
    console.error('[ERROR] Duplicate check failed:', error);
    throw error;
  }
}

function parseDurationToHours(duration) {
    if (!duration || duration === 'Unknown') {
        console.log(`[DEBUG] Invalid duration input: ${duration}`);
        return 0;
    }

    const timeMatch = duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!timeMatch) {
        console.log(`[DEBUG] Failed to parse duration: ${duration}`);
        return 0;
    }

    const hours = timeMatch[1] ? parseInt(timeMatch[1]) : 0;
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;

    const totalHours = hours + minutes / 60 + seconds / 3600;

    return totalHours;
}

function calculateRate(amount, hours) {
    console.log(`[DEBUG] Entering calculateRate with input: Amount=${amount}, Hours=${hours}`);

    if (amount == null || hours <= 0) {
        console.log(`[DEBUG] Invalid input for rate calculation. Returning 0.`);
        return {
            rate: 0,
            notation: ''
        };
    }

    let numericValue;
    let notation = '';

    if (typeof amount === 'number') {
        console.log(`[DEBUG] Amount is a number: ${amount}`);
        numericValue = amount;
    } else if (typeof amount === 'string') {
        console.log(`[DEBUG] Amount is a string: ${amount}`);
        const match = amount.match(/([\d.]+)(\D*)/);
        if (match) {
            console.log(`[DEBUG] Regex match found: Numeric value=${match[1]}, Notation=${match[2]}`);
            numericValue = parseFloat(match[1]);
            notation = match[2] || ''; 
        } else {
            console.log(`[DEBUG] No notation found. Treating as plain number: ${amount}`);
            numericValue = parseFloat(amount); 
        }
    }

    console.log(`[DEBUG] Parsed numeric value: ${numericValue}, Notation: ${notation}`);

    if (isNaN(numericValue) || hours <= 0) {
        console.log(`[DEBUG] Invalid numeric value or hours. Returning 0.`);
        return {
            rate: 0,
            notation: ''
        };
    }

    const rate = numericValue / hours;

    console.log(`[DEBUG] Calculated rate: ${rate} ${notation}`);
    return {
        rate,
        notation
    };
}

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

async function removeEntry(sheets, spreadsheetId, rowIndex = null) {
    const rangeCheck = `Farming!${COLUMN_MAPPINGS.tier}3:${COLUMN_MAPPINGS.tier}`; 
    const sheetData = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: rangeCheck
    });

    if (!sheetData.data.values || sheetData.data.values.length === 0) {
        console.log('[INFO] No entries to remove.');
        return;
    }

    const lastRow = sheetData.data.values.length + 2; 
    const targetRow = rowIndex || lastRow; 

    const clearRanges = Object.values(COLUMN_MAPPINGS).map(column => `Farming!${column}${targetRow}`);

    const requests = clearRanges.map(range => ({
        range,
        values: [
            [''] 
        ]
    }));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        resource: {
            valueInputOption: 'RAW',
            data: requests
        }
    });

    console.log(`[INFO] Cleared entry at row ${targetRow}.`);
    return targetRow;
}

async function setupSheetsAndLogData(username, processedResult) {
    const userSpreadsheetId = await migrateSheetData(username, auth);
    const sheets = google.sheets({
        version: 'v4',
        auth
    });
    let successfulLogDetails = [];
    let updateMsg;

    const targetRow = await checkForDuplicates(sheets, userSpreadsheetId, processedResult);
    const rowValues = Object.keys(COLUMN_MAPPINGS).map(key => {
        if (key === 'notes') {
            return processedResult[key] || ''; 
        }
        
        const value = processedResult[key];
        return (value === 0 || value) ? value : 0; 
    });

    if (targetRow !== null) {
        console.log(`[INFO] Duplicate found at row ${targetRow}. Updating entry...`);
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
        console.log('[INFO] No duplicate found. Adding new entry...');
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

async function extractTextFromImage(imageBuffer) {
    try {
        const { default: Ocr } = await import('@gutenye/ocr-node');
        const ocr = await Ocr.create();
        const result = await ocr.detect(imageBuffer);
        return result;
    } catch (error) {
        console.error('[ERROR] OCR processing failed:', error);
        throw error;
    }
}

function calculateSummaryStatistics(processedResult) {
    const durationHours = parseDurationToHours(processedResult.roundDuration);
    let totalCoinsPerHour = 0, totalCellsPerHour = 0;
    let coinsNotation = '', cellsNotation = '';

    if (durationHours > 0) {
        const { rate: coinsPerHour, notation: coinsUnit } = calculateRate(processedResult.totalCoins, durationHours);
        const { rate: cellsPerHour, notation: cellsUnit } = calculateRate(processedResult.totalCells, durationHours);

        totalCoinsPerHour = coinsPerHour;
        totalCellsPerHour = cellsPerHour;
        if (!coinsNotation && coinsUnit) coinsNotation = coinsUnit;
        if (!cellsNotation && cellsUnit) cellsNotation = cellsUnit;
    }

    return {
        durationHours,
        totalCoinsPerHour,
        totalCellsPerHour,
        coinsNotation,
        cellsNotation,
        avgCoinsPerHour: totalCoinsPerHour,
        avgCellsPerHour: totalCellsPerHour
    };
}

module.exports = {
    category: 'utility',
    data: new SlashCommandBuilder()
        .setName('old_tracker')
        .setDescription('Manage your run tracking.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Log a new run')
                .addAttachmentOption(option =>
                    option.setName('screenshot')
                        .setDescription('Upload a screenshot of your Battle Report')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('note')
                        .setDescription('Optional note for the screenshot'))
                .addBooleanOption(option =>
                    option.setName('start_new')
                        .setDescription('Archive your Farming sheet before logging this run')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('get_link')
                .setDescription('Get the link to your spreadsheet'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove_last')
                .setDescription('Remove the last logged entry')),

    async execute(interaction) {
        console.log(`[INFO] Command received from ${interaction.user.username}`);
        await interaction.deferReply({ ephemeral: true });
        const username = interaction.user.username;
        const subcommand = interaction.options.getSubcommand();
        const userSpreadsheetId = await migrateSheetData(username, auth);
        const successChannel = interaction.client.channels.cache.get(SUCCESS_LOG_CHANNEL_ID);

        const sendFinalReply = async (content) => {
            await interaction.followUp({ content, ephemeral: true });
        };

        if (subcommand === 'get_link') {
            const spreadsheetLink = await getSpreadsheetLink(username);
            if (successChannel) {
                let successMessage = `User ${username} requested a link to their sheet\n[View Sheet](${spreadsheetLink})`;
                successChannel.send(successMessage);
            }
            return await sendFinalReply(`📈 [View Sheet](${spreadsheetLink})`);

        } else if (subcommand === 'remove_last') {
            const sheets = google.sheets({ version: 'v4', auth });
            console.log(`[INFO] Removing last entry for user: ${username}`);
            const lastRow = await removeEntry(sheets, userSpreadsheetId);
            const spreadsheetLink = await getSpreadsheetLink(username);
            if (successChannel) {
                let successMessage = `User ${username} removed a run from row ${lastRow}\n[View Sheet](${spreadsheetLink})`;
                successChannel.send(successMessage);
            }
            return await sendFinalReply(`⚠️ Last Entry Removed from Row ${lastRow}\n[View Sheet](${spreadsheetLink})`);

        } else if (subcommand === 'add') {
            try {
                const archiveOption = interaction.options.getBoolean('archive') || false;

                if (archiveOption) {
                    const sheetsApi = google.sheets({ version: 'v4', auth });
                    const spreadsheetResponse = await sheetsApi.spreadsheets.get({
                        spreadsheetId: userSpreadsheetId,
                    });
                    const sheetsList = spreadsheetResponse.data.sheets;
                    const farmingSheet = sheetsList.find(sheet => sheet.properties.title === 'Farming');
                    if (!farmingSheet) {
                        return await sendFinalReply('Farming sheet not found.');
                    }
                    const farmingSheetId = farmingSheet.properties.sheetId;
                    const copyResponse = await sheetsApi.spreadsheets.sheets.copyTo({
                        spreadsheetId: userSpreadsheetId,
                        sheetId: farmingSheetId,
                        requestBody: {
                            destinationSpreadsheetId: userSpreadsheetId,
                        },
                    });
                    const newSheet = copyResponse.data;
                    const updatedSpreadsheetResponse = await sheetsApi.spreadsheets.get({
                        spreadsheetId: userSpreadsheetId,
                    });
                    const updatedSheetsList = updatedSpreadsheetResponse.data.sheets;
                    const archiveSheets = updatedSheetsList.filter(sheet => {
                        return /^Archive#\d+_Farming$/.test(sheet.properties.title);
                    });
                    const archiveNumbers = archiveSheets.map(sheet => {
                        const match = sheet.properties.title.match(/^Archive#(\d+)_Farming$/);
                        return match ? parseInt(match[1]) : 0;
                    });
                    const nextArchiveNumber = archiveNumbers.length > 0 ? Math.max(...archiveNumbers) + 1 : 1;
                    const newSheetName = `Archive#${nextArchiveNumber}_Farming`;

                    await sheetsApi.spreadsheets.batchUpdate({
                        spreadsheetId: userSpreadsheetId,
                        requestBody: {
                            requests: [{
                                updateSheetProperties: {
                                    properties: {
                                        sheetId: newSheet.sheetId,
                                        title: newSheetName,
                                    },
                                    fields: 'title',
                                },
                            }],
                        },
                    });

                    await Promise.all(
                        Object.values(COLUMN_MAPPINGS).map(col =>
                            sheetsApi.spreadsheets.values.clear({
                                spreadsheetId: userSpreadsheetId,
                                range: `Farming!${col}:${col}`,
                            })
                        )
                    );

                    if (successChannel) {
                        successChannel.send(`User ${username} archived Farming sheet to ${newSheetName} and cleared specified columns.`);
                    }
                }
                const attachment = interaction.options.getAttachment('screenshot');
                if (!(attachment && attachment.contentType?.startsWith('image/'))) {
                    return await sendFinalReply('Please upload a valid image file.');
                }

                const note = interaction.options.getString('note') || '';

                const filename = path.basename(attachment.name);
                let dateTime;
                const dateMatch = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
                if (dateMatch) {
                    dateTime = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}`;
                } else {
                    dateTime = new Date().toISOString();
                }

                const response = await fetch(attachment.url);
                const imageBuffer = Buffer.from(await response.arrayBuffer()); 
                const processedImage = await preprocessImage(imageBuffer);
                const text = await extractTextFromImage(processedImage);

                let processedResult = formatOCRExtraction(text, dateTime, note);
                if (!processedResult.killedBy || processedResult.killedBy.trim() === '') {
                    processedResult.killedBy = 'Apathy';
                }

                let formattedOutput;
                if (Array.isArray(processedResult)) {
                    formattedOutput = processedResult
                        .map(obj => "```json\n" + JSON.stringify(obj, null, 2) + "\n```")
                        .join('\n');
                } else {
                    formattedOutput = "```json\n" + JSON.stringify(processedResult, null, 2) + "\n```";
                }

                let unknownFields = Object.entries(processedResult)
                    .filter(([key, value]) => value === 'Unknown')
                    .map(([key]) => key);

                if (unknownFields.length > 0) {
                    console.error(`[ERROR] OCR returned 'Unknown' for fields [${unknownFields.join(', ')}] in screenshot`);
                    const errorChannel = interaction.client.channels.cache.get(ERROR_LOG_CHANNEL_ID);
                    if (errorChannel) {
                        const attachmentForError = new AttachmentBuilder(attachment.url, { name: attachment.name });
                        const spreadsheetLink = await getSpreadsheetLink(username);
                        let errorMessage = `⚠️ **OCR Error Report**\n`;
                        errorMessage += `**User:** ${username}\n`;
                        errorMessage += `**Missing/Unknown fields:** ${unknownFields.join(', ')}\n`;
                        errorMessage += `**OCR Output:**\n${processedResult}\n`;
                        errorMessage += `**[View Sheet](${spreadsheetLink})**`;
                        
                        errorChannel.send({
                            content: errorMessage,
                            files: [attachmentForError]
                        });
                    }
                }

                let summary = `📜 **Make sure all extracted data is correct before accepting:**\n`;
                for (const [key, value] of Object.entries(processedResult)) {
                    summary += `**${key}:** ${value}\n`;
                }

                const confirmRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('accept')
                        .setLabel('Accept')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('edit')
                        .setLabel('Edit')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('cancel')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

                const initialMsg = await interaction.followUp({
                    content: summary,
                    components: [confirmRow],
                    ephemeral: true
                });
                const buttonFilter = i => i.user.id === interaction.user.id;
                const buttonInteraction = await initialMsg.awaitMessageComponent({
                    filter: buttonFilter,
                    time: 120000
                });
                const decision = buttonInteraction.customId;

                if (decision === 'cancel') {
                    await buttonInteraction.update({
                        content: "❌ Processing canceled.",
                        components: []
                    });
                    return;
                } else if (decision === 'accept') {
                    await buttonInteraction.update({
                        content: "✅ Data accepted.",
                        components: []
                    });
                } else if (decision === 'edit') {
                    await buttonInteraction.update({
                        content: "Proceeding to edit...",
                        components: []
                    });

                    const fieldOptions = Object.keys(processedResult).map(field => ({
                        label: field,
                        value: field
                    }));
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('select_fields')
                        .setPlaceholder("Select fields to edit (max 5)")
                        .setMinValues(1)
                        .setMaxValues(Math.min(5, fieldOptions.length))
                        .addOptions(fieldOptions);
                    const selectRow = new ActionRowBuilder().addComponents(selectMenu);
                    const confirmButton = new ButtonBuilder()
                        .setCustomId('confirm_selection')
                        .setLabel("Confirm Selection")
                        .setStyle(ButtonStyle.Primary);
                    const buttonRow = new ActionRowBuilder().addComponents(confirmButton);

                    const selectMsg = await interaction.followUp({
                        content: "Select up to 5 fields you want to edit:",
                        components: [selectRow, buttonRow],
                        ephemeral: true
                    });

                    const selectInteraction = await selectMsg.awaitMessageComponent({
                        filter: buttonFilter,
                        time: 120000
                    });
                    if (selectInteraction.customId !== 'select_fields') {
                        return await sendFinalReply('Editing canceled.');
                    }
                    const selectedFields = selectInteraction.values;
                    await selectInteraction.update({
                        content: `Selected fields: ${selectedFields.join(', ')}`,
                        components: [selectRow, buttonRow]
                    });

                    const confirmInteraction = await selectMsg.awaitMessageComponent({
                        filter: buttonFilter,
                        time: 120000
                    });
                    if (confirmInteraction.customId !== 'confirm_selection') {
                        return await sendFinalReply('Editing canceled.');
                    }
                    const modal = new ModalBuilder()
                        .setCustomId('edit_modal')
                        .setTitle("Edit Selected Fields");
                    const modalComponents = [];
                    for (const field of selectedFields) {
                        const value = String(processedResult[field]).substring(0, 45);
                        const input = new TextInputBuilder()
                            .setCustomId(field)
                            .setLabel(field)
                            .setStyle(value.length > 80 ? TextInputStyle.Paragraph : TextInputStyle.Short)
                            .setValue(value);
                        modalComponents.push(new ActionRowBuilder().addComponents(input));
                    }
                    modal.addComponents(...modalComponents);

                    await confirmInteraction.showModal(modal);

                    const modalSubmit = await interaction.awaitModalSubmit({
                        filter: m => m.customId === 'edit_modal' && m.user.id === interaction.user.id,
                        time: 120000
                    });

                    for (const inputComponent of modalSubmit.fields.fields.values()) {
                        processedResult[inputComponent.customId] = inputComponent.value;
                    }
                    await modalSubmit.update({
                        content: "✅ Values updated.",
                        ephemeral: true
                    });
                }

                console.log('[DEBUG] Processed data:', processedResult);
                const { updateMsg, successfulLogDetails } = await setupSheetsAndLogData(username, processedResult);

                const {
                    durationHours,
                    totalCoinsPerHour,
                    totalCellsPerHour,
                    coinsNotation,
                    cellsNotation,
                    avgCoinsPerHour,
                    avgCellsPerHour
                } = calculateSummaryStatistics(processedResult);

                let logNumber = 'unknown'; 

                if (successChannel) {
                    const {
                        tier, wave, totalCoins, totalCells, totalDice,
                        roundDuration, killedBy, dateTime, notes
                    } = processedResult;

                    const formattedDate = new Date(dateTime).toLocaleString('en-US', { timeZone: 'UTC' });
                    const lastLogDetails = successfulLogDetails[successfulLogDetails.length - 1];
                    const rowMatch = lastLogDetails.match(/(row \d+)/);
                    const row = rowMatch ? parseInt(rowMatch[0].split(' ')[1]) : null;

                    logNumber = row ? row - 4 : 'unknown';

                    const logType = updateMsg.includes('updated') ? 'updated' : 'logged new';

                    let userLog = `User **${username}** ${logType} run **#${logNumber}**:\n\n`;
                    let successMessage =
                        `**Tier:** ${tier} | **Wave:** ${wave} | **Duration:** ${roundDuration}\n` +
                        `**Coins:** ${totalCoins} | **Cells:** ${totalCells} | **Dice:** ${totalDice}\n` +
                        `**Killed By:** ${killedBy} | **Date:** ${formattedDate}\n` +
                        (notes ? `**Notes:** ${notes}\n` : '') +
                        `🔗 [View Sheet](https://docs.google.com/spreadsheets/d/${userSpreadsheetId})`;

                    successChannel.send(userLog + successMessage);
                }

                const shareButton = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`shareRun_${username}_${logNumber}`)
                        .setLabel('📤 Share')
                        .setStyle(ButtonStyle.Primary)
                );

                await interaction.editReply({
                    content: `${updateMsg}\n` +
                        `💰 **Total Coins/Hour:** ${avgCoinsPerHour.toFixed(2)}${coinsNotation}\n` +
                        `📈 **Total Cells/Hour:** ${avgCellsPerHour.toFixed(2)}${cellsNotation}\n` +
                        `🔗 [View Sheet](https://docs.google.com/spreadsheets/d/${userSpreadsheetId})`,
                    ephemeral: true,
                    components: [shareButton]
                });

                console.log(`[SUCCESS] Run logged and confirmation sent to Discord for ${username}`);

                const replyMessage = await interaction.fetchReply();
                try {
                    const shareInteraction = await replyMessage.awaitMessageComponent({
                        filter: i => i.customId.startsWith('shareRun_') && i.user.id === interaction.user.id,
                        time: 120000
                    });
                    
                    await shareInteraction.deferUpdate();
                    const shareChannel = shareInteraction.channel;
 
                    await shareChannel.send(`Run shared by ${shareInteraction.member.displayName}`);

                    const attachmentUrl = attachment ? attachment.url : null;
                    if (attachmentUrl) {
                        await shareChannel.send({ files: [attachmentUrl] });
                    }
                    
                    let shareMessageContent = 
                        `💰 **Coins/Hour:** ${avgCoinsPerHour.toFixed(2)}${coinsNotation}\n` +
                        `📈 **Cells/Hour:** ${avgCellsPerHour.toFixed(2)}${cellsNotation}\n`;
                    await shareChannel.send({ content: shareMessageContent });
                    
                    const updatedRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(shareInteraction.customId)
                            .setLabel('✅ Shared')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(true)
                    );
                    await shareInteraction.editReply({ components: [updatedRow] });
                } catch (error) {
                    console.error(`[ERROR] Error processing share button interaction: ${error.message}`);
                }
            } catch (error) {
                console.error('[ERROR] Main execution failed:', error.stack);
                await interaction.editReply({
                    content: '❌ Error processing your request. Please try again.',
                    ephemeral: true
                });
            }
        }
    }
};