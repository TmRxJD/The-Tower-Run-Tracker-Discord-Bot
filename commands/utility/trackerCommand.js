
// filepath: d:\Projects\chad-bot\commands\utility\trackerCommand.js
const {
    SlashCommandBuilder,
    EmbedBuilder,
    Colors,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const trackerApi = require('./TrackerUtils/trackerHandlers/trackerAPI.js');
const trackerUI = require('./TrackerUtils/trackerUI/index.js');
const menuHandlers = require('./TrackerUtils/trackerHandlers/menuHandlers.js');
const { handleShareLastRun } = require('./TrackerUtils/trackerHandlers/menuHandlers.js');
const uploadHandlers = require('./TrackerUtils/trackerHandlers/uploadHandlers.js');
const manualEntryHandlers = require('./TrackerUtils/trackerHandlers/manualEntryHandlers.js');
const settingsHandlers = require('./TrackerUtils/trackerHandlers/settingsHandlers.js');
const editHandlers = require('./TrackerUtils/trackerHandlers/editHandlers.js');
const dataReviewHandlers = require('./TrackerUtils/trackerHandlers/dataReviewHandlers.js');
const shareHandlers = require('./TrackerUtils/trackerHandlers/shareHandlers.js');
const shareSettingsHandlers = require('./TrackerUtils/trackerHandlers/shareSettingsHandlers.js');
const errorHandlers = require('./TrackerUtils/trackerHandlers/errorHandlers.js');
const { userSessions, trackerEmitter } = require('./TrackerUtils/trackerHandlers/sharedState.js');
const trackerHelpers = require('./TrackerUtils/trackerHandlers/trackerHelpers.js');
const { handleViewRuns } = require('./TrackerUtils/trackerHandlers/viewLast10Handlers.js');
const shareRunsHandlers = require('./TrackerUtils/trackerHandlers/shareRunsHandlers.js');
const { getSpreadsheetLink, getSheetData } = require('./TrackerUtils/trackerHandlers/sheetHandlers.js');
// Import migration helper for initial sheet import
const { migrateUserData } = require('./TrackerUtils/trackerHandlers/migrateToNewTracker.js');
const analyticsDB = require('./TrackerUtils/analyticsDB');

// Set up session cleanup to prevent memory leaks
const SESSION_TIMEOUT = 3600000; // 1 hour in milliseconds

/**
 * Cleanup function to remove old sessions periodically
 */
function cleanupSessions() {
    const now = Date.now();
    for (const [userId, session] of userSessions.entries()) {
        if (!session.lastActivity || (now - session.lastActivity > SESSION_TIMEOUT)) {
            console.log(`Cleaning up inactive session for user ${userId}`);
            userSessions.delete(userId);
        }
    }
}

// Schedule regular cleanup
setInterval(cleanupSessions, 1800000); // Run every 30 minutes

// Keep track of active command interactions to prevent duplicate listeners
const activeInteractions = new Set();

module.exports = {
    category: 'utility',
    data: new SlashCommandBuilder()
        .setName('track')
        .setDescription('Track and analyze your Tower runs')
        .addStringOption(option =>
            option.setName('paste')
                .setDescription('Paste Battle Report text (new: Paste from Clipboard)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('note')
                .setDescription('Optional note to attach to this run')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Run Type for this entry')
                .setRequired(false)
                .addChoices(
                    { name: 'Farming', value: 'Farming' },
                    { name: 'Overnight', value: 'Overnight' },
                    { name: 'Tournament', value: 'Tournament' },
                    { name: 'Milestone', value: 'Milestone' }
                ))
        .addAttachmentOption(option => 
            option.setName('screenshot')
                .setDescription('Screenshot of your Tower run results')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('settings')
                .setDescription('Open the settings menu')
                .setRequired(false))        
        ,
        
    execute: async function(interaction) {
        const userId = interaction.user.id;
        const username = interaction.user.username; // Get username
        const commandInteractionId = interaction.id; // Unique ID for this command instance

        // Prevent duplicate executions for the same initial interaction
        if (activeInteractions.has(commandInteractionId)) {
            console.log(`[CMD] Ignoring duplicate execution for interaction ${commandInteractionId}`);
            return interaction.reply({ content: "Processing your previous request...", ephemeral: true }).catch(() => {});
        }
        activeInteractions.add(commandInteractionId);

        // Defer reply early to allow for multiple editReply calls
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch (error) {
            if (error.code === 10062) {
                console.log('Ignoring unknown interaction (likely expired)');
                return;
            }
            throw error;
        }

        // Log command usage
        analyticsDB.logCommandUsage(userId, 'track');

        // --- Central Event Listeners --- 
        // Define listener functions ONCE for this command instance
        const handleNavigate = async (destination, eventInteraction) => {
            console.log(`[Emitter] Received navigate event: ${destination} for user ${eventInteraction.user.id}`);
            try {
                // Get the original command ID from the event name
                const currentCommandId = eventInteraction.customId.startsWith('navigate_') ? 
                    eventInteraction.customId.split('_')[1] : 
                    commandInteractionId; // Fallback to the outer scope ID

                switch (destination) {
                    case 'mainMenu':
                        // Pass the original command ID
                        await menuHandlers.returnToMainMenu(eventInteraction, commandInteractionId); 
                        break;
                    case 'cancel':
                        await menuHandlers.handleCancel(eventInteraction); // Let menuHandler update the UI
                         // Since cancelled, remove interaction tracking
                         activeInteractions.delete(commandInteractionId); 
                         // Remove specific listeners for THIS command instance
                         trackerEmitter.removeListener(`navigate_${commandInteractionId}`, handleNavigate);
                         trackerEmitter.removeListener(`dispatch_${commandInteractionId}`, handleDispatch);
                        break;
                    case 'settings':
                        await settingsHandlers.handleSettingsFlow(eventInteraction, commandInteractionId);
                        break;
                }
            } catch (navError) {
                console.error(`[Emitter] Error handling navigation to ${destination}:`, navError);
                await errorHandlers.handleError(eventInteraction, navError);
            }
        };

        const handleDispatch = async (handlerName, eventInteraction, ...args) => {
            if (!eventInteraction || !eventInteraction.user) {
                console.error(`[Emitter] Invalid eventInteraction object for handler: ${handlerName}`);
                return;
            }
            console.log(`[Emitter] Received dispatch event: ${handlerName} for user ${eventInteraction.user.id}`);
            try {
                switch (handlerName) {
                    case 'uploadFlow':
                        await uploadHandlers.handleUploadFlow(eventInteraction, ...args);
                        break;
                    case 'pasteFlow':
                        await uploadHandlers.handlePasteFlow(eventInteraction, ...args);
                        break;
                    case 'manualEntryFlow':
                        await manualEntryHandlers.handleManualEntryFlow(eventInteraction, ...args);
                        break;
                    case 'settingsFlow':
                        await settingsHandlers.handleSettingsFlow(eventInteraction, ...args);
                        break;
                    case 'shareSettings':
                        await shareSettingsHandlers.handleShareSettingsFlow(eventInteraction, commandInteractionId);
                        break;
                case 'editLast': // Example
                    await menuHandlers.handleEditLast(eventInteraction, commandInteractionId, ...args);
                    break;
                case 'shareLastRun':
                    await handleShareLastRun(eventInteraction, commandInteractionId, ...args);
                    break;
                    case 'removeLast': // Example
                         await menuHandlers.handleRemoveLast(eventInteraction, ...args);
                         break;
                    case 'getLink': // Example
                         await getSpreadsheetLink(eventInteraction, ...args);
                         break;
                     case 'dataReview':
                         await dataReviewHandlers.handleDataReview(eventInteraction, ...args);
                         break;
                     case 'editCurrentRun': // Example
                        console.log('[DEBUG] trackerCommand.js received editCurrentRun event for user', eventInteraction.user.id, 'runId:', args[0]);
                         await editHandlers.handleEditCurrentRun(eventInteraction, ...args);
                         break;
                     case 'dataSubmission': // Example
                         await dataReviewHandlers.handleDataSubmission(eventInteraction, ...args);
                         break;
                    case 'handleShare':
                         await shareHandlers.handleShare(eventInteraction, ...args);
                         break;
                    case 'viewRuns':
                        await handleViewRuns(eventInteraction, commandInteractionId, ...args);
                        break;
                    case 'shareRuns':
                        console.log('[INFO] shareRuns functionality has been disabled.');
                        break;
                    case 'importUserData': {
                        // Run migration for the current user and update UI
                        const userId = eventInteraction.user.id;
                        const username = eventInteraction.user.username;
                        await eventInteraction.editReply({ content: 'Importing your previous runs. Please wait...', embeds: [], components: [] });
                        const results = await migrateUserData(userId, username, eventInteraction);
                        // Show a final report with Back to Menu and Close buttons
                        const reportEmbed = new EmbedBuilder()
                            .setTitle('Migration Complete')
                            .setDescription(`Imported: **${results.totalRunsImported}**\nDuplicates Skipped: **${results.duplicatesSkipped}**\nInternal Duplicates: **${results.internalDuplicates}**\nErrors: **${results.errors}**`)
                            .setColor(Colors.Green)
                            .setFooter({ text: 'Review your import results below.' });
                        const reportRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('tracker_import_back_to_menu')
                                .setLabel('Back to Menu')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('tracker_import_close')
                                .setLabel('Close')
                                .setStyle(ButtonStyle.Danger)
                        );
                        await eventInteraction.editReply({ embeds: [reportEmbed], components: [reportRow], content: null });
                        // Set up collector for report actions
                        const msg = await eventInteraction.fetchReply();
                        const reportCollector = msg.createMessageComponentCollector({
                            componentType: 2, // Button
                            filter: btn => btn.user.id === eventInteraction.user.id && (btn.customId === 'tracker_import_back_to_menu' || btn.customId === 'tracker_import_close'),
                            time: 300000
                        });
                        reportCollector.on('collect', async btn => {
                            reportCollector.stop();
                            await btn.deferUpdate();
                            if (btn.customId === 'tracker_import_back_to_menu') {
                                // Refresh run data and update session cache after import (settings usage)
                                const refreshed = await trackerApi.getLastRun(userId);
                                const newSettings = await trackerApi.getUserSettings(userId);
                                const session = userSessions.get(userId);
                                if (session) {
                                    session.cachedRunData = {
                                        lastRun: refreshed?.lastRun || null,
                                        allRuns: refreshed?.allRuns || [],
                                        runTypeCounts: refreshed?.runTypeCounts || {}
                                    };
                                    session.settings = { ...session.settings, ...newSettings };
                                    session.hasImported = true;
                                }
                                await menuHandlers.returnToMainMenu(btn, commandInteractionId);
                            } else {
                                // Close: end session and show cancel UI
                                await menuHandlers.handleCancel(btn);
                            }
                        });
                        break;
                    }
                    // Add cases for other handlers as needed
                    default:
                         console.warn(`[Emitter] Unknown handler dispatched: ${handlerName}`);
                }
            } catch (dispatchError) {
                console.error(`[Emitter] Error handling dispatch to ${handlerName}:`, dispatchError);
                await errorHandlers.handleError(eventInteraction, dispatchError);
            }
        };
        
        // Attach listeners specific to this command instance
        trackerEmitter.on(`navigate_${commandInteractionId}`, handleNavigate);
        console.log('[DEBUG] Attaching listener for:', `dispatch_${commandInteractionId}`);
        trackerEmitter.on(`dispatch_${commandInteractionId}`, handleDispatch);

        // Clean up listeners when the interaction might end (e.g., after timeout in handlers, or on cancel/error)
        // Note: Robust cleanup might need more thought, e.g., using interaction end events if available.
        const cleanupListeners = () => {
            console.log(`[CMD] Cleaning up listeners for interaction ${commandInteractionId}`);
            activeInteractions.delete(commandInteractionId);
            trackerEmitter.removeListener(`navigate_${commandInteractionId}`, handleNavigate);
            trackerEmitter.removeListener(`dispatch_${commandInteractionId}`, handleDispatch);
        };
        // Simple timeout based cleanup - adjust time as needed
        // setTimeout(cleanupListeners, SESSION_TIMEOUT); // Use a relevant timeout

        // --- End Listeners --- 

        try {
            const attachment = interaction.options.getAttachment('screenshot');
            const pastedText = interaction.options.getString('paste');
            const preNote = interaction.options.getString('note');
            const runType = interaction.options.getString('run_type');
            const settings = interaction.options.getBoolean('settings');
            
            if (settings) {
                await settingsHandlers.handleSettingsFlow(interaction, commandInteractionId);
                return;
            }
            
            // --- Default Settings (used if API fetch fails or user is new) ---
            const defaultSettings = { 
                autoDetectDuplicates: true,
                confirmBeforeSubmit: true,
                defaultRunType: 'farming',
                scanLanguage: 'English'
            };
            // --- End Default Settings ---

            // Initialize user session (or update timestamp)
            let session;
            if (!userSessions.has(userId)) {
                console.log(`[Session] Initializing new session for ${username} (${userId})`);
                session = {
                    status: 'initial',
                    data: {},
                    uploadType: defaultSettings.defaultRunType, 
                    startNewSheet: false,
                    screenshotAttachment: null,
                    actionLog: [],
                    lastActivity: Date.now(), 
                    cachedRunData: null, 
                    settings: { ...defaultSettings },
                    hasImported: false,
                    isDuplicateRun: false,
                    duplicateRunId: null,
                    defaultTracker: 'Web', // Default tracker type
                };
                userSessions.set(userId, session);
            } else {
                console.log(`[Session] Using existing session for ${username} (${userId})`);
                session = userSessions.get(userId);
                session.lastActivity = Date.now();
                session.settings = { ...defaultSettings, ...(session.settings || {}) }; 
                session.uploadType = session.settings.defaultRunType || defaultSettings.defaultRunType;
            }
            
            // Set run type from command
            if (runType) {
                session.uploadType = runType;
                session.runTypeFromCommand = true;
            }
            
            // ALWAYS Fetch fresh data (runs/settings)
            const userSettingsData = await trackerApi.getUserSettings(userId);

            let trackerType = userSettingsData.defaultTracker || 'Web';
            console.log(`[Tracker Type] Using ${trackerType} for user ${username} (${userId})`);

            // Apply user settings data to the session immediately after retrieval
            if (userSettingsData) {
                session.settings = { ...defaultSettings, ...userSettingsData };
                session.uploadType = session.settings.defaultRunType || defaultSettings.defaultRunType;
                session.defaultTracker = userSettingsData.defaultTracker || 'Web';
                console.log(`[Settings Applied] Updated session settings for user ${username} (${userId}):`, session.settings);
            }

            // Helper function to fetch data from the web API
            async function fetchWebData(userId, defaultSettings, userSettingsData) {
                try {
                    const initialData = await trackerApi.getLastRun(userId);
                    if (initialData) {
                        return {
                            cachedRunData: {
                                lastRun: initialData.lastRun || null,
                                allRuns: initialData.allRuns || [],
                                runTypeCounts: initialData.runTypeCounts || {},
                            },
                            settings: { ...defaultSettings, ...(userSettingsData || {}) },
                        };
                    } else {
                        console.log(`[API] No initial data found for user ${userId}, using defaults.`);
                    }
                } catch (apiError) {
                    console.error(`[API Error] Failed to fetch data for user ${userId}:`, apiError);
                }
                return {
                    cachedRunData: { lastRun: null, allRuns: [], runTypeCounts: {} },
                    settings: { ...defaultSettings, ...(userSettingsData || {}) },
                };
            }

            // Helper function to fetch data from Google Sheets
            async function fetchSheetData(username, defaultSettings) {
                const initialData = await getSheetData(username);
                if (initialData) {
                    return {
                        cachedRunData: {
                            lastRun: initialData.lastRun || null,
                            allRuns: initialData.allRuns || [],
                            runTypeCounts: initialData.runTypeCounts || {},
                        },
                        settings: { ...defaultSettings, ...(initialData.settings || {}) },
                    };
                } else {
                    console.log(`[Sheet] No initial data found for user ${username}, using defaults.`);
                }
                return {
                    cachedRunData: { lastRun: null, allRuns: [], runTypeCounts: {} },
                    settings: { ...defaultSettings },
                };
            }

            // Refactored logic for fetching data
            let dataFetchResult;
            if (trackerType === 'Web') {
                console.log(`[API] Fetching latest data for user ${username} (${userId})`);
                dataFetchResult = await fetchWebData(userId, defaultSettings, userSettingsData);
            } else {
                console.log(`[Sheet] Fetching latest data for user ${username} (${userId})`);
                dataFetchResult = await fetchSheetData(username, defaultSettings);
            }

            session.cachedRunData = dataFetchResult.cachedRunData;
            session.settings = dataFetchResult.settings;
            session.uploadType = session.settings.defaultRunType || defaultSettings.defaultRunType;

            if (runType) {
                session.uploadType = runType;
            }

            // One-time import of old runs on first use when no data is present
            if (!session.hasImported) {
                const existingRuns = session.cachedRunData?.allRuns || [];
                if (existingRuns.length === 0) {
                    // Notify user of initial import
                    await interaction.editReply({ content: 'Importing your previous runs. Please wait...', embeds: [], components: [] });
                    // Run migration helper which will update this same reply
                    await migrateUserData(userId, username, interaction);
                    // Refresh run data and update session cache after import (first use)
                    const refreshed = await trackerApi.getLastRun(userId);
                    const newSettings = await trackerApi.getUserSettings(userId);
                    session.cachedRunData = {
                        lastRun: refreshed?.lastRun || null,
                        allRuns: refreshed?.allRuns || [],
                        runTypeCounts: refreshed?.runTypeCounts || {}
                    };
                    session.settings = { ...session.settings, ...newSettings };
                }
                session.hasImported = true;
            }
            
            // Get the last run from the freshly fetched data
            const lastRun = session.cachedRunData?.lastRun;
            const runTypeCounts = session.cachedRunData?.runTypeCounts || {};
            // --- Flow Decision based on pasted text and/or attachment --- 
            if (pastedText) {
                // If both pasted text and screenshot are provided, prefer text parsing but keep screenshot for verification
                if (attachment) {
                    session.screenshotAttachment = attachment;
                }
                await uploadHandlers.handleDirectTextPaste(interaction, pastedText, attachment || null, preNote || null);
            } else if (attachment) {
                session.screenshotAttachment = attachment;
                session.status = 'processing_direct_attachment';
                await uploadHandlers.handleDirectAttachment(interaction, attachment, preNote || null);
            } else {
                // Present the main menu after import
                await menuHandlers.returnToMainMenu(interaction, commandInteractionId, runTypeCounts);
            }
        } catch (error) {
            console.error('Error in track command execute:', error);
            if (!interaction.replied && !interaction.deferred) {
                // Try to reply if possible
                 await interaction.reply({ content: 'An error occurred processing your command.', ephemeral: true }).catch(() => {});
            } else if (interaction.replied || interaction.deferred) {
                // Follow up if already replied/deferred
                 await interaction.followUp({ content: 'An error occurred processing your command.', ephemeral: true }).catch(() => {});
            }
            await errorHandlers.handleError(interaction, error);
            cleanupListeners(); // Clean up on error
        }
        // Note: Don't call cleanupListeners here, as flows are ongoing.
        // Cleanup happens on cancel, error, or potentially timeout within handlers.
    }
};