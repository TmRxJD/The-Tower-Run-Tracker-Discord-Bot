// Data review handlers for the tracker
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, ComponentType, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const trackerAPI = require('./trackerAPI.js');
const trackerUI = require('../trackerUI');
const { userSessions, trackerEmitter, userSettings } = require('./sharedState.js');
const { handleError } = require('./errorHandlers.js');
const { calculateHourlyRates, formatDuration } = require('./trackerHelpers.js');
const logHandlers = require('./logHandlers.js');
const sheetHandlers = require('./sheetHandlers.js');
const { run } = require('googleapis/build/src/apis/run/index.js');

/**
 * Handles reviewing submitted data before final submission
 */
async function handleDataReview(interaction) {
    try {
        const userId = interaction.user.id;
        const username = interaction.user.username;
        const commandInteractionId = interaction.message?.interaction?.id || interaction.id;
        console.log(`[DataReview] Starting for user ${username} (${userId}), commandId: ${commandInteractionId}`);
        
        if (!userSessions.has(userId)) {
            console.error('[DataReview] No active session found.');
            throw new Error('No active session found for data review. Please start again.');
        }
        
        const session = userSessions.get(userId);
        const data = session.data; 
        if (!data) {
            console.error('[DataReview] Session data missing.');
            throw new Error('Session data missing for review.');
        }

        const reviewEmbed = trackerUI.createDataReviewEmbed(data, session.status === 'reviewing_manual' ? 'Manual' : 'Extracted', session.isDuplicateRun, session.settings?.decimalPreference);
        const typeRow = trackerUI.createTypeSelectionRow(session.uploadType || session.settings?.defaultRunType || 'farming');
        const confirmButtons = trackerUI.createConfirmationButtons(); // Accept, Edit, Cancel
        const noteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('tracker_note')
                .setLabel(data?.notes && data.notes.length ? 'Edit Note' : 'Add Note')
                .setStyle(ButtonStyle.Secondary)
        );
        
        console.log('[DataReview] Editing reply to show review screen...');
        // Ensure interaction channel exists before editing
        if (!interaction.channel) {
             console.error('[DataReview] Interaction channel is missing! Cannot edit reply.');
             throw new Error('Interaction channel missing, cannot display review.');
        }
        
        await interaction.editReply({
            embeds: [reviewEmbed],
            components: [typeRow, noteRow, ...confirmButtons],
        });
        console.log('[DataReview] Reply edited successfully.');

        // If confirmBeforeSubmit is false, immediately submit as if "Accept" was pressed
        if (session.settings?.confirmBeforeSubmit === false) {
            // Fetch the reply to get the message object
            let message;
            try {
                message = await interaction.fetchReply();
            } catch (fetchError) {
                console.error('[DataReview] Failed to fetch reply for auto-submit:', fetchError);
                throw new Error('Could not fetch reply message for auto-submit.');
            }
            // Create a synthetic MessageComponentInteraction-like object
            const syntheticInteraction = {
                ...interaction,
                customId: 'tracker_accept',
                message,
                update: async (options) => interaction.editReply(options),
                editReply: async (options) => interaction.editReply(options),
                fetchReply: async () => interaction.fetchReply(),
                isMessageComponent: () => true,
                client: interaction.client, // Ensure client is present for downstream logging
            };
            // Immediately submit as if user pressed Accept
            await handleDataSubmission(syntheticInteraction);
            return;
        }

        // --- Collector Setup ---
        let message;
        try {
            console.log('[DataReview] Fetching reply to attach collector...');
            message = await interaction.fetchReply();
            console.log(`[DataReview] Fetched reply with ID: ${message.id}`);
        } catch (fetchError) {
            console.error('[DataReview] Failed to fetch reply:', fetchError);
            throw new Error('Could not fetch reply message to attach buttons.');
        }

        console.log('[DataReview] Setting up component collector...');
        const componentCollector = message.createMessageComponentCollector({
            filter: i => [
                'tracker_type_select',
                'tracker_accept',
                'tracker_edit',
                'tracker_cancel',
                'tracker_note'
            ].includes(i.customId) && i.user.id === userId,
            time: 300000 // 5 minutes
        });
        
    // Note entry via modal only — no text message collector
        
        componentCollector.on('collect', async i => {
            console.log(`[DataReview Component Collector] Collected interaction: ${i.customId}`);
            // No message collector to stop
            try {
                // Keep collector active for type select and note modal
                if (i.customId !== 'tracker_type_select' && i.customId !== 'tracker_note') {
                     console.log(`[DataReview Component Collector] Stopping component collector for action: ${i.customId}`);
                     componentCollector.stop(i.customId);
                 } else {
                     console.log(`[DataReview Component Collector] Handling type select, component collector remains active.`);
                 }
                
                // Acknowledgment handled by subsequent handler's update/reply/defer
                
                if (i.customId === 'tracker_type_select') {
                    console.log('[DataReview Component Collector] Processing type select...');
                    session.uploadType = i.values[0];
                    session.data.type = i.values[0]; 
                    userSessions.set(userId, session); 
                    await i.deferUpdate(); // Defer here because we re-render the SAME view
                    console.log('[DataReview Component Collector] Emitting dataReview dispatch for type update...');
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction); 
                    return;
                } else if (i.customId === 'tracker_note') {
                    // Open modal to collect/edit note
                    const currentNote = (session.data?.notes || '').toString();
                    const modal = new ModalBuilder().setCustomId('tracker_note_modal').setTitle('Add/Edit Note');
                    const input = new TextInputBuilder()
                        .setCustomId('tracker_note_text')
                        .setLabel('Note')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false);
                    if (currentNote) input.setValue(currentNote.slice(0, 1024));
                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    await i.showModal(modal);
                    try {
                        const submitted = await i.awaitModalSubmit({
                            filter: m => m.customId === 'tracker_note_modal' && m.user.id === userId,
                            time: 300000
                        });
                        const note = submitted.fields.getTextInputValue('tracker_note_text') || '';
                        const currentSession = userSessions.get(userId);
                        if (currentSession) {
                            currentSession.data.notes = note.trim();
                            userSessions.set(userId, currentSession);
                        }
                        const updatedEmbed = trackerUI.createDataReviewEmbed(
                            currentSession.data,
                            currentSession.status === 'reviewing_manual' ? 'Manual' : 'Extracted',
                            currentSession.isDuplicateRun,
                            currentSession.settings?.decimalPreference
                        );
                        await submitted.deferUpdate();
                        await interaction.editReply({ embeds: [updatedEmbed] });
                    } catch (modalErr) {
                        if (String(modalErr || '').includes('TIME')) {
                            // Ignore; user closed modal or timeout
                        } else {
                            console.error('[DataReview] Note modal error:', modalErr);
                            interaction.followUp({ content: 'Error updating note.', ephemeral: true }).catch(()=>{});
                        }
                    }
                    return;
                }
                
                console.log(`[DataReview Component Collector] Emitting event for: ${i.customId}`);
                if (i.customId === 'tracker_accept') {
                     trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataSubmission', i);
                } else if (i.customId === 'tracker_edit') {
                     trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'editCurrentRun', i, session.data); 
                } else if (i.customId === 'tracker_cancel') {
                     trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', i);
                }
            } catch (error) {
                console.error('[DataReview Component Collector] Error during collect:', error);
                 trackerEmitter.emit(`error_${commandInteractionId}`, i, error);
            }
        });
        
    componentCollector.on('end', (collected, reason) => {
             console.log(`[DataReview Component Collector] Collector ended. Reason: ${reason}. Collected size: ${collected.size}`);

             // Only emit timeout cancel if the reason is explicitly 'time'
             if (reason === 'time') {
                 console.log('[DataReview] Component collector timed out. Emitting cancel event.');
                 trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true); 
             } else if (reason !== 'messageDelete' && !collected.size && reason !== 'button_interaction') {
                 console.log(`[DataReview Component Collector] Collector ended for reason '${reason}' without collecting anything.`);
             }
        });
        
        console.log('[DataReview] Collector setup complete.');
        
    } catch (error) {
        console.error('Error showing data review:', error);
        // Get commandInteractionId safely if possible
        const commandInteractionId = interaction?.message?.interaction?.id || interaction?.id;
        if(commandInteractionId) {
             trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
        } else {
             // Fallback if interaction is completely invalid
             // Maybe log differently or attempt a generic user message if possible?
             console.error('[DataReview] Cannot emit error event, interaction invalid.');
        }
    }
}

/**
 * Handles the final data submission
 */
async function handleDataSubmission(interaction) {
    console.log(`[DataSubmission] Received interaction: ${interaction.id}, Type: ${interaction.type}`);
    console.log(`[DataSubmission] Interaction State: Defer: ${interaction.deferred}, Replied: ${interaction.replied}, Editable: ${interaction.editable}`);
    const commandInteractionId = interaction.message?.interaction?.id || interaction.id;
    console.log('[DEBUG] Initial userSessions:', userSessions);

    try {
        const userId = interaction.user.id;
        const username = interaction.user.username;
        const session = userSessions.get(userId);

        if (!session || !session.data) {
            throw new Error('Session or run data missing for submission.');
        }

        // Always use .update (synthetic or real MessageComponentInteraction)
        await interaction.update({
            embeds: [trackerUI.createLoadingEmbed('Processing submission...')],
            components: [],
        });

        const apiData = session.data;

        try {
            let result;
            let runId;
            let isUpdate = false;

            const finalRunCount = session.cachedRunData?.allRuns?.length || 0;

            if (session.editingRunId) {
                console.log(`[DataSubmission] Performing update for existing run ID: ${session.editingRunId}`);
                apiData.runId = session.editingRunId;
                isUpdate = true;
            } else {
                console.log('[DataSubmission] Performing log for potentially new run.');
                isUpdate = false;
            }

            apiData.type = apiData.type
                ? apiData.type.charAt(0).toUpperCase() + apiData.type.slice(1)
                : 'Farming';

            apiData.settings = userSettings.get(userId) || {};
            const trackerType = session.defaultTracker || 'Web';
            console.log(`[DataSubmission] Tracker type: ${trackerType}`);

            // Prepare screenshot buffer and name if available
            let screenshotBuffer = null;
            let screenshotName = null;
            if (session.screenshotAttachment && session.screenshotAttachment.url) {
                try {
                    // Download the image from the URL
                    const axios = require('axios');
                    const response = await axios.get(session.screenshotAttachment.url, { responseType: 'arraybuffer' });
                    screenshotBuffer = Buffer.from(response.data);
                    screenshotName = session.screenshotAttachment.name || 'screenshot.png';
                } catch (err) {
                    console.warn('[DataSubmission] Could not fetch screenshot for upload:', err.message);
                }
            }

            if (isUpdate) {
                if (trackerType === 'Spreadsheet') {
                    await sheetHandlers.updateRunInSheet(username, apiData);
                } else {
                    if (!apiData.runId) throw new Error('Cannot update run - missing run ID');
                    console.log(`[SUBMIT] Updating run ${apiData.runId}`);
                    result = await trackerAPI.editRun(userId, username, apiData, {}, screenshotBuffer, screenshotName);
                    runId = apiData.runId;
                }
            } else {
                delete apiData.runId;
                console.log(`[SUBMIT] Logging new run`);

                if (trackerType === 'Spreadsheet') {
                    await sheetHandlers.setupSheetsAndLogData(interaction, apiData);
                } else {
                    result = await trackerAPI.logRun(userId, username, apiData, {}, screenshotBuffer, screenshotName);
                    runId = result?.runId;
                    if (!runId) throw new Error('Failed to get runId after logging run.');
                    console.log(`[SUBMIT] New run logged. ID: ${runId}`);
                }

                const newRunEntry = { ...apiData, id: runId, runId: runId, timestamp: new Date().toISOString() };
                if (session?.cachedRunData) {
                    const data = await trackerAPI.getLastRun(userId);
                    session.cachedRunData.allRuns = data?.allRuns || session.cachedRunData.allRuns;
                    session.cachedRunData.lastRun = data?.lastRun || session.cachedRunData.lastRun;
                    session.cachedRunData.runTypeCounts = data?.runTypeCounts || session.cachedRunData.runTypeCounts;
                    console.log(`[SUBMIT] Updated cachedRunData.allRuns (new count: ${session.cachedRunData.allRuns.length}) and lastRun.`);
                }
            }

            if (isUpdate && session?.cachedRunData?.allRuns) {
                const runIndex = session.cachedRunData.allRuns.findIndex(r => r.id === runId || r.runId === runId);
                if (runIndex !== -1) {
                    session.cachedRunData.allRuns[runIndex] = {
                        ...session.cachedRunData.allRuns[runIndex],
                        ...apiData,
                        id: runId,
                        runId: runId
                    };
                    console.log(`[SUBMIT] Updated run entry in cachedRunData.allRuns at index ${runIndex}.`);

                    if (session.cachedRunData.lastRun?.id === runId || session.cachedRunData.lastRun?.runId === runId) {
                        session.cachedRunData.lastRun = session.cachedRunData.allRuns[runIndex];
                        console.log('[SUBMIT] Updated cachedRunData.lastRun after edit.');
                    }
                } else {
                    console.warn(`[SUBMIT] Could not find run ${runId} in cache to update after edit.`);
                }
            }

            if (session) {
                session.editingRunId = null;
                console.log('[DataSubmission] Cleared session.editingRunId');
            }

            session.data.runId = runId;
            session.data.lastUpdated = new Date().toISOString();
            session.uploadType = session.settings?.defaultRunType || 'Farming';
            console.log(`[DataSubmission] Updated session data:`, session.data);

            userSessions.set(userId, session);
            console.log(`[DataSubmission] Session saved for user ${userId}.`);

            // --- Get latest run count AFTER potential add/update ---
            const currentRunCount = session.cachedRunData?.allRuns?.length || 0; 
            console.log(`[SUBMIT] Current run count for success buttons: ${currentRunCount}`);
            // --- End Get latest run count ---
            
            userSessions.set(userId, session); // Save updated session (including cache)
            
            // --- Determine tracker type and link for button ---
            let trackerLink = 'https://the-tower-run-tracker.com/';

            if (trackerType === 'Spreadsheet') {
                trackerLink = await sheetHandlers.getSpreadsheetLink(username);
                console.log(`[SUBMIT] Spreadsheet link: ${trackerLink} for user ${username}`);
            }
            // --- End tracker type/link logic ---
            
            // --- Log Successful Run --- 
            // Call the log function *after* DB update and cache update
            // Pass the interaction, the final apiData (which includes runId), the updated count, and attachment info
            
            console.log(`Tracker Type: ${trackerType}, Tracker Link: ${trackerLink}`);

            
            // --- End Log Successful Run ---            
            
            // Save runId to session for edit last
            session.lastRunId = runId;
            userSessions.set(userId, session);
            
            const stats = calculateHourlyRates(apiData.duration || apiData.roundDuration, apiData);
            const hasScreenshot = !!session.screenshotAttachment;
            // Get runTypeCounts from session cache if available
            const runTypeCounts = session?.cachedRunData?.runTypeCounts || {};
            // Pass runTypeCounts to logSuccessfulRun for accurate embed
            await logHandlers.logSuccessfulRun(interaction, apiData, currentRunCount, trackerLink, session.screenshotAttachment, runTypeCounts);

            const finalEmbed = trackerUI.createFinalEmbed(apiData, stats, hasScreenshot, isUpdate, runTypeCounts);
            // Use the UPDATED count for buttons
            const buttons = trackerUI.createSuccessButtons(username, runId, currentRunCount, trackerType, trackerLink); 
            
            const replyOptions = { content: null, embeds: [finalEmbed], components: buttons };
            if (hasScreenshot && session.screenshotAttachment) {
                 replyOptions.files = [{ attachment: session.screenshotAttachment.url, name: 'screenshot.png' }];
            }
            
            await interaction.editReply(replyOptions);

            // --- Success Screen Button Collector ---
            try {
                const message = await interaction.fetchReply();
                const originalCommandId = interaction.message?.interaction?.id || interaction.id;
                const collector = message.createMessageComponentCollector({
                    componentType: ComponentType.Button,
                    filter: i => i.user.id === userId && i.customId.startsWith('tracker_'),
                    time: 300000
                });
                collector.on('collect', async i => {
                    if (i.customId === 'tracker_editlast') {
                        collector.stop('editlast');
                        const runId = session.lastRunId || session.data?.runId;
                        trackerEmitter.emit(`dispatch_${originalCommandId}`, 'editCurrentRun', i, runId);
                    } else if (i.customId === 'tracker_upload_another') {
                        await i.deferUpdate();
                        collector.stop('upload_another');
                        trackerEmitter.emit(`dispatch_${originalCommandId}`, 'uploadFlow', i);
                    } else if (i.customId === 'tracker_main_menu') {                        
                        await i.deferUpdate();
                        collector.stop('main_menu');
                        trackerEmitter.emit(`navigate_${originalCommandId}`, 'mainMenu', i);
                    } else if (i.customId === 'tracker_cancel') {
                        await i.deferUpdate();
                        collector.stop('cancel');
                        trackerEmitter.emit(`navigate_${originalCommandId}`, 'cancel', i);
                    } else if (i.customId === 'tracker_share') {
                        await i.deferUpdate();
                        // Disable the Share button on the original message to prevent double sharing
                        try {
                            const updatedButtons = trackerUI.createSuccessButtons(username, runId, currentRunCount, trackerType, trackerLink);
                            if (updatedButtons && updatedButtons[0] && updatedButtons[0].components && updatedButtons[0].components[0]) {
                                // First button is Share
                                updatedButtons[0].components[0].setDisabled(true);
                            }
                            await interaction.editReply({ components: updatedButtons });
                        } catch (e) {
                            console.warn('[Success Screen] Unable to disable share button:', e?.message);
                        }
                        // Keep collector active so other buttons continue to work after sharing
                        trackerEmitter.emit(`dispatch_${originalCommandId}`, 'handleShare', i, runTypeCounts);
                    }
                });
                collector.on('end', (collected, reason) => {
                    if (reason === 'time') {
                        interaction.editReply({ components: [] }).catch(() => {});
                    }
                });
            } catch (collectorError) {
                console.error('[Success Screen] Failed to set up button collector:', collectorError);
            }
            // --- End Success Screen Button Collector ---
            
            // TODO: Decide how to handle other buttons ('track_another').
            // The Share button is handled by the success screen collector above.

        } catch (dbError) {
            console.error('Error submitting data to API/DB:', dbError);
             trackerEmitter.emit(`error_${commandInteractionId}`, interaction, dbError); // Emit error
            // Show error with buttons to retry/edit/menu
            const errorEmbed = trackerUI.createErrorEmbed(`Failed to log run data: ${dbError.message}`);
            // Pass retryId to error recovery buttons
            const errorButtons = createErrorRecoveryButtons('submit_error_edit', 'submit_error_main', 'tracker_retry_submit'); 
             await interaction.editReply({ content:null, embeds: [errorEmbed], components: errorButtons, files:[] });
             
             // Setup collector for error recovery
            try {
                 const errorMessage = await interaction.fetchReply();
                 const errorCollector = errorMessage.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 300000 });
            
                 errorCollector.on('collect', async i => {
                     await i.deferUpdate(); // Defer the recovery button click
                     if (i.customId === 'tracker_retry_submit') {
                         console.log('[Error Recovery] Retrying submission...');
                         trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataSubmission', i); // Pass the button interaction 'i'
                     } else if (i.customId === 'submit_error_edit') {
                         console.log('[Error Recovery] Editing before submit...');
                         trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'editCurrentRun', i, session.data); // Re-edit current data
                     } else if (i.customId === 'submit_error_main') {
                         console.log('[Error Recovery] Returning to main menu...');
                         trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
                     }
                 });
             } catch (collectorError) {
                 console.error('[DataSubmission] Failed to set up error recovery collector:', collectorError);
             }
        }
        
    } catch (error) { // Outer catch for initial update/session errors
        console.error('Error in handleDataSubmission wrapper:', error);
         trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
    } finally {
        console.log('Finalizing data submission handling.');
    }
}

async function handleDataEdit(interaction) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        // Use the review embed to persist extracted data
        const reviewEmbed = trackerUI.createDataReviewEmbed(
            session.data,
            session.status === 'reviewing_manual' ? 'Manual' : 'Extracted',
            session.isDuplicateRun,
            session.settings?.decimalPreference
        );
        // Prepare reply options
        let replyOptions = {
            embeds: [reviewEmbed],
            components: [
                trackerUI.createFieldSelectionRow(session.data),
                trackerUI.createNavigationButtons()
            ]
        };
        // Only show screenshot if present and we're on the field selection screen
        if (session.screenshotAttachment && session.screenshotAttachment.url) {
            reviewEmbed.setImage('attachment://screenshot.png');
            replyOptions.files = [{
                attachment: session.screenshotAttachment.url,
                name: 'screenshot.png'
            }];
        }
        // Use the appropriate method based on the interaction state
        if (interaction.isMessageComponent()) {
            await interaction.update(replyOptions);
        } else {
            await interaction.editReply(replyOptions);
        }
        // Set up the collector for field selection as before
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            time: 300000 // 5 minutes
        });
        collector.on('collect', async i => {
            try {
                if (i.customId === 'tracker_field_select') {
                    collector.stop();
                    await handleFieldEdit(i, i.values);
                } else if (i.customId === 'tracker_back') {
                    collector.stop();
                    await handleDataReview(i);
                } else if (i.customId === 'tracker_cancel') {
                    collector.stop();
                    await handleDataReview(i);
                }
            } catch (error) {
                console.error('Error in field selection interaction:', error);
                await handleError(i, error);
            }
        });
    } catch (error) {
        console.error('Error handling data edit:', error);
        await handleError(interaction, error);
    }
} // Close handleDataEdit function

async function handleDataEdit(interaction) {
    try {
        // Logic for handling data edit
    } catch (error) {
        console.error('Error in handleDataEdit:', error);
    }
} // Close handleDataEdit function

const createErrorRecoveryButtons = (editId, mainId, retryId) => {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(editId).setLabel('Edit').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(mainId).setLabel('Main Menu').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(retryId).setLabel('Retry').setStyle(ButtonStyle.Danger)
        )
    ];
};

module.exports = {
    handleDataReview,
    handleDataSubmission,
    handleDataEdit
};