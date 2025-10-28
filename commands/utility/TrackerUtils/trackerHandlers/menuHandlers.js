// Menu and navigation handlers for the tracker
const { EmbedBuilder, Colors, ComponentType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const trackerApi = require('./trackerAPI.js');
const trackerUI = require('../trackerUI');
const { userSessions, trackerEmitter } = require('./sharedState.js'); // Get access to shared state AND emitter
const { handleError } = require('./errorHandlers.js');
const sheetHandlers = require('./sheetHandlers.js'); // Import sheet handlers
const trackerUIEmbeds = require('../trackerUI/trackerUIEmbeds');
const trackerUIButtons = require('../trackerUI/trackerUIButtons');
const shareHandlers = require('./shareHandlers');

/**
 * Returns to the main menu using the standardized UI functions.
 * NOTE: This function now ONLY prepares the UI content.
 * The actual display and listener setup is handled by the central dispatcher in trackerCommand.js
 * based on the 'navigate' event.
 */
async function returnToMainMenu(interaction, commandInteractionId) {
    try {
        const userId = interaction.user.id;
        const username = interaction.user.username; // Get username
        const session = userSessions.get(userId); 

        // --- Always fetch latest settings from backend to ensure up-to-date tracker type ---
        const settings = await trackerApi.getUserSettings(userId);
        if (settings && session) session.settings = settings;
        const trackerType = settings?.defaultTracker || session?.defaultTracker || 'Web';

        const lastRun = session?.cachedRunData?.lastRun || null;
        const runCount = session?.cachedRunData?.allRuns ? session.cachedRunData.allRuns.length : 0; // Get run count from cached data
        const runTypeCounts = session?.cachedRunData?.runTypeCounts || {};
        console.log(`[API] Returning to main menu for user ${userId} with tracker type ${trackerType}`);
        let trackerLink = 'https://the-tower-run-tracker.com/';
        if (trackerType === 'Spreadsheet') {
            trackerLink = await sheetHandlers.getSpreadsheetLink(username);
        }

        const menuEmbed = trackerUI.createInitialEmbed(lastRun, userId, runCount, runTypeCounts);
            // Always set the Share Last Run button state based on session
            let mainButtons = trackerUI.createMainMenuButtons(trackerType, trackerLink, {
                shared: !!session?.lastRunShared,
                noRuns: !!session?.noRunsToShare
            });

        await interaction.editReply({
            content: null, 
            embeds: [menuEmbed],
            components: mainButtons,
            files: [] 
        });

        // Re-attach interaction listener for the main menu buttons
        handleMainMenuInteraction(interaction, commandInteractionId); // Pass commandInteractionId

    } catch (error) {
        console.error('Error preparing main menu UI:', error);
        // Let the central error handler deal with it
        await handleError(interaction, error); 
    }
}

/**
 * Fetches the last run data for a user
 */
async function fetchLastRunData(userId, username) {
    const session = userSessions.get(userId);
    const trackerType = session?.settings?.defaultTracker || 'Web'; // Default to Web if not set
    console.log(`[API] Fetching last run data for user ${userId} with tracker type ${trackerType}`);
    try {
        console.log(`[API] Fetching last run data for user ${userId}`);

        // Updated logic to handle Spreadsheet tracker type
        if (trackerType === 'Spreadsheet') {
            const data = await sheetHandlers.getSheetData(username);
            console.log(`[GOOGLE API] Fetched spreadsheet data for user ${userId}`);
        } else {
            const data = await trackerApi.getLastRun(userId);
            console.log(`[API] Fetched run data for user ${userId}`);
        }
        // Cache the data in the user's session
        if (userSessions.has(userId)) {
            userSessions.get(userId).cachedRunData = data;
            console.log(`[CACHE] Updated cached run data for user ${userId}`);
        }
        
        return data;
    } catch (error) {
        console.error(`[API] Error fetching last run for user ${userId}:`, error);
        return null;
    }
}

/**
 * Handles setting up the main menu interaction collector.
 * It now emits events instead of calling handlers directly.
 */
async function handleMainMenuInteraction(interaction, commandInteractionId) {
    // We need the original command interaction ID to emit specific events
    // const commandInteractionId = interaction.id; // REMOVED THIS LINE

    try {
        const message = await interaction.fetchReply();
        const userId = interaction.user.id;
        const username = interaction.user.username; // Get username
        
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i => i.user.id === userId && i.customId.startsWith('tracker_'),
            time: 300000 // 5 minutes timeout
        });
        
    collector.on('collect', async i => {
        try {
            const action = i.customId.split('_')[1]; // e.g., 'upload', 'manual', 'settings'

            // Only stop the collector for actions that should end the menu
            const shouldStopCollector = [
                'addrun',
                'upload',
                'manual',
                'import',
                'removelast',
                'editlast',
                'settings',
                'cancel',
                'viewlast10',
                'viewruns'
            ].includes(action);

            switch (action) {
                case 'sharelast':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'shareLastRun', i);
                    // Do NOT stop the collector, so other buttons remain active
                    break;

                case 'addrun':
                    // Do not defer; we'll show a modal immediately
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'addRunFlow', i);
                    break;
                case 'upload':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'uploadFlow', i);
                    break;
                case 'paste':
                    // Do not defer; paste flow will show a modal as the immediate response
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'pasteFlow', i);
                    break;
                case 'manual':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'manualEntryFlow', i);
                    break;
                case 'import': {
                    await i.deferUpdate();
                    // Show import confirmation screen
                    const confirmEmbed = new EmbedBuilder()
                        .setTitle('Import Data')
                        .setDescription('You are about to import all data from your spreadsheet to the web tracker. Are you sure you want to continue?')
                        .setColor(Colors.Orange);
                    const confirmRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('tracker_import_yes')
                            .setLabel('Yes')
                            .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                            .setCustomId('tracker_import_no')
                            .setLabel('No')
                            .setStyle(ButtonStyle.Danger)
                    );
                    await i.editReply({ embeds: [confirmEmbed], components: [confirmRow] });
                    // Set up collector for Yes/No
                    const msg = await i.fetchReply();
                    const importCollector = msg.createMessageComponentCollector({
                        componentType: ComponentType.Button,
                        filter: btn => btn.user.id === i.user.id && (btn.customId === 'tracker_import_yes' || btn.customId === 'tracker_import_no'),
                        time: 60000
                    });
                    importCollector.on('collect', async btn => {
                        importCollector.stop();
                        if (btn.customId === 'tracker_import_yes') {
                            // Defer and emit event to start import (handled in trackerCommand.js)
                            await btn.deferUpdate();
                            trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'importUserData', btn);
                        } else {
                            // No: return to main menu
                            await btn.deferUpdate();
                            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', btn);
                        }
                    });
                    break;
                }
                case 'removelast':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'removeLast', i);
                    break;
                case 'editlast':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'editLast', i);
                    break;
                case 'settings':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'settingsFlow', i);
                    break;
                case 'cancel':
                    await i.deferUpdate();
                    trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', i);
                    break;
                case 'viewlast10':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'viewLast10', i);
                    break;
                case 'viewruns':
                    await i.deferUpdate();
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'viewRuns', i);
                    break;
                // Add cases for tracker_stats, tracker_recent if implemented
                default:
                    console.log(`[Menu Collector] Unknown button ID: ${i.customId}`);
                    // Maybe emit an error event or just ignore
                    break;
            }

            if (shouldStopCollector) {
                collector.stop();
            }
        } catch (error) {
            console.error('Error in main menu button interaction:', error);
            trackerEmitter.emit(`error_${commandInteractionId}`, i, error); // Emit error
        }
    });
        
        collector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                try {
                    // Session expired - Emit standard cancel event
                     trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true); // Pass original interaction and timeout flag
                    
                    // Edit the message directly to show timeout (fallback if emitter fails)
                    await message.edit({ 
                        content: "Tracker session timed out.",
                        embeds: [], 
                        components: [] 
                    }).catch(console.error); 
                } catch (error) {
                    console.error('[Menu Collector] Error handling timeout:', error);
                     trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error); // Emit error
                }
            }
            // If stopped manually, the responsible handler should update the UI.
        });
    } catch (error) {
        console.error('Error setting up main menu interaction collector:', error);
         trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error); // Emit error
    }
}

/**
 * Handles sharing the last run from the main menu.
 * Reuses the same share handler as the normal share button, but uses last run data.
 */
async function handleShareLastRun(interaction, commandInteractionId) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        const lastRun = session?.cachedRunData?.lastRun;
            if (!lastRun) {
                // Mark in session that there are no runs to share, so the button stays disabled/red on menu return
                session.noRunsToShare = true;
                userSessions.set(userId, session);
                try {
                    const message = await interaction.fetchReply();
                    const components = message.components.map(row => {
                        const newRow = row.toJSON();
                        newRow.components = newRow.components.map(btn => {
                            if (btn.custom_id === 'tracker_sharelast') {
                                return { ...btn, disabled: true, label: 'No Runs', style: 4 }; // 4 = ButtonStyle.Danger
                            }
                            return btn;
                        });
                        return new ActionRowBuilder(newRow);
                    });
                    await interaction.editReply({ components });
                } catch (e) {
                    console.warn('[ShareLastRun] Could not update main menu buttons after no runs:', e?.message);
                }
                return;
            }
            // Use the same handler as the normal share button, but pass lastRun as the data
            // Ensure runId is present for the share handler
            const prevData = session.data;
            const runId = lastRun.runId || lastRun.id;
            session.data = { ...lastRun, runId };
            session.status = 'reviewing_manual';
            // Mark last run as shared in this session
            session.lastRunShared = true;
            userSessions.set(userId, session);
            // Reuse the same share handler
            await shareHandlers.handleShare(interaction);
            // After sharing, update the main menu message to disable the Share Last Run button and show 'Shared'
            try {
                const message = await interaction.fetchReply();
                // Find the Share Last Run button and disable it, change label to 'Shared'
                const components = message.components.map(row => {
                    const newRow = row.toJSON();
                    newRow.components = newRow.components.map(btn => {
                        if (btn.custom_id === 'tracker_sharelast') {
                            return { ...btn, disabled: true, label: 'Shared' };
                        }
                        return btn;
                    });
                    return new ActionRowBuilder(newRow);
                });
                await interaction.editReply({ components });
            } catch (e) {
                console.warn('[ShareLastRun] Could not update main menu buttons after sharing:', e?.message);
            }
            // Restore previous session data if needed
            session.data = prevData;
            userSessions.set(userId, session);
    } catch (error) {
        console.error('Error sharing last run:', error);
        handleError(interaction, error);
    }
}

/**
 * Handles cancellation of the tracker
 * NOTE: This function now ONLY prepares the UI content.
 */
async function handleCancel(interaction, isTimeout = false) {
    try {
        const userId = interaction.user.id;
        const username = interaction.user.username; // Get username
        if (userSessions.has(userId)) {
            userSessions.delete(userId);
            console.log(`[Cancel] Cleared session for ${username} (${userId})`); // Add username
        }
        
        const cancelEmbed = new EmbedBuilder()
            .setTitle(isTimeout ? 'Session Expired' : 'Tracker Closed')
            .setDescription(isTimeout ? 'Your tracker session has expired due to inactivity.' : 'You have closed the tracker.')
            .setColor(Colors.Grey)
            .setURL('https://the-tower-run-tracker.com/') // Optional: Keep link?
            .setFooter({ text: `Type /track to start again.\n\nUse Creator Code "JDEVO" to Support The Tower Run Tracker!` });
            
        // Edit the reply (Interaction handled by caller/emitter listener)
        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferUpdate().catch(() => {}); 
        }
        await interaction.editReply({
            content: null,
            embeds: [cancelEmbed],
            components: [],
            files: [] // Clear any attachments
        }).catch(err => {
            // Log if editReply fails (e.g., interaction expired)
            console.log(`[Cancel] Could not update cancel UI: ${err.message}`);
        });
    } catch (error) {
        console.error('Error handling tracker cancel:', error);
        // Don't call handleError here, let the emitter chain handle it
    }
}

/**
 * Handle removing the last run
 */
async function handleRemoveLast(interaction) {
    const commandInteractionId = interaction.id;
    try {
        // await interaction.deferUpdate(); // REMOVED - Handled by caller collector
        const userId = interaction.user.id;
        const username = interaction.user.username; // Get username
        
        // ... (loading message) ...
        await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Retrieving last run...')], components: [] });
        
        const lastRunData = await fetchLastRunData(userId, username);
        
        if (!lastRunData || !lastRunData.lastRun) {
            // ... (show no runs found message) ...
             const noRunsEmbed = trackerUI.createSimpleEmbed('No Runs Found', 'You have no runs to remove.', Colors.Red);
             const backButton = trackerUI.createBackButton('tracker_main', 'Return to Main Menu');
             await interaction.editReply({ embeds: [noRunsEmbed], components: [backButton] });
             // Setup collector to go back
             const msg = await interaction.fetchReply();
             const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 60000 });
                // If last run was already shared in this session, disable the Share Last Run button
                if (session?.lastRunShared) {
                    mainButtons = mainButtons.map(row => {
                        const newRow = row.toJSON();
                        newRow.components = newRow.components.map(btn => {
                            if (btn.custom_id === 'tracker_sharelast') {
                                return { ...btn, disabled: true, label: 'Shared' };
                            }
                            return btn;
                        });
                        return new ActionRowBuilder(newRow);
                    });
                } else if (session?.noRunsToShare) {
                    // If user has no runs to share, keep the button disabled/red
                    mainButtons = mainButtons.map(row => {
                        const newRow = row.toJSON();
                        newRow.components = newRow.components.map(btn => {
                            if (btn.custom_id === 'tracker_sharelast') {
                                return { ...btn, disabled: true, label: 'No Runs', style: 4 };
                            }
                            return btn;
                        });
                        return new ActionRowBuilder(newRow);
                    });
                }
             collector.on('collect', i => { trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i); });
             return;
        }
        
        const runId = lastRunData.lastRun.runId;
        const confirmEmbed = trackerUI.createConfirmationEmbed(
            'Confirm Remove Last Run',
            `Are you sure you want to remove your last run? \nTier ${lastRunData.lastRun.tier}, Wave ${lastRunData.lastRun.wave}`
        );
        const confirmButtons = trackerUI.createConfirmCancelButtons('tracker_confirm_remove', 'tracker_cancel_remove'); // Use unique cancel ID

        await interaction.editReply({ embeds: [confirmEmbed], components: [confirmButtons] });
        
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });
        
        collector.on('collect', async i => {
            collector.stop();
            if (i.customId === 'tracker_confirm_remove') {
                await i.deferUpdate();
                 await interaction.editReply({ embeds: [trackerUI.createLoadingEmbed('Removing your last run...')], components: [] });
                try {
                    await trackerApi.deleteRun(userId, runId);
                     // ... (update cache - same logic as before) ...
                     const session = userSessions.get(userId);
                     if (session?.cachedRunData?.lastRun?.runId === runId) session.cachedRunData.lastRun = null;
                     if (session?.cachedRunData?.allRuns) session.cachedRunData.allRuns = session.cachedRunData.allRuns.filter(run => run.runId !== runId);

                     const successEmbed = trackerUI.createSimpleEmbed('Run Removed', 'Your last run has been successfully removed.', Colors.Green);
                     const backButton = trackerUI.createBackButton('tracker_main_after_remove', 'Return to Main Menu');
                     await interaction.editReply({ embeds: [successEmbed], components: [backButton] });
                     // Setup collector to go back
                     const msg = await interaction.fetchReply();
                     const successCollector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 60000 });
                     successCollector.on('collect', btn => { trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', btn); });

                } catch (apiError) {
                     console.error('API Error removing run:', apiError);
                     trackerEmitter.emit(`error_${commandInteractionId}`, i, apiError); // Emit API error
                     await interaction.editReply({ embeds: [trackerUI.createErrorEmbed(`Failed to remove run: ${apiError.message}`)], components: [] });
                }
            } else if (i.customId === 'tracker_cancel_remove') {
                 trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
            }
        });

    } catch (error) {
        console.error('Error removing last run:', error);
         trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error); // Emit error
    }
}

/**
 * Handle editing the last run (from main menu)
 */
async function handleEditLast(interaction, commandInteractionId) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        const lastRun = session?.cachedRunData?.lastRun;
        console.log('[DEBUG] handleEditLast called for user', userId, 'lastRun:', lastRun);
        if (!lastRun) {
            const noRunsEmbed = trackerUI.createSimpleEmbed('No Runs Found', 'You have no runs to edit.', Colors.Red);
            const backButton = trackerUI.createBackButton('tracker_main', 'Return to Main Menu');
            await interaction.editReply({ embeds: [noRunsEmbed], components: [backButton] });
            const msg = await interaction.fetchReply();
            const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, max: 1, time: 60000 });
            collector.on('collect', i => { trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i); });
            return;
        }
        // Prepare session for edit flow
        session.data = { ...lastRun, runId: lastRun.runId || lastRun.id };
        session.status = 'reviewing_manual';
        session.isDuplicateRun = false;
        console.log('[DEBUG] handleEditLast emitting editCurrentRun for user', userId, 'with runId', session.data.runId);
        console.log('[DEBUG] Emitting event:', `dispatch_${commandInteractionId}`);
        // Go straight to edit screen, just like review data edit
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'editCurrentRun', interaction, session.data.runId);
    } catch (error) {
        console.error('Error initiating edit last run:', error);
        trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
    }
}

module.exports = {
    returnToMainMenu,
    fetchLastRunData,
    handleMainMenuInteraction,
    handleCancel,
    handleRemoveLast,
    handleEditLast,
    handleShareLastRun
};