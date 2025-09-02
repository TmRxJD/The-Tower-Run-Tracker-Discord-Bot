const { EmbedBuilder, Colors } = require('discord.js');
const { calculateHourlyRates, formatDate, formatTime, getNumberSuffix } = require('../trackerHandlers/trackerHelpers.js');

// Helper function to format numbers for display based on preference
function formatNumberForDisplay(value, decimalPreference = 'Period (.)') {
    if (value === null || value === undefined) return 'N/A'; // Handle null/undefined
    let strValue = String(value);
    if (decimalPreference === 'Comma (,)') {
        strValue = strValue.replace(/\./g, ','); // Replace all periods with commas
    }
    return strValue;
}

// Helper functions
function toTitleCase(str) {
    // Handle potential null/undefined input
    if (!str) return '';
    return str
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function getDisplayFieldName(internalName) {
    const fieldNameMap = {
        'tier': '🔢\nTier',
        'wave': '🌊\nWave',
        'roundDuration': '⏱️\nDuration',
        'duration': '⏱️\nDuration',
        'totalCoins': '🪙\nCoins',
        'coins': '🪙\nCoins',
        'totalCells': '🔋\nCells',
        'cells': '🔋\nCells',
        'totalDice': '🎲\nDice',
        'dice': '🎲\nDice',
        'rerollShards': '🎲\nDice',
        'killedBy': '💀\nKilled By',
        'date': '📅\nDate/Time',
        'time': '⏰\nTime',
        'notes': '📝\nNotes',
        'note': '📝\nNotes',
        'type': '📋\nRun Type',
        'run#': '#️⃣\nRun #' 
    };
    // Fallback to Title Case if no specific mapping
    return fieldNameMap[internalName] || toTitleCase(internalName);
}

function getFieldFormatExample(field) {
    const examples = {
        // Keys for editing (usually lowercase)
        'tier': 'Enter a number (e.g., 14)',
        'wave': 'Enter the number of waves (e.g., 7554)',
        'totalCoins': 'Enter number with notation (e.g., 10.5q, 1.2T)',
        'coins': 'Enter number with notation (e.g., 10.5q, 1.2T)',
        'totalCells': 'Enter number with notation (e.g., 1.2M)',
        'cells': 'Enter number with notation (e.g., 1.2M)',
        'totalDice': 'Enter number with notation (e.g., 7.5K)',
        'rerollShards': 'Enter number with notation (e.g., 7.5K)',
        'roundDuration': 'Format like 1h30m45s or 1h 30m 45s',
        'duration': 'Format like 1h30m45s or 1h 30m 45s',
        'killedBy': 'Enter enemy name (e.g., "Boss")',
        'notes': 'Enter any notes, or "N/A" if none',
        'note': 'Enter any notes, or "N/A" if none',
        'date': 'Format like MM/DD/YYYY or YYYY-MM-DD',
        'time': 'Format like HH:MM (24-hour) or HH:MM AM/PM',
        'type': 'Enter run type (e.g., Farming, Challenge)',
       
        // Keys for manual entry (usually Title Case)
        'Tier': 'Enter a number (e.g., 14)',
        'Wave': 'Enter the number of waves (e.g., 7554)',
        'Coins': 'Enter number with notation (e.g., 10.5q, 1.2T)',
        'Cells': 'Enter number with notation (e.g., 1.2M)',
        'Dice': 'Enter number with notation (e.g., 7.5K)',
        'Duration': 'Format like 1h30m45s or 1h 30m 45s',
        'Killed By': 'Enter enemy name (e.g., "Boss")',
        'Notes': 'Enter any notes, or "N/A" if none'
    };
    return examples[field] || 'Enter the value';
}

function createLoadingEmbed(message = 'Processing...') {
    return new EmbedBuilder()
        .setDescription(`⏳ ${message}`)
        .setColor(Colors.Grey); // Or another appropriate color
}

function createInitialEmbed(lastRun = null, userId = null, runCount = 0, runTypeCounts = {}) {
    const embed = new EmbedBuilder()
        .setTitle('📊 The Tower Run Tracker')
        .setURL('https://the-tower-run-tracker.com/')
        .setColor(Colors.Blue);

    // Default thumbnail (same as share message)
    const defaultThumbnail = 'https://i.postimg.cc/pTVP1MPh/Screenshot-2025-05-04-124710.png';

    if (lastRun) {
        const runType = lastRun.type || 'Farming';
        const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1);
        const typeCount = runTypeCounts && runTypeCounts[runType] ? runTypeCounts[runType] : 0;
        embed.setDescription(
            `Welcome back, <@${userId}>!\nYou've logged **${runCount}** runs.\n\n` +
            `**Here is your last run:**`
        );

        const fieldsToAdd = [
            { name: getDisplayFieldName('tier') + '|Wave', value: String(lastRun.tier || 'N/A') + ' | ' + String(lastRun.wave || 'N/A') || 'N/A', inline: true },
            { name: getDisplayFieldName('duration'), value: lastRun.duration || lastRun.roundDuration || 'N/A', inline: true },
            { name: getDisplayFieldName('killedBy'), value: lastRun.killedBy || 'Unknown', inline: true },
            { name: getDisplayFieldName('coins'), value: String(lastRun.coins || lastRun.totalCoins || 'N/A'), inline: true },
            { name: getDisplayFieldName('cells'), value: String(lastRun.cells || lastRun.totalCells || 'N/A'), inline: true },
            { name: getDisplayFieldName('dice'), value: String(lastRun.rerollShards || lastRun.totalDice || 'N/A'), inline: true },
            { name: getDisplayFieldName('type'), value: formattedType, inline: true },
            { name: getDisplayFieldName('run#'), value: String(typeCount || 'N/A'), inline: true },
            { name: getDisplayFieldName('date'), value: `${lastRun.date || 'Unknown'} ${lastRun.time || ''}`.trim(), inline: true }
        ];

        if (lastRun.runId) {
            fieldsToAdd.push({ name: '🆔 Run ID', value: lastRun.runId, inline: true });
        }
        embed.addFields(fieldsToAdd);

        const noteText = lastRun.notes || lastRun.note;
        if (noteText && noteText.trim() !== '' && noteText !== 'N/A') {
            embed.addFields({
                name: getDisplayFieldName('notes'),
                value: noteText.length > 1024 ? noteText.substring(0, 1021) + '...' : noteText,
                inline: false
            });
        }
        embed.addFields({ name: '\u200B', value: '**Available Options:**' });

        // Show screenshot as thumbnail if available, else use default
        if (lastRun.screenshotUrl) {
            embed.setThumbnail(lastRun.screenshotUrl);
        } else {
            embed.setThumbnail(defaultThumbnail);
        }

    } else {
        embed.setDescription(userId ?
            `Welcome to the Tower Tracker, <@${userId}>! Log and analyze your runs.` :
            'Welcome to the Tower Tracker! Log and analyze your runs.');
        embed.setThumbnail(defaultThumbnail);
    }

    embed.addFields(
        { name: '📤 Upload', value: 'Upload a screenshot of your Battle Report for automatic run extraction.', inline: true },
        { name: '� Paste from Clipboard', value: 'Paste the Battle Report text copied from the game for fast, accurate parsing. You can also attach a screenshot for verification.', inline: true },
        { name: '�📝 Manual Entry', value: 'Manually enter all run details if you prefer not to use screenshots or OCR.', inline: true },
        { name: '✏️ Edit Last', value: 'Edit the most recent run you logged. Lets you quickly fix mistakes or update notes.', inline: true },
        { name: '🔗 Web Tracker', value: 'Open your personal tracker website to view, edit, and analyze your runs.', inline: true },
        { name: '⚙️ Settings', value: 'Configure tracker options such as scan language, timezone, and more.', inline: true },
        { name: '❌ Cancel', value: 'Close the tracker menu.', inline: true }
    );
    embed.setFooter({ text: 'Use Creator Code "JDEVO" to Support The Tower Run Tracker!' });
    return embed;
}

function createUploadEmbed() {
    return new EmbedBuilder()
        .setTitle('📤 Upload Screenshot')
        .setDescription('Please upload a screenshot of your Battle Report.')
        .addFields({
             name: 'Tips for best results:', value: 
              '• Use high-quality screenshots\n' + 
              '• Ensure text is clear and readable\n' + 
              '• Crop out unnecessary parts\n' + 
              '• Direct /track command attachment works too!'
            })
        .setColor(Colors.Green)
        .setFooter({ text: 'Upload screenshot or click Cancel.' });
}

function createManualEntryEmbed(currentField, fields) {
    const progress = `Field ${fields.indexOf(currentField) + 1} of ${fields.length}`;
    return new EmbedBuilder()
        .setTitle('📝 Manual Data Entry')
        .setDescription(`Enter the value for **${currentField}**:`) 
        .addFields(
            { name: 'Format Guidance', value: getFieldFormatExample(currentField) },
            { name: 'Progress', value: progress }
        )
        .setColor(Colors.Green)
        .setFooter({ text: 'Type your response in chat or click Cancel.' });
}

function createFieldSelectEmbed() {
    return new EmbedBuilder()
        .setTitle('✏️ Edit Fields')
        .setDescription('Select which fields you want to edit:')
        .setColor(Colors.Blue)
        .setFooter({ text: 'You can select multiple fields.' });
}

function createDataReviewEmbed(data, type = 'Extracted', isDuplicate = false, decimalPreference = 'Period (.)') {
    const embed = new EmbedBuilder()
        .setTitle(`📊 ${type} Data Review`)
        .setDescription(isDuplicate 
            ? '**⚠️ Existing entry found. Data will be updated.**\nReview the data before confirming.'
            : 'Please review the extracted data below. Ensure all values are correct before accepting.')
        .setColor(isDuplicate ? Colors.Orange : Colors.Gold);

    const standardFieldOrder = [
        'tier', 'wave', 'roundDuration', 'duration', 'totalCoins', 'coins',
        'totalCells', 'cells', 'totalDice', 'rerollShards', 'killedBy',
        'date', 'type', 'notes', 'note'
    ];
    const processedFields = new Set();

    const clamp1024 = (s) => {
        const str = String(s);
        return str.length > 1024 ? str.slice(0, 1021) + '...' : str;
    };
    const addFieldToEmbed = (key, value, inline = true) => {
        if (value !== undefined && value !== null && String(value).trim() !== '' && value !== 'N/A') {
            const formatted = formatNumberForDisplay(value, decimalPreference);
            embed.addFields({ name: getDisplayFieldName(key), value: clamp1024(formatted), inline });
        }
    };

    for (const fieldKey of standardFieldOrder) {
        if (data.hasOwnProperty(fieldKey) && !processedFields.has(fieldKey)) {
            let value = data[fieldKey];
            let inline = true;

            // Consolidate similar fields
            if ((fieldKey === 'roundDuration' || fieldKey === 'duration') && !processedFields.has('duration')) {
                value = data.duration || data.roundDuration;
                processedFields.add('duration'); processedFields.add('roundDuration');
                 addFieldToEmbed('duration', value);
            } else if ((fieldKey === 'totalCoins' || fieldKey === 'coins') && !processedFields.has('coins')) {
                value = data.coins || data.totalCoins;
                processedFields.add('coins'); processedFields.add('totalCoins');
                 addFieldToEmbed('coins', value);
            } else if ((fieldKey === 'totalCells' || fieldKey === 'cells') && !processedFields.has('cells')) {
                value = data.cells || data.totalCells;
                 processedFields.add('cells'); processedFields.add('totalCells');
                 addFieldToEmbed('cells', value);
            } else if ((fieldKey === 'totalDice' || fieldKey === 'rerollShards') && !processedFields.has('dice')) {
                value = data.rerollShards || data.totalDice || data.dice;
                processedFields.add('dice'); processedFields.add('rerollShards'); processedFields.add('totalDice');
                addFieldToEmbed('dice', value);
            } else if (fieldKey === 'date') {
                 const dateValue = data.date || data.dateTime;
                 value = dateValue ? (data.time ? `${dateValue} @ ${data.time}` : dateValue) : 'N/A';
                 processedFields.add('date'); processedFields.add('dateTime'); processedFields.add('time');
                 addFieldToEmbed('date', value);
            } else if (fieldKey === 'type') {
                value = data.type || data.uploadType || 'Farming';
                value = value.charAt(0).toUpperCase() + value.slice(1);
                processedFields.add('type'); processedFields.add('uploadType');
                addFieldToEmbed('type', value);
            } else if (fieldKey === 'notes' || fieldKey === 'note') {
                 value = data.notes || data.note;
                 inline = false;
                 processedFields.add('notes'); processedFields.add('note');
                 // Add notes field - show instruction if empty
                 embed.addFields({ 
                     name: getDisplayFieldName('notes'), 
                     value: (value && value !== 'N/A' && String(value).trim() !== '') ? 
                            clamp1024(formatNumberForDisplay(value, decimalPreference)) : 
                            "Use 'Add Note' button to attach a note", 
                     inline 
                 });
            } else if (!processedFields.has(fieldKey)) {
                 // Add other standard fields if not already processed
                 processedFields.add(fieldKey);
                 addFieldToEmbed(fieldKey, value);
            }
        }
    }

    // Add any non-standard fields remaining in data
    for (const [key, value] of Object.entries(data)) {
        if (!processedFields.has(key) && !['runId', '_id', '__v'].includes(key)) {
            addFieldToEmbed(key, value);
        }
    }

    embed.setFooter({ text: 'Confirm the data, Edit specific fields, or Cancel.' });
    return embed;
}

function createFinalEmbed(data, stats, hasScreenshot = false, isUpdate = false, runTypeCounts = {}) {
    let description;
    const runType = data.type || 'Farming';
    const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1);
    const typeCount = runTypeCounts && runTypeCounts[runType] ? runTypeCounts[runType] : 0;
    if (isUpdate) {
        description = `✅ Run **updated** successfully!`;
    } else {
        description = `✅ Run **logged** successfully!`;
    }
    description += `\n\nYou have now logged **${Object.values(runTypeCounts).reduce((a,b)=>a+b,0) || 1}** total runs.`;
    if (!data) data = {}; // Ensure data is not null/undefined

    const dateTime = data.date ? (data.time ? `${data.date} @ ${data.time}` : data.date) : 'Now';

    // Ensure stats object exists
    stats = stats || {};

    const embed = new EmbedBuilder()
        .setTitle('The Tower Run Tracker')
        .setDescription(description)
        .setURL('https://the-tower-run-tracker.com/')
        .addFields(
            { name: getDisplayFieldName('tier') + '|Wave', value: formatNumberForDisplay(data.tier) + ' | ' + formatNumberForDisplay(data.wave), inline: true },
            { name: getDisplayFieldName('duration'), value: formatNumberForDisplay(data.roundDuration || data.duration), inline: true },
            { name: getDisplayFieldName('killedBy'), value: formatNumberForDisplay(data.killedBy), inline: true },
            { name: getDisplayFieldName('coins'), value: formatNumberForDisplay(data.totalCoins || data.coins), inline: true },
            { name: getDisplayFieldName('cells'), value: formatNumberForDisplay(data.totalCells || data.cells), inline: true },
            { name: getDisplayFieldName('dice'), value: formatNumberForDisplay(data.totalDice || data.rerollShards || data.dice), inline: true },
            { name: '🪙\nCoins/Hr', value: formatNumberForDisplay(stats.coinsPerHour), inline: true },
            { name: '🔋\nCells/Hr', value: formatNumberForDisplay(stats.cellsPerHour), inline: true },
            { name: '🎲\nDice/Hr', value: formatNumberForDisplay(stats.dicePerHour), inline: true },
            { name: getDisplayFieldName('date'), value: formatNumberForDisplay(dateTime), inline: true },
            { name: getDisplayFieldName('type'), value: formatNumberForDisplay(formattedType), inline: true },
            { name: getDisplayFieldName('run#'), value: formatNumberForDisplay(typeCount), inline: true },
        )
        .setColor(isUpdate ? Colors.Orange : Colors.Green);

    const noteText = data.notes || data.note;
    if (noteText && noteText.trim() !== '' && noteText !== 'N/A') {
        embed.addFields({ name: getDisplayFieldName('notes'), value: formatNumberForDisplay(noteText), inline: false });
    }

    if (hasScreenshot) {
        embed.setImage('attachment://screenshot.png');
        embed.setFooter({ text: `Run logged. Use buttons below or start a new /track.\n\nUse Creator Code "JDEVO" to Support The Tower Run Tracker!`});
    } else {
        embed.setFooter({ text: `Run logged. Use buttons below or start a new /track.\n\nUse Creator Code "JDEVO" to Support The Tower Run Tracker!` });
    }
    
    return embed;
}

// Accepts interaction for avatar extraction
function createShareEmbed(displayName, runData, runCount, webLink, hasScreenshot, decimalPreference = 'Period (.)', runTypeCounts = {}, user, shareNotes = false) {
    if (!runData) return new EmbedBuilder().setTitle('Error').setDescription('Missing run data for sharing.');

    // Use runType count for this type, and show a simple, clear title
    const runType = runData.type || 'farming';
    const formattedType = runType.charAt(0).toUpperCase() + runType.slice(1);
    const typeCount = runTypeCounts && runTypeCounts[runType] ? runTypeCounts[runType] : 0;
    const title = `${formattedType} Run #${typeCount}`;


    let stats = {};
    try {
        if (calculateHourlyRates && (runData.duration || runData.roundDuration)) {
            stats = calculateHourlyRates(runData.duration || runData.roundDuration, runData);
        } else {
            console.warn("[ShareEmbed] Cannot calculate hourly rates. Missing function or duration.");
        }
    } catch (error) {
        console.error("[ShareEmbed] Error calculating hourly rates:", error);
    }
    stats.coinsPerHour = stats.coinsPerHour || 'N/A';
    stats.cellsPerHour = stats.cellsPerHour || 'N/A';
    stats.dicePerHour = stats.dicePerHour || 'N/A';

    const shareEmbed = new EmbedBuilder()
        .setAuthor({ name: user.username + ' Shared a Run', iconURL: user.displayAvatarURL() })
        .setTitle(title)
        .setDescription(
            `🔢 Tier: **${formatNumberForDisplay(runData.tier, decimalPreference)}**\n ` +
            `🌊 Wave: **${formatNumberForDisplay(runData.wave, decimalPreference)}**\n` +
            `⏱️ Duration: **${formatNumberForDisplay(runData.duration || runData.roundDuration, decimalPreference)}**\n` +
            `### **Earnings per Hour**`)
        .addFields(
            { name: '🪙\nCoins', value: formatNumberForDisplay(stats.coinsPerHour, decimalPreference), inline: true },
            { name: '🔋\nCells', value: formatNumberForDisplay(stats.cellsPerHour, decimalPreference), inline: true },
            { name: '🎲\nDice', value: formatNumberForDisplay(stats.dicePerHour, decimalPreference), inline: true }
        )
        .setColor(Colors.Gold)
        .setThumbnail('https://i.postimg.cc/pTVP1MPh/Screenshot-2025-05-04-124710.png')
        .setFooter({ text: `📊 Tracked with The Tower Run Tracker\nUse /track to log a run\n\nUse Creator Code "JDEVO" to Support The Tower Run Tracker!` });

    if(webLink) {
        shareEmbed.setURL(webLink);
    }

    const noteText = runData.notes || runData.note;
    if (shareNotes && noteText && noteText.trim() !== '' && noteText !== 'N/A') {
        shareEmbed.addFields({ name: getDisplayFieldName('notes'), value: formatNumberForDisplay(noteText, decimalPreference) });
    }

    if (hasScreenshot) {
        shareEmbed.setImage('attachment://screenshot.png');
    }

    return shareEmbed;
}

function createWebLinkEmbed(webLink) {
    return new EmbedBuilder()
        .setTitle('🔗 Web Tracker Link')
        .setDescription(`You can view and manage your runs on the website: ${webLink}`)
        .setColor(Colors.Blue)
        .setURL(webLink); // Set the URL for the title link
}

function createConfirmationEmbed(title, description) {
     return new EmbedBuilder()
         .setTitle(title)
         .setDescription(description)
         .setColor(Colors.Orange); // Or Yellow
 }

 function createSimpleEmbed(title, description, color = Colors.Blue) {
     return new EmbedBuilder()
         .setTitle(title)
         .setDescription(description)
         .setColor(color);
 }

 function createErrorEmbed(errorMessage, title = '❌ Error') {
     return new EmbedBuilder()
         .setTitle(title)
         .setDescription(errorMessage)
         .setColor(Colors.Red);
 }

module.exports = {
    createInitialEmbed,
    createUploadEmbed,
    createManualEntryEmbed,
    createFieldSelectEmbed,
    createDataReviewEmbed,
    createFinalEmbed,
    createShareEmbed,
    createConfirmationEmbed,
    createSimpleEmbed,
    createErrorEmbed,
    formatNumberForDisplay,
    getFieldFormatExample,
    getDisplayFieldName,
    toTitleCase,
    createLoadingEmbed,
    createWebLinkEmbed
};