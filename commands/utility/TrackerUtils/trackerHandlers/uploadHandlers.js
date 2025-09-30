// Upload flow handlers for the tracker
const { EmbedBuilder, Colors, ComponentType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const trackerApi = require('./trackerAPI.js');
const trackerUI = require('../trackerUI');
const { userSessions, trackerEmitter } = require('./sharedState.js');
const { handleError, logError } = require('./errorHandlers.js');
const { preprocessImage, extractTextFromImage, formatOCRExtraction, getDecimalForLanguage, extractDateTimeFromImage, findPotentialDuplicateRun, formatDate, formatTime, formatDuration } = require('./trackerHelpers.js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // Import node-fetch

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
    // 1. Try backend OCR with timeout (10s)
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
            processedData = {
                tier: backendData.tier ?? null,
                wave: backendData.wave ?? null,
                totalCoins: backendData.totalCoins ?? backendData.coins ?? null,
                totalCells: backendData.totalCells ?? backendData.cells ?? null,
                totalDice: backendData.totalDice ?? backendData.dice ?? backendData.rerollShards ?? null,
                roundDuration: backendData.roundDuration ?? backendData.duration ?? null,
                killedBy: backendData.killedBy ?? null,
                date: extractedData.runDateTime?.date ?? null,
                time: extractedData.runDateTime?.time ?? null,
                notes: backendData.notes ?? ''
            };
            if (isValidData(processedData)) {
                usedBackend = true;
                return { processedData, extractedData, usedBackend };
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
            processedData = {
                tier: backendData.tier ?? null,
                wave: backendData.wave ?? null,
                totalCoins: backendData.totalCoins ?? backendData.coins ?? null,
                totalCells: backendData.totalCells ?? backendData.cells ?? null,
                totalDice: backendData.totalDice ?? backendData.dice ?? backendData.rerollShards ?? null,
                roundDuration: backendData.roundDuration ?? backendData.duration ?? null,
                killedBy: backendData.killedBy ?? null,
                date: extractedData.runDateTime?.date ?? null,
                time: extractedData.runDateTime?.time ?? null,
                notes: backendData.notes ?? ''
            };
            if (isValidData(processedData)) {
                usedBackend = true;
                return { processedData, extractedData, usedBackend };
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
        if (isValidData(processedData)) {
            usedBackend = false;
            return { processedData, extractedData: ocrText, usedBackend };
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
    const commandInteractionId = interaction.id; // Use the direct interaction ID
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
        const { processedData } = result;
        // If a note was provided via slash option, prefer it
        if (preNote && typeof processedData === 'object') {
            processedData.notes = preNote;
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
                    const errorButtons = createErrorRecoveryButtons('upload_ocr_manual', 'upload_ocr_main', 'upload_ocr_cancel');
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
                const { processedData } = result;
                // Get session again before modifying
                const sessionForDuplicateCheck = userSessions.get(userId);
                if (!sessionForDuplicateCheck) throw new Error("Session lost before duplicate check.");
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
    handlePasteFlow
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
    const tierRaw = get('Tier', /\d+/);
    const waveRaw = get('Wave', /\d+/);
    const durationRaw = get('Real\\s*Time', /[\dhms :]+/);
    const coinsRaw = get('Coins\\s*Earned', /[\d,\.a-zA-Z$]+/);
    const cellsRaw = get('Cells\\s*Earned', /[\d,\.a-zA-Z]+/);
    const rerollShardsRaw = get('Reroll\\s*Shards\\s*Earned', /[\d,\.a-zA-Z]+/);
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
    const tier = tierRaw ? parseInt(tierRaw, 10) : 'Unknown';
    const wave = waveRaw ? parseInt(waveRaw, 10) : 'Unknown';
    const duration = durationRaw ? durationRaw.trim() : '';
    const roundDuration = formatDuration(duration);
    const totalCoins = coinsRaw || '0';
    const totalCells = cellsRaw || '0';
    const totalDice = rerollShardsRaw || '0';
    const killedBy = (killedByRaw || '').trim() || 'Apathy';

    const now = new Date();
    return {
        tier,
        wave,
        roundDuration,
        totalCoins,
        totalCells,
        totalDice,
        killedBy,
        date: formatDate(now),
        time: formatTime(now),
        notes: ''
    };
}

/**
 * Handle pasted text provided directly to /track via option, with optional screenshot.
 * Prefer text parsing and still upload screenshot for verification if provided.
 */
async function handleDirectTextPaste(interaction, text, attachmentOrNull, preNote = null) {
    const userId = interaction.user.id;
    const commandInteractionId = interaction.id;
    let session = userSessions.get(userId) || { status: 'initial', data: {}, lastActivity: Date.now() };
    session.lastActivity = Date.now();
    if (attachmentOrNull) {
        // store minimal info or the same object as direct attachment
        session.screenshotAttachment = attachmentOrNull;
    }
    userSessions.set(userId, session);

    await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Parsing pasted text...')], components: [] });

    try {
        // Debug: log raw text before parsing
        try {
            console.log(`[Paste] Raw text (${(text || '').length} chars):`, String(text || '').slice(0, 2000));
        } catch {}
        const processedData = parseRunDataFromText(text);
        if (preNote) {
            processedData.notes = preNote;
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
        session.status = 'reviewing_direct_text';
        userSessions.set(userId, session);

        // Go to review
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
    } catch (err) {
        await handleError(interaction, err, 'direct_text_paste');
    }
}

/**
 * Paste flow from main menu: prompt user to paste text; optionally allow a screenshot in same step.
 */
async function handlePasteFlow(interaction) {
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
    await interaction.showModal(modal);

    try {
        const submitted = await interaction.awaitModalSubmit({
            filter: i => i.customId === 'tracker_paste_modal' && i.user.id === userId,
            time: 300000
        });
        const text = submitted.fields.getTextInputValue('tracker_paste_text');
        const preNote = submitted.fields.getTextInputValue('tracker_paste_note') || null;
        await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Parsing pasted text...')], components: [] });
        try { console.log(`[PasteFlow] Raw text (${(text || '').length} chars):`, String(text || '').slice(0, 2000)); } catch {}
        const processedData = parseRunDataFromText(text);
        if (preNote) processedData.notes = preNote;
        try { console.log('[PasteFlow] Parsed data:', processedData); } catch {}

        const sessionForDup = userSessions.get(userId) || session;
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
        sessionForDup.status = 'reviewing_paste';
        userSessions.set(userId, sessionForDup);
        await submitted.deferUpdate();
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
    } catch (err) {
        if (String(err || '').includes('TIME')) {
            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true);
        } else {
            handleError(interaction, err, 'paste_flow_modal');
        }
    }
}