// Upload flow handlers for the tracker
const { EmbedBuilder, Colors, ComponentType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const Builders = require('@discordjs/builders');
const trackerApi = require('./trackerAPI.js');
const trackerUI = require('../trackerUI');
const { userSessions, trackerEmitter } = require('./sharedState.js');
const { handleError, logError } = require('./errorHandlers.js');
const { preprocessImage, extractTextFromImage, formatOCRExtraction, getDecimalForLanguage, extractDateTimeFromImage, findPotentialDuplicateRun, formatDate, formatTime, parseBattleDateTime, formatDuration, parseTierString, applyTierMetadata, hasPlusTier } = require('./trackerHelpers.js');
function resolveBattleDateTime(...candidates) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
            return candidate;
        }
        const parsed = parseBattleDateTime(candidate);
        if (parsed) {
            return parsed;
        }
    }
    return null;
}

function isInvalidDateValue(value) {
    if (!value || String(value).trim() === '' || String(value).toLowerCase() === 'nan') return true;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime());
}

function isInvalidTimeValue(value) {
    if (!value) return true;
    const str = String(value).trim();
    if (!str) return true;
    if (/nan/i.test(str)) return true;
    if (!/\d/.test(str)) return true;
    return false;
}

function deriveBattleDateInfoFromRun(runData) {
    const fallback = new Date();
    if (!runData || typeof runData !== 'object') {
        return {
            timestamp: fallback,
            displayDate: formatDate(fallback),
            displayTime: formatTime(fallback)
        };
    }
    const combinedRunDate = runData?.runDate || runData?.date
        ? `${runData.runDate || runData.date || ''} ${runData.runTime || runData.time || ''}`.trim()
        : null;
    const combinedRunDateTime = runData?.runDateTime
        ? `${runData.runDateTime.date || ''} ${runData.runDateTime.time || ''}`.trim()
        : null;
    const timestamp = resolveBattleDateTime(
        runData?.reportTimestamp,
        runData?.['Battle Date'],
        runData?.battleDate,
        runData?.date,
        runData?.runDate,
        combinedRunDate,
        runData?.runDateTime?.combined,
        runData?.runDateTime?.full,
        combinedRunDateTime
    ) || fallback;
    const explicitDate = runData?.runDateTime?.date || runData?.runDate || runData?.date;
    const explicitTime = runData?.runDateTime?.time || runData?.runTime || runData?.time;
    return {
        timestamp,
        displayDate: isInvalidDateValue(explicitDate) ? formatDate(timestamp) : explicitDate,
        displayTime: isInvalidTimeValue(explicitTime) ? formatTime(timestamp) : explicitTime
    };
}
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // Import node-fetch

function autoAssignTournament(session, processedData, rawTierCandidates = []) {
    if (!session || !processedData) return;

    applyTierMetadata(processedData, rawTierCandidates);

    if (hasPlusTier(processedData, rawTierCandidates)) {
        processedData.tierHasPlus = true;
        if (!processedData.tierDisplay && typeof processedData.tier === 'number' && !Number.isNaN(processedData.tier)) {
            processedData.tierDisplay = `${processedData.tier}+`;
        } else if (processedData.tierDisplay && !processedData.tierDisplay.trim().endsWith('+')) {
            const numericInfo = parseTierString(processedData.tierDisplay);
            const normalized = numericInfo.numeric !== null ? `${numericInfo.numeric}+` : `${processedData.tierDisplay.trim()}+`;
            processedData.tierDisplay = normalized;
        }
        processedData.type = 'Tournament';
        session.uploadType = 'Tournament';
    }
}

// Helper to robustly process an image buffer with backend and local OCR fallback
async function robustProcessImage({
    interaction,
    imageBuffer,
    filename,
    contentType,
    attachmentUrl,
    user,
    updateReply,
    scanLanguage = 'English',
    notes = ''
}) {
    let backendError = null;
    let processedData = null;
    let extractedData = null;
    let usedBackend = false;
    // Helper: validate extracted/processed data
    function isValidData(data) {
        return data && data.tier && data.wave && data.roundDuration && data.tier >= 1 && data.wave >= 1;
    }
    function buildProcessedData(backendData, extractionPayload) {
        const combinedRunDateTime = extractionPayload?.runDateTime
            ? `${extractionPayload.runDateTime.date || ''} ${extractionPayload.runDateTime.time || ''}`.trim()
            : null;
        const resolvedTimestamp = resolveBattleDateTime(
            backendData['Battle Date'],
            backendData.battleDate,
            backendData.date,
            extractionPayload?.runDateTime?.combined,
            extractionPayload?.runDateTime?.full,
            combinedRunDateTime
        ) || new Date();
        const explicitDate = extractionPayload?.runDateTime?.date;
        const explicitTime = extractionPayload?.runDateTime?.time;
        const displayDate = isInvalidDateValue(explicitDate) ? formatDate(resolvedTimestamp) : explicitDate;
        const displayTime = isInvalidTimeValue(explicitTime) ? formatTime(resolvedTimestamp) : explicitTime;
        return {
            tier: backendData.tier ?? null,
            wave: backendData.wave ?? null,
            totalCoins: backendData.totalCoins ?? backendData.coins ?? null,
            totalCells: backendData.totalCells ?? backendData.cells ?? null,
            totalDice: backendData.totalDice ?? backendData.dice ?? backendData.rerollShards ?? null,
            roundDuration: backendData.roundDuration ?? backendData.duration ?? null,
            killedBy: backendData.killedBy ?? null,
            date: displayDate,
            time: displayTime,
            reportTimestamp: resolvedTimestamp.toISOString(),
            notes: backendData.notes ?? '',
            totalEnemies: backendData.totalEnemies ?? null,
            destroyedByOrbs: backendData.destroyedByOrbs ?? null,
            taggedByDeathWave: backendData.taggedByDeathWave ?? null,
            destroyedInSpotlight: backendData.destroyedInSpotlight ?? null,
            destroyedInGoldenBot: backendData.destroyedInGoldenBot ?? null
        };
    }
    async function runBackendOCR() {
        try {
            const p = trackerApi.runOCR(imageBuffer, filename, contentType);
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('OCR API timeout')), 10000));
            return await Promise.race([p, timeout]);
        } catch (err) {
            backendError = err;
            return null;
        }
    }
    // First attempt
    try {
        extractedData = await runBackendOCR();
        if (extractedData) {
            const backendData = extractedData.runData ? extractedData.runData : extractedData;
            processedData = buildProcessedData(backendData, extractedData);
            const tierCandidates = [backendData.tier, backendData.Tier, extractedData?.tierDisplay, extractedData?.runData?.Tier, extractedData?.runData?.tier];
            applyTierMetadata(processedData, tierCandidates);
            if (isValidData(processedData)) {
                usedBackend = true;
                return { processedData, extractedData, usedBackend, tierCandidates };
            }
        }
    } catch (err) {
        backendError = err;
    }
    // If not valid, update message and retry once
    if (updateReply) await updateReply('Retrying...');
    try {
        extractedData = await runBackendOCR();
        if (extractedData) {
            const backendData = extractedData.runData ? extractedData.runData : extractedData;
            processedData = buildProcessedData(backendData, extractedData);
            const tierCandidates = [backendData.tier, backendData.Tier, extractedData?.tierDisplay, extractedData?.runData?.Tier, extractedData?.runData?.tier];
            applyTierMetadata(processedData, tierCandidates);
            if (isValidData(processedData)) {
                usedBackend = true;
                return { processedData, extractedData, usedBackend, tierCandidates };
            }
        }
    } catch (err) {
        backendError = err;
    }
    // 2. Fallback to local OCR helpers
    try {
        if (updateReply) await updateReply('Trying local image processing...');
        const processedBuffer = await preprocessImage(imageBuffer);
        const ocrText = await extractTextFromImage(processedBuffer);
        // Try to extract date/time from filename if possible
        let dateTimeInfo = await extractDateTimeFromImage({ name: filename });
        processedData = formatOCRExtraction(
            ocrText,
            dateTimeInfo,
            notes,
            getDecimalForLanguage(scanLanguage),
            scanLanguage
        );
        const tierCandidates = [processedData.tierDisplay, processedData.tier];
        applyTierMetadata(processedData, tierCandidates);
        if (isValidData(processedData)) {
            usedBackend = false;
            return { processedData, extractedData: ocrText, usedBackend, tierCandidates };
        }
    } catch (localErr) {
        backendError = localErr;
    }
    // 3. If all fail, log error and return null
    await logError(
        interaction.client,
        user,
        backendError || new Error('Unable to extract valid data from image.'),
        'Robust OCR Failure',
        extractedData && extractedData.text ? extractedData.text : null,
        attachmentUrl
    );
    return null;
}

/**
 * Handles processing an image attachment provided directly to the /track command.
 * @param {Interaction} interaction - The command interaction.
 * @param {Attachment} attachment - The image attachment object.
 */
async function handleDirectAttachment(interaction, attachment, preNote = null) {
    // Assume this is called after deferReply or similar initial reply
    const userId = interaction.user.id;
    const username = interaction.user.username; // Get username
    const commandInteractionId = interaction.message?.interaction?.id || interaction.id; // Ensure we emit on the original command interaction
    const session = userSessions.get(userId);

    if (!session) {
        console.error('[DirectAttach] No session found for user.');
        await interaction.followUp({ content: 'Your session could not be found. Please start the command again.', ephemeral: true });
        return;
    }
    
    session.actionLog.push({ action: 'direct_attachment_received', timestamp: Date.now() });
    session.screenshotAttachment = attachment;
    userSessions.set(userId, session);
    
    console.log(`[DirectAttach] Processing image for user ${username} (${userId}): ${attachment.url}`); // Add username
    
    // Update the ephemeral reply to show processing
    await interaction.editReply({ 
        embeds: [trackerUI.createLoadingEmbed('Processing screenshot...')], // Use loading embed
        components: [] 
    }).catch(console.error); // Ignore error if already replied
    
    // Process the image robustly
    try {
        // 1. Fetch image buffer
        const response = await fetch(attachment.url);
        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
        }
        const imageBuffer = Buffer.from(await response.arrayBuffer());

        // 2. Robust OCR (backend with timeout, retry, then local fallback)
        const result = await robustProcessImage({
            interaction,
            imageBuffer,
            filename: attachment.name,
            contentType: attachment.contentType,
            attachmentUrl: attachment.url,
            user: interaction.user,
            scanLanguage: session.settings?.scanLanguage || 'English',
            notes: preNote || '',
            updateReply: async (msg) => {
                await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed(msg)], components: [] });
            }
        });

        if (!result) {
            // All OCR failed
            const errorEmbed = trackerUI.createErrorEmbed("Unable to read image. Try cropping or check your device's image quality settings.");
            const errorButtons = trackerUI.createErrorRecoveryButtons('direct_ocr_manual', 'direct_ocr_main', 'direct_ocr_cancel');
            await interaction.editReply({
                embeds: [errorEmbed],
                components: errorButtons
            });
            // Set up collector for error recovery
            const errorMsg = await interaction.fetchReply();
            const errorCollector = errorMsg.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 300000 });
            errorCollector.on('collect', async i => {
                errorCollector.stop();
                if (i.customId === 'direct_ocr_manual') {
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'manualEntryFlow', i);
                } else if (i.customId === 'direct_ocr_main') {
                    trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
                } else if (i.customId === 'direct_ocr_cancel') {
                    if (userSessions.has(userId)) userSessions.delete(userId);
                    trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', i);
                }
            });
            errorCollector.on('end', async (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    await interaction.editReply({ content: 'Image processing error timed out.', embeds:[], components:[], files:[] }).catch(() => {});
                    if (userSessions.has(userId)) userSessions.delete(userId);
                    trackerEmitter.emit(`cleanup_${commandInteractionId}`);
                }
            });
            return;
        }
    const { processedData, tierCandidates = [] } = result;
        // If a note was provided via slash option, prefer it
        if (preNote && typeof processedData === 'object') {
            processedData.notes = preNote;
        }

        // Ensure date and time default to current if not detected or invalid
        if (!processedData.date || processedData.date === 'NaN' || isNaN(new Date(processedData.date))) {
            processedData.date = new Date().toLocaleDateString('en-US');
        }
        if (!processedData.time || processedData.time === 'NaN') {
            processedData.time = new Date().toLocaleTimeString('en-US', { hour12: false });
        }

    autoAssignTournament(session, processedData, tierCandidates);
        // If tournament wasn't auto-detected, honor the selected/default run type
        if (!processedData.type) {
            processedData.type = session.uploadType || session.settings?.defaultRunType || 'Farming';
        }

        // 3. Duplicate Check Logic
        // Only check for duplicates if user setting is enabled
        if (session.settings?.autoDetectDuplicates !== false) {
            console.log('[DirectAttach] Checking for potential duplicates...');
            const existingRuns = session.cachedRunData?.allRuns || [];
            const duplicateResult = findPotentialDuplicateRun(processedData, existingRuns);
            if (duplicateResult.isDuplicate) {
                console.log(`[DirectAttach] Duplicate found! Setting editingRunId to ${duplicateResult.duplicateRunId}`);
                session.isDuplicateRun = true;
                session.editingRunId = duplicateResult.duplicateRunId;
            } else {
                console.log('[DirectAttach] No duplicate found.');
                session.isDuplicateRun = false;
                session.editingRunId = null;
            }
        } else {
            // Skip duplicate check if disabled in settings
            console.log('[DirectAttach] Duplicate check skipped due to user settings.');
            session.isDuplicateRun = false;
            session.editingRunId = null;
        }

        // Update session with processed data
        session.data = processedData;
        session.status = 'reviewing_direct_attachment'; // Update status
        userSessions.set(userId, session); // Save updated session

        // Always emit dataReview; handleDataReview will auto-submit if confirmBeforeSubmit is false
        console.log('[DirectAttach] Emitting dataReview dispatch.');
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);

    } catch (ocrError) {
        console.error(`[DirectAttach] Error processing image for ${username} (${userId}):`, ocrError);
        // Use central error handler
        handleError(interaction, ocrError, 'direct_attachment_ocr'); // Pass context identifier
    }
}

/**
 * Handles the upload flow for screenshots (when user clicks button)
 */
async function handleUploadFlow(interaction) {
    const commandInteractionId = interaction.message.interaction.id; // Get ID from original command interaction
    const userId = interaction.user.id;
    const username = interaction.user.username; // Get username
    
    try {
        // Defer handled by caller collector
        
        // Initialize or get session
        let session = userSessions.get(userId);
        if (!session) {
             console.warn(`[UploadFlow] Session missing for user ${userId}. Creating new.`);
             session = { status: 'awaiting_upload', data: {}, lastActivity: Date.now() };
             userSessions.set(userId, session);
        } else {
             session.status = 'awaiting_upload';
             session.data = {}; // Clear previous data
             session.lastActivity = Date.now();
             userSessions.set(userId, session);
        }
        
        // Show upload instructions
        const uploadEmbed = trackerUI.createUploadEmbed();
        const uploadButtons = trackerUI.createCancelButton();
        
        await interaction.editReply({ embeds: [uploadEmbed], components: [uploadButtons], files: [] });
        
        // --- Message Collector for Attachment --- 
        const channel = interaction.channel;
        if (!channel) { throw new Error("Interaction channel not found for message collector."); }

        const filter = m => m.author.id === userId && m.attachments.size > 0;
        const msgCollector = channel.createMessageCollector({ filter, max: 1, time: 300000 });
        
        msgCollector.on('collect', async m => {
            try {
                const attachment = m.attachments.first();
                if (!attachment || !attachment.contentType || !attachment.contentType.startsWith('image/')) {
                    await interaction.followUp({ content: 'Please upload an image file.', ephemeral: true });
                    return;
                }
                await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Processing screenshot...')], components: [] });
                const tempAttachmentInfo = { url: attachment.url, name: attachment.name, id: attachment.id, contentType: attachment.contentType };
                // 1. Fetch image buffer
                let imageBuffer;
                try {
                    const response = await fetch(tempAttachmentInfo.url);
                    if (!response.ok) {
                        await logError(interaction.client, interaction.user, new Error(`Fetch failed: ${response.status} ${response.statusText}`), 'Image Buffer Fetch', null, tempAttachmentInfo.url);
                        await m.delete().catch(console.error);
                        throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
                    }
                    imageBuffer = Buffer.from(await response.arrayBuffer());
                } catch (fetchErr) {
                    await m.delete().catch(console.error);
                    throw fetchErr;
                }
                await m.delete().catch(err => console.error('Failed to delete upload message:', err));
                // 2. Robust OCR (backend with timeout, retry, then local fallback)
                const result = await robustProcessImage({
                    interaction,
                    imageBuffer,
                    filename: tempAttachmentInfo.name,
                    contentType: tempAttachmentInfo.contentType,
                    attachmentUrl: tempAttachmentInfo.url,
                    user: interaction.user,
                    scanLanguage: (userSessions.get(userId)?.settings?.scanLanguage) || 'English',
                    notes: '',
                    updateReply: async (msg) => {
                        await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed(msg)], components: [] });
                    }
                });
                if (!result) {
                    const errorEmbed = trackerUI.createErrorEmbed("Unable to read image. Try cropping or check your device's image quality settings.");
                    const errorButtons = trackerUI.createErrorRecoveryButtons('upload_ocr_manual', 'upload_ocr_main', 'upload_ocr_cancel');
                    await interaction.editReply({
                        embeds: [errorEmbed],
                        components: errorButtons
                    });
                    // Set up collector for error recovery
                    const errorMsg = await interaction.fetchReply();
                    const errorCollector = errorMsg.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 300000 });
                    errorCollector.on('collect', async i => {
                        errorCollector.stop();
                        if (i.customId === 'upload_ocr_manual') {
                            trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'manualEntryFlow', i);
                        } else if (i.customId === 'upload_ocr_main') {
                            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
                        } else if (i.customId === 'upload_ocr_cancel') {
                            if (userSessions.has(userId)) userSessions.delete(userId);
                            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', i);
                        }
                    });
                    errorCollector.on('end', async (collected, reason) => {
                        if (reason === 'time' && collected.size === 0) {
                            await interaction.editReply({ content: 'Image processing error timed out.', embeds:[], components:[], files:[] }).catch(() => {});
                            if (userSessions.has(userId)) userSessions.delete(userId);
                            trackerEmitter.emit(`cleanup_${commandInteractionId}`);
                        }
                    });
                    return;
                }
                const { processedData, tierCandidates = [] } = result;
                // Get session again before modifying
                const sessionForDuplicateCheck = userSessions.get(userId);
                if (!sessionForDuplicateCheck) throw new Error("Session lost before duplicate check.");
                autoAssignTournament(sessionForDuplicateCheck, processedData, tierCandidates);
                // Duplicate check logic
                if (sessionForDuplicateCheck.settings?.autoDetectDuplicates !== false) {
                    console.log('[UploadFlow] Checking for potential duplicates...');
                    const existingRuns = sessionForDuplicateCheck.cachedRunData?.allRuns || [];
                    const duplicateResult = findPotentialDuplicateRun(processedData, existingRuns);
                    if (duplicateResult.isDuplicate) {
                        console.log(`[UploadFlow] Duplicate found! Setting editingRunId to ${duplicateResult.duplicateRunId}`);
                        sessionForDuplicateCheck.isDuplicateRun = true;
                        sessionForDuplicateCheck.editingRunId = duplicateResult.duplicateRunId;
                    } else {
                        console.log('[UploadFlow] No duplicate found.');
                        sessionForDuplicateCheck.isDuplicateRun = false;
                        sessionForDuplicateCheck.editingRunId = null;
                    }
                } else {
                    console.log('[UploadFlow] Duplicate check skipped due to user settings.');
                    sessionForDuplicateCheck.isDuplicateRun = false;
                    sessionForDuplicateCheck.editingRunId = null;
                }

                // Ensure date and time default to current if not detected or invalid
                if (!processedData.date || processedData.date === 'NaN' || isNaN(new Date(processedData.date))) {
                    processedData.date = new Date().toLocaleDateString('en-US');
                }
                if (!processedData.time || processedData.time === 'NaN') {
                    processedData.time = new Date().toLocaleTimeString('en-US', { hour12: false });
                }

                sessionForDuplicateCheck.data = processedData;
                sessionForDuplicateCheck.screenshotAttachment = tempAttachmentInfo;
                userSessions.set(userId, sessionForDuplicateCheck);
                console.log('[UploadFlow] Emitting dataReview dispatch.');
                trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
            } catch (error) {
                console.error('Error processing uploaded image message:', error);
                trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
            }
        });
        
        // --- Button Collector for Cancel --- 
        const buttonMessage = await interaction.fetchReply(); // Message with cancel button
        const btnCollector = buttonMessage.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 300000});

        btnCollector.on('collect', async i => {
            if (i.customId === 'tracker_cancel') {
                 msgCollector.stop('cancelled'); // Stop listening for messages, add reason
                 btnCollector.stop('cancelled'); // Stop self
                 trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', i);
            }
        });
        
        // --- Handle Timeouts --- 
        const handleTimeout = (collectorType) => {
             console.log(`[UploadFlow] ${collectorType} collector timed out.`);
             // Check if *another* collector already handled it (like cancel button)
             const session = userSessions.get(userId);
             // Only cancel if still in this state AND not cancelled by button
             if (session?.status === 'awaiting_upload' && msgCollector.endedReason !== 'cancelled' && btnCollector.endedReason !== 'cancelled') { 
                 trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true); // Emit timeout cancel
             }
        };

        msgCollector.on('end', (collected, reason) => {
            if (reason === 'time') handleTimeout('Message');
        });
         btnCollector.on('end', (collected, reason) => {
             if (reason === 'time' && collected.size === 0) handleTimeout('Button'); // Only timeout if button wasn't clicked
         });

    } catch (error) {
        console.error('Error in upload flow:', error);
         trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
    }
}

module.exports = {
    handleUploadFlow,
    handleDirectAttachment,
    handleDirectTextPaste,
    handlePasteFlow,
    handleAddRunFlow,
    parseRunDataFromText
};

/**
 * Parse run data from raw battle report text per requested regex approach.
 * Accepts the full text string and returns structured data compatible with downstream flow.
 */
function parseRunDataFromText(rawText) {
    if (typeof rawText !== 'string') rawText = String(rawText || '');
    const text = rawText.replace(/,/g, '.').replace(/\r/g, '').trim();
    const lines = text.split(/\n+/);
    // Whole-text matcher to handle flattened input (labels and values separated by multiple spaces)
    const getFromText = (labelPattern, valueRegex) => {
        try {
            const re = new RegExp(`${labelPattern}\\s*[:|-]?\\s*(${valueRegex.source})`, 'i');
            const m = text.match(re);
            return m ? (m[1] || '').trim() : '';
        } catch {
            return '';
        }
    };
    // Line-based fallback when actual newlines exist
    const getLine = (label) => {
        const re = new RegExp(`^\\s*${label}\\s*[:|-]?\\s*(.*)$`, 'i');
        for (const line of lines) {
            const m = line.match(re);
            if (m) return (m[1] || '').trim();
        }
        return '';
    };
    const get = (label, pattern) => {
        const fromWhole = getFromText(label, pattern);
        if (fromWhole) return fromWhole;
        const source = getLine(label) || '';
        if (!source) return '';
        const m = String(source).match(pattern);
        return m ? m[0] : '';
    };
    // Fields per user instruction
    const tierRaw = get('Tier', /\d+\+?/);
    const waveRaw = get('Wave', /\d+/);
    const durationRaw = get('Real\\s*Time', /[\dhms :]+/);
    const coinsRaw = get('Coins\\s*Earned', /[\d,\.a-zA-Z$]+/);
    const cellsRaw = get('Cells\\s*Earned', /[\d,\.a-zA-Z]+/);
    const rerollShardsRaw = get('Reroll\\s*Shards\\s*Earned', /[\d,\.a-zA-Z]+/);
    const battleDateRaw = get('Battle\\s*Date', /.+/);
    // Killed By: capture only the first word token after the label
    let killedByRaw = '';
    {
        const km = text.match(/Killed\s*By\s*[:|-]?\s*([A-Za-z][A-Za-z'-]*)/i);
        killedByRaw = km ? km[1] : '';
        if (!killedByRaw) {
            const fallback = get('Killed\s*By', /[A-Za-z][A-Za-z'-]*/);
            killedByRaw = fallback || '';
        }
    }

    // Normalize
    const tierInfo = parseTierString(tierRaw);
    const tier = tierInfo.numeric !== null ? tierInfo.numeric : 'Unknown';
    const wave = waveRaw ? parseInt(waveRaw, 10) : 'Unknown';
    const duration = durationRaw ? durationRaw.trim() : '';
    const roundDuration = formatDuration(duration);
    const totalCoins = coinsRaw || '0';
    const totalCells = cellsRaw || '0';
    const totalDice = rerollShardsRaw || '0';
    const killedBy = (killedByRaw || '').trim() || 'Apathy';

    const now = new Date();
    const battleDateTime = parseBattleDateTime(battleDateRaw);
    const resolvedTimestamp = battleDateTime || now;
    return {
        tier,
        wave,
        roundDuration,
        totalCoins,
        totalCells,
        totalDice,
        killedBy,
        date: formatDate(resolvedTimestamp),
        time: formatTime(resolvedTimestamp),
        reportTimestamp: resolvedTimestamp.toISOString(),
        notes: '',
        tierDisplay: tierInfo.display || (tier !== 'Unknown' ? String(tier) : ''),
        tierHasPlus: tierInfo.hasPlus
    };
}

/**
 * Handle pasted text provided directly to /track via option, with optional screenshot.
 * Prefer text parsing and still upload screenshot for verification if provided.
 */
async function handleDirectTextPaste(interaction, text, attachmentOrNull, preNote = null) {
    const userId = interaction.user.id;
    const commandInteractionId = interaction.message?.interaction?.id || interaction.id; // Ensure we emit on the original command interaction
    let session = userSessions.get(userId) || { status: 'initial', data: {}, lastActivity: Date.now() };
    session.lastActivity = Date.now();
    if (attachmentOrNull) {
        // store minimal info or the same object as direct attachment
        session.screenshotAttachment = attachmentOrNull;
    }
    userSessions.set(userId, session);

    // Ensure interaction is deferred
    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (error) {
        if (error.code === 40060 || error.code === 'InteractionAlreadyReplied') {
            // Already acknowledged or replied, proceed
            console.log(`[DirectPaste] Interaction ${interaction.id} already acknowledged/replied, proceeding`);
        } else {
            throw error;
        }
    }

    try {
        await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Parsing pasted text...')], components: [] });
    } catch (error) {
        if (error.code === 'InteractionNotReplied') {
            console.log(`[DirectPaste] Interaction ${interaction.id} not deferred, deferring now`);
            await interaction.deferReply({ ephemeral: true });
            await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Parsing pasted text...')], components: [] });
        } else {
            throw error;
        }
    }

    try {
        // Debug: log raw text before parsing
        try {
            console.log(`[Paste] Raw text (${(text || '').length} chars):`, String(text || '').slice(0, 2000));
        } catch {}
        const parsedResponse = await trackerApi.parseBattleReport(text);
        const runData = parsedResponse.runData || parsedResponse;
        
        // Extract editable fields for review
        const { timestamp: resolvedTimestamp, displayDate, displayTime } = deriveBattleDateInfoFromRun(runData);
        const processedData = {
            tier: runData.Tier ?? runData.tier,
            wave: runData.Wave ?? runData.wave,
            totalCoins: runData['Coins earned'] ?? runData['Coins Earned'] ?? runData['Battle Report Coins earned'] ?? runData.totalCoins ?? runData.coins,
            totalCells: runData['Cells Earned'] ?? runData.totalCells ?? runData.cells,
            totalDice: runData['Reroll Shards Earned'] ?? runData.totalDice ?? runData.rerollShards,
            roundDuration: runData['Real Time'] ?? runData.roundDuration ?? runData.duration,
            killedBy: (runData['Killed By'] || runData.killedBy || '').toString().trim() || 'Apathy',
            date: displayDate,
            time: displayTime,
            reportTimestamp: resolvedTimestamp.toISOString(),
            notes: preNote || '',
            // Add coverage data for sharing
            totalEnemies: runData['Total Enemies'] || runData.totalEnemies,
            destroyedByOrbs: runData['Destroyed By Orbs'] || runData.destroyedByOrbs,
            taggedByDeathWave: runData['Tagged by Deathwave'] || runData.taggedByDeathWave,
            destroyedInSpotlight: runData['Destroyed in Spotlight'] || runData.destroyedInSpotlight,
            destroyedInGoldenBot: runData['Destroyed in Golden Bot'] || runData.destroyedInGoldenBot
        };
        applyTierMetadata(processedData, [runData.Tier, runData.tier]);
        autoAssignTournament(session, processedData, [runData.Tier, runData.tier]);
        if (!processedData.type) {
            processedData.type = session.uploadType || session.settings?.defaultRunType || 'Farming';
        }
        
        if (preNote) {
            processedData.notes = preNote;
        }

        // Ensure date and time default to current if not detected or invalid
        if (!processedData.date || processedData.date === 'NaN' || isNaN(new Date(processedData.date))) {
            processedData.date = new Date().toLocaleDateString('en-US');
        }
        if (!processedData.time || processedData.time === 'NaN') {
            processedData.time = new Date().toLocaleTimeString('en-US', { hour12: false });
        }
        // Debug: log parsed data after parsing
        try {
            console.log('[Paste] Parsed data:', processedData);
        } catch {}

        // Duplicate check
        if (session.settings?.autoDetectDuplicates !== false) {
            const existingRuns = session.cachedRunData?.allRuns || [];
            const duplicateResult = findPotentialDuplicateRun(processedData, existingRuns);
            session.isDuplicateRun = !!duplicateResult.isDuplicate;
            session.editingRunId = duplicateResult.isDuplicate ? duplicateResult.duplicateRunId : null;
        } else {
            session.isDuplicateRun = false;
            session.editingRunId = null;
        }

        session.data = processedData;
        session.runData = runData; // Store canonical runData at session level
        session.status = 'reviewing_direct_text';
        userSessions.set(userId, session);

        // Go to review
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
    } catch (err) {
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            console.log('[Paste] API timeout, falling back to local parsing');
            // Fallback to local parsing
            const processedData = parseRunDataFromText(text);
            applyTierMetadata(processedData, []);
            autoAssignTournament(session, processedData, []);
            if (!processedData.type) {
                processedData.type = session.uploadType || session.settings?.defaultRunType || 'Farming';
            }
            if (preNote) {
                processedData.notes = preNote;
            }
            // Duplicate check
            if (session.settings?.autoDetectDuplicates !== false) {
                const existingRuns = session.cachedRunData?.allRuns || [];
                const duplicateResult = findPotentialDuplicateRun(processedData, existingRuns);
                session.isDuplicateRun = !!duplicateResult.isDuplicate;
                session.editingRunId = duplicateResult.isDuplicate ? duplicateResult.duplicateRunId : null;
            } else {
                session.isDuplicateRun = false;
                session.editingRunId = null;
            }
            session.data = processedData;
            session.runData = processedData; // Use processedData as runData
            session.status = 'reviewing_direct_text';
            userSessions.set(userId, session);
            // Go to review
            trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
        } else {
            await logError(interaction.client, interaction.user, err, 'direct_text_paste');
        }
    }
}

/**
 * Paste flow from main menu: prompt user to paste text; optionally allow a screenshot in same step.
 */
async function handlePasteFlow(interaction) {
    console.log(`[PasteFlow] Starting paste flow for interaction ${interaction.id}`);
    const commandInteractionId = interaction.message.interaction.id;
    const userId = interaction.user.id;
    let session = userSessions.get(userId) || { status: 'awaiting_paste', data: {}, lastActivity: Date.now() };
    session.status = 'awaiting_paste';
    session.data = {};
    session.lastActivity = Date.now();
    userSessions.set(userId, session);

    // Show modal to collect text (prevents user message from appearing in channel)
    const modal = new ModalBuilder().setCustomId('tracker_paste_modal').setTitle('Paste Battle Report');
    const textInput = new TextInputBuilder()
        .setCustomId('tracker_paste_text')
        .setLabel('Battle Report Text')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
    const noteInput = new TextInputBuilder()
        .setCustomId('tracker_paste_note')
        .setLabel('Optional Note')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    const row1 = new ActionRowBuilder().addComponents(textInput);
    const row2 = new ActionRowBuilder().addComponents(noteInput);
    modal.addComponents(row1, row2);
    console.log(`[PasteFlow] Showing modal for interaction ${interaction.id}`);
    await interaction.showModal(modal);

    try {
        console.log(`[PasteFlow] Awaiting modal submit for interaction ${interaction.id}`);
        const submitted = await interaction.awaitModalSubmit({
            filter: i => i.customId === 'tracker_paste_modal' && i.user.id === userId,
            time: 300000
        });
        console.log(`[PasteFlow] Modal submitted for interaction ${submitted.id}`);
        try {
            await submitted.deferUpdate();
        } catch (deferError) {
            if (deferError.code === 40060) {
                console.log(`[PasteFlow] Modal submit already acknowledged, proceeding without defer`);
            } else {
                throw deferError;
            }
        }
        const text = submitted.fields.getTextInputValue('tracker_paste_text');
        const preNote = submitted.fields.getTextInputValue('tracker_paste_note') || null;
        await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Parsing pasted text...')], components: [] });
        try { console.log(`[PasteFlow] Raw text (${(text || '').length} chars):`, String(text || '').slice(0, 2000)); } catch {}
        console.log(`[PasteFlow] Attempting API parse`);
        const parsedResponse = await trackerApi.parseBattleReport(text);
        const runData = parsedResponse.runData || parsedResponse;
        
        // Extract editable fields for review
        const { timestamp: resolvedTimestamp, displayDate, displayTime } = deriveBattleDateInfoFromRun(runData);
        const processedData = {
            tier: runData.Tier ?? runData.tier,
            wave: runData.Wave ?? runData.wave,
            totalCoins: runData['Coins earned'] ?? runData['Coins Earned'] ?? runData['Battle Report Coins earned'] ?? runData.totalCoins ?? runData.coins,
            totalCells: runData['Cells Earned'] ?? runData.totalCells ?? runData.cells,
            totalDice: runData['Reroll Shards Earned'] ?? runData.totalDice ?? runData.rerollShards,
            roundDuration: runData['Real Time'] ?? runData.roundDuration ?? runData.duration,
            killedBy: (runData['Killed By'] || runData.killedBy || '').toString().trim() || 'Apathy',
            date: displayDate,
            time: displayTime,
            reportTimestamp: resolvedTimestamp.toISOString(),
            notes: preNote || '',
            // Add coverage data for sharing
            totalEnemies: runData['Total Enemies'] || runData.totalEnemies,
            destroyedByOrbs: runData['Destroyed By Orbs'] || runData.destroyedByOrbs,
            taggedByDeathWave: runData['Tagged by Deathwave'] || runData.taggedByDeathWave,
            destroyedInSpotlight: runData['Destroyed in Spotlight'] || runData.destroyedInSpotlight,
            destroyedInGoldenBot: runData['Destroyed in Golden Bot'] || runData.destroyedInGoldenBot
        };
        
        applyTierMetadata(processedData, [runData.Tier, runData.tier]);
        if (preNote) processedData.notes = preNote;

        // Ensure date and time default to current if not detected or invalid
        if (!processedData.date || processedData.date === 'NaN' || isNaN(new Date(processedData.date))) {
            processedData.date = new Date().toLocaleDateString('en-US');
        }
        if (!processedData.time || processedData.time === 'NaN') {
            processedData.time = new Date().toLocaleTimeString('en-US', { hour12: false });
        }
        try { console.log('[PasteFlow] Parsed data:', processedData); } catch {}

    const sessionForDup = userSessions.get(userId) || session;
    autoAssignTournament(sessionForDup, processedData, [runData.Tier, runData.tier]);
        if (!processedData.type) {
            processedData.type = sessionForDup.uploadType || sessionForDup.settings?.defaultRunType || 'Farming';
        }
        if (sessionForDup.settings?.autoDetectDuplicates !== false) {
            const existingRuns = sessionForDup.cachedRunData?.allRuns || [];
            const duplicateResult = findPotentialDuplicateRun(processedData, existingRuns);
            sessionForDup.isDuplicateRun = !!duplicateResult.isDuplicate;
            sessionForDup.editingRunId = duplicateResult.isDuplicate ? duplicateResult.duplicateRunId : null;
        } else {
            sessionForDup.isDuplicateRun = false;
            sessionForDup.editingRunId = null;
        }
        sessionForDup.data = processedData;
        sessionForDup.runData = runData; // Store canonical runData at session level
        sessionForDup.status = 'reviewing_paste';
        userSessions.set(userId, sessionForDup);
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
    } catch (err) {
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            console.log('[PasteFlow] API timeout, falling back to local parsing');
            // Fallback to local parsing
            const processedData = parseRunDataFromText(text);
            applyTierMetadata(processedData, []);
            if (preNote) processedData.notes = preNote;

            // Ensure date and time default to current if not detected or invalid
            if (!processedData.date || processedData.date === 'NaN' || isNaN(new Date(processedData.date))) {
                processedData.date = new Date().toLocaleDateString('en-US');
            }
            if (!processedData.time || processedData.time === 'NaN') {
                processedData.time = new Date().toLocaleTimeString('en-US', { hour12: false });
            }
            const sessionForDup = userSessions.get(userId) || session;
            autoAssignTournament(sessionForDup, processedData, []);
            if (!processedData.type) {
                processedData.type = sessionForDup.uploadType || sessionForDup.settings?.defaultRunType || 'Farming';
            }
            if (sessionForDup.settings?.autoDetectDuplicates !== false) {
                const existingRuns = sessionForDup.cachedRunData?.allRuns || [];
                const duplicateResult = findPotentialDuplicateRun(processedData, existingRuns);
                sessionForDup.isDuplicateRun = !!duplicateResult.isDuplicate;
                sessionForDup.editingRunId = duplicateResult.isDuplicate ? duplicateResult.duplicateRunId : null;
            } else {
                sessionForDup.isDuplicateRun = false;
                sessionForDup.editingRunId = null;
            }
            sessionForDup.data = processedData;
            sessionForDup.runData = processedData; // Use processedData as runData
            sessionForDup.status = 'reviewing_paste';
            userSessions.set(userId, sessionForDup);
            trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
        } else if (String(err || '').includes('TIME')) {
            console.log(`[PasteFlow] Modal timeout, emitting cancel`);
            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true);
        } else {
            console.log(`[PasteFlow] Other error in modal flow`);
            logError(interaction.client, interaction.user, err, 'paste_flow_modal');
        }
    }
}

/**
 * Combined Add Run flow: single modal that supports optional paste text, required run type select, and optional file upload.
 * Defaults run type to Farming.
 */
async function handleAddRunFlow(interaction) {
    const commandInteractionId = interaction.message?.interaction?.id || interaction.id;
    const userId = interaction.user.id;
    let session = userSessions.get(userId) || { status: 'awaiting_addrun', data: {}, lastActivity: Date.now() };
    session.status = 'awaiting_addrun';
    session.data = {};
    session.lastActivity = Date.now();
    userSessions.set(userId, session);

    // Build modal using new components (select + file upload) and a standard text input for paste
    const modal = new Builders.ModalBuilder().setCustomId('tracker_addrun_modal').setTitle('Add New Run');

    // Run Type select (required), default to Farming
    const runTypeSelect = new Builders.StringSelectMenuBuilder()
        .setCustomId('addrun_run_type')
        .setPlaceholder('Select run type')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            { label: 'Farming', value: 'Farming', default: true },
            { label: 'Overnight', value: 'Overnight' },
            { label: 'Tournament', value: 'Tournament' },
            { label: 'Milestone', value: 'Milestone' }
        );
    const labeledRunType = new Builders.LabelBuilder().setLabel('Run Type').setStringSelectMenuComponent(runTypeSelect);

    // Optional paste text input
    const pasteInput = new TextInputBuilder()
        .setCustomId('addrun_paste_text')
        .setLabel('Battle Report Text')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);
    const pasteRow = new ActionRowBuilder().addComponents(pasteInput);

    // Optional notes input
    const noteInput = new TextInputBuilder()
        .setCustomId('addrun_note')
        .setLabel('Notes')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    const noteRow = new ActionRowBuilder().addComponents(noteInput);

    // Optional file upload (explicitly mark optional if supported)
    const fileUpload = new Builders.FileUploadBuilder().setCustomId('addrun_file');
    if (typeof fileUpload.setRequired === 'function') {
        try { fileUpload.setRequired(false); } catch { /* ignore if not supported */ }
    }
    const labeledFile = new Builders.LabelBuilder().setLabel('Upload Screenshot (optional)').setFileUploadComponent(fileUpload);
    if (typeof labeledFile.setRequired === 'function') {
        try { labeledFile.setRequired(false); } catch { /* ignore if not supported */ }
    }

    // Order: Paste Text, Notes, Run Type, Screenshot
    modal.addComponents(pasteRow);
    modal.addComponents(noteRow);
    modal.addLabelComponents(labeledRunType);
    modal.addLabelComponents(labeledFile);

    // Show modal
    await interaction.showModal(modal);

    try {
        const submitted = await interaction.awaitModalSubmit({
            filter: i => i.customId === 'tracker_addrun_modal' && i.user.id === userId,
            time: 300000
        });

        // Acknowledge modal
        try { await submitted.deferUpdate(); } catch { /* already acknowledged */ }

        // Helper deep finder (from modalDemo)
        const findByCustomIdDeep = (node, id, seen = new Set()) => {
            if (!node) return null;
            const t = typeof node;
            if (t !== 'object') return null;
            if (seen.has(node)) return null;
            seen.add(node);
            if (node.customId === id) return node;
            if (Array.isArray(node)) {
                for (const item of node) { const found = findByCustomIdDeep(item, id, seen); if (found) return found; }
            } else {
                for (const key of Object.keys(node)) { const found = findByCustomIdDeep(node[key], id, seen); if (found) return found; }
            }
            return null;
        };
        const toArray = (val) => {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            if (typeof val.values === 'function') { try { return Array.from(val.values()); } catch { } }
            if (typeof Symbol !== 'undefined' && val[Symbol.iterator]) { try { return Array.from(val); } catch { } }
            if (typeof val === 'object') { try { return Object.values(val); } catch { } }
            return [];
        };
        const looksLikeFile = (f) => !!f && (typeof f === 'object') && (
            'name' in f || 'filename' in f || 'content_type' in f || 'size' in f || 'url' in f || 'attachment' in f || 'proxy_url' in f
        );

        // Extract selected run type
        let selectedRunType = 'Farming';
        try {
            const typeComp = findByCustomIdDeep(submitted.components, 'addrun_run_type');
            let values = Array.isArray(typeComp?.values) ? typeComp.values : [];
            if (!values.length && typeComp && typeof typeComp.value === 'string') values = [typeComp.value];
            if (values.length) selectedRunType = values[0];
        } catch {}

        // Update session with selected run type
        const sess = userSessions.get(userId) || session;
        sess.uploadType = selectedRunType;
        userSessions.set(userId, sess);

    // Extract paste text
        let pastedText = '';
        try { pastedText = submitted.fields.getTextInputValue('addrun_paste_text') || ''; } catch { pastedText = ''; }

    // Extract note
    let preNote = null;
    try { preNote = submitted.fields.getTextInputValue('addrun_note') || null; } catch { preNote = null; }

        // Extract uploaded file (if any)
        let uploadedFile = null;
        try {
            const fileComp = findByCustomIdDeep(submitted.components, 'addrun_file');
            const primary = toArray(fileComp?.files);
            const alt = toArray(fileComp?.attachments);
            let candidates = primary.length ? primary : alt;
            if (!candidates.length) {
                const more = [submitted.files, submitted.attachments, submitted.data?.attachments, submitted.data?.resolved?.attachments];
                for (const c of more) { const arr = toArray(c); if (arr.length && looksLikeFile(arr[0])) { candidates = arr; break; } }
            }
            if (!candidates.length) {
                // shallow scan
                const scanKeys = ['files', 'attachments'];
                outer: for (const key of scanKeys) {
                    for (const row of submitted.components ?? []) {
                        const arr = toArray(row[key]);
                        if (arr.length && looksLikeFile(arr[0])) { candidates = arr; break outer; }
                        for (const comp of row.components ?? []) {
                            const a2 = toArray(comp[key]);
                            if (a2.length && looksLikeFile(a2[0])) { candidates = a2; break outer; }
                        }
                    }
                }
            }
            if (candidates.length) {
                const f = candidates[0];
                // Normalize to minimal attachment object expected by handleDirectAttachment
                const url = f.url || f.proxy_url || f.attachment || null;
                const name = f.name || f.filename || 'screenshot.png';
                const contentType = f.content_type || f.contentType || 'image/png';
                if (url) uploadedFile = { url, name, contentType, id: f.id || undefined };
            }
        } catch {}

        // Route based on inputs: prefer pasted text when present
        if (pastedText && pastedText.trim().length > 0) {
            // If we managed to capture an uploaded file too, pass it along
            await handleDirectTextPaste(interaction, pastedText.trim(), uploadedFile || null, preNote);
            return;
        }

        if (uploadedFile) {
            await handleDirectAttachment(interaction, uploadedFile, preNote);
            return;
        }

        // Neither text nor file provided
        await interaction.followUp({ content: 'Please paste the Battle Report text or upload a screenshot in the modal.', ephemeral: true }).catch(() => {});
        // Return to main menu
        trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', interaction);
    } catch (err) {
        if (String(err || '').includes('TIME')) {
            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true);
        } else {
            await logError(interaction.client, interaction.user, err, 'add_run_modal_flow');
        }
    }
}