// Handlers for manual data entry flow
const { EmbedBuilder, Colors, ComponentType } = require('discord.js');
const trackerUI = require('../trackerUI'); // Path to UI functions
const { userSessions, trackerEmitter } = require('./sharedState.js'); // Shared state - Changed require path
const { handleError } = require('./errorHandlers.js');
const { standardizeNotation, toTitleCase, formatDate, formatTime, findPotentialDuplicateRun } = require('./trackerHelpers.js');

const MANUAL_FIELDS_TO_COLLECT = [
    'Run Type',
    'Tier', 'Wave', 'Duration', 'Coins', 'Cells', 'Dice', 
    'Killed By', 'Date', 'Time', 'Notes'
];

/**
 * Initializes the manual entry flow.
 * @param {Interaction} interaction - The interaction object.
 */
async function handleManualEntryFlow(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username; // Get username
    const commandInteractionId = interaction.message.interaction.id;
    console.log(`[Manual Entry] Starting flow for user ${username} (${userId})`); // Add username
    try {
        // REMOVED deferUpdate, handled by caller collector
        // if (!interaction.deferred) await interaction.deferUpdate().catch(() => {});
        
        // Ensure session exists
        let session = userSessions.get(userId);
        if (!session) {
             console.warn(`[Manual Entry] Session not found for ${username} (${userId}), creating.`);
             session = { data: {}, manualData: {}, settings: {}, lastActivity: Date.now() };
             userSessions.set(userId, session);
        }
        
        session.status = 'manual_entry';
        session.lastActivity = Date.now();
        session.manualFields = [...MANUAL_FIELDS_TO_COLLECT];
        session.currentField = 0;
        session.manualData = {}; // Reset data
        userSessions.set(userId, session); // Save initialized session

        console.log(`[Manual Entry] Starting flow for user ${username} (${userId})`);
        // Call internal function to show the first field
        await showNextManualField(interaction, commandInteractionId);

    } catch (error) {
        console.error('Error starting manual entry:', error);
        trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
    }
}

/**
 * Shows the prompt for the next field in the manual entry sequence.
 * @param {Interaction} interaction - The interaction object.
 * @param {string} commandInteractionId - The ID of the command interaction.
 */
async function showNextManualField(interaction, commandInteractionId) {
    const userId = interaction.user.id;
    const username = interaction.user.username; // Get username
    const session = userSessions.get(userId);

    if (!session || session.status !== 'manual_entry' || session.currentField >= session.manualFields.length) {
        console.log(`[Manual Entry] Invalid state or flow finished for user ${username} (${userId}). Status: ${session?.status}, Field: ${session?.currentField}`); // Add username
        trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', interaction);
        return; 
    }

    const currentField = session.manualFields[session.currentField];
    console.log(`[Manual Entry] Prompting for field: ${currentField} (${session.currentField + 1}/${session.manualFields.length})`);

    try {
        // Need to use editReply as interaction was deferred in handleManualEntryFlow
        const fieldEmbed = trackerUI.createManualEntryEmbed(currentField, session.manualFields);
        const navButtons = trackerUI.createNavigationButtons('tracker_manual_back', 'tracker_cancel');
        
        let components = [navButtons];
        let expectMessageInput = true;

        // --- Special Handling for Run Type --- 
        if (currentField === 'Run Type') {
            expectMessageInput = false; // Don't wait for text input
            const defaultType = session.settings?.defaultRunType || 'farming';
            const typeRow = trackerUI.createTypeSelectionRow(defaultType); // Get the dropdown
            components = [typeRow, navButtons]; // Add dropdown before nav buttons
            fieldEmbed.setDescription('Select the **Run Type**:'); // Update description
        }
        // --- End Special Handling ---

        await interaction.editReply({
            embeds: [fieldEmbed],
            components: components // Use the potentially modified components array
        });

        const message = await interaction.fetchReply();
        const channel = interaction.channel;
        let collectedInput = false;

        // --- Modal-based input (replaces message collector) ---
        if (expectMessageInput) {
            // Store commandInteractionId so modal submit handler can continue the flow
            session.commandInteractionId = commandInteractionId;
            userSessions.set(userId, session);
            const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
            const modal = new ModalBuilder()
                .setCustomId(`tracker_manual_modal:${currentField}`)
                .setTitle(`Enter ${currentField}`);
            const input = new TextInputBuilder()
                .setCustomId('tracker_input')
                .setLabel(`Value for ${currentField}`)
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            // Flow will continue in handleManualModalSubmit
            return;
        }

        // --- Component Collector (Handles Buttons AND Select Menus) ---
        const componentFilter = i => i.user.id === userId && (['tracker_manual_back', 'tracker_cancel', 'tracker_type_select'].includes(i.customId));
        const componentCollector = message.createMessageComponentCollector({
             filter: componentFilter,
             // componentType: ComponentType.Button, // REMOVE: Listen for both
             max: 1, 
             time: 300000 
        });

        componentCollector.on('collect', async i => {
             if (collectedInput) return;
             collectedInput = true;
             if (messageCollector) messageCollector.stop(); // Stop message collector if component interaction happens

             if (i.isSelectMenu() && i.customId === 'tracker_type_select') {
                console.log(`[Manual Entry] Received Run Type selection: ${i.values[0]}`);
                session.manualData.type = i.values[0]; // Store selected type (already capitalized from dropdown value)
                session.currentField++;
                userSessions.set(userId, session); // Save session
                await i.deferUpdate().catch(()=>{});
                await checkManualEntryCompletion(interaction, commandInteractionId, session); // Check completion *after* processing selection
             } else if (i.isButton()) {
                 if (i.customId === 'tracker_manual_back') {
                     console.log('[Manual Entry] Back button pressed.');
                     if (session.currentField > 0) {
                         session.currentField--;
                         userSessions.set(userId, session); // Save state change
                         await i.deferUpdate().catch(()=>{});
                         await showNextManualField(interaction, commandInteractionId); 
                     } else {
                         // At the first field, back goes to main menu
                         trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
                     }
                 } else if (i.customId === 'tracker_cancel') {
                     console.log('[Manual Entry] Cancel button pressed.');
                     trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', i);
                 }
             }
        });

        // Handle timeout for both collectors
        const onEnd = (collected, reason) => {
            if (!collectedInput && reason === 'time') {
                console.log(`[Manual Entry] Timeout for field ${currentField}.`);
                trackerEmitter.emit(`navigate_${commandInteractionId}`, 'cancel', interaction, true); // Emit timeout cancel
            }
        };
        if (messageCollector) messageCollector.on('end', onEnd);
        componentCollector.on('end', (collected, reason) => { if (collected.size === 0) onEnd(collected, reason); });

    } catch (error) {
        console.error(`Error showing manual entry field ${session?.manualFields[session?.currentField]}:`, error);
        trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
    }
}

/**
 * Internal helper to check if manual entry is complete and proceed.
 * @param {Interaction} interaction - The interaction object.
 * @param {string} commandInteractionId - The ID of the command interaction.
 */
async function checkManualEntryCompletion(interaction, commandInteractionId, session) {
    if (session.currentField >= session.manualFields.length) {
        // --- All fields collected --- 
        console.log(`[Manual Entry] All fields collected for user ${session.username || interaction.user.username} (${session.userId || interaction.user.id})`);
        session.data = { ...session.manualData };
        
        // Only check for duplicates if user setting is enabled
        if (session.settings?.autoDetectDuplicates !== false) {
            console.log('[Manual Entry] Checking for potential duplicates...');
            const existingRuns = session.cachedRunData?.allRuns || [];
            const duplicateResult = findPotentialDuplicateRun(session.data, existingRuns);
            if (duplicateResult.isDuplicate) {
                console.log(`[Manual Entry] Duplicate found! Setting editingRunId to ${duplicateResult.duplicateRunId}`);
                session.isDuplicateRun = true;
                session.editingRunId = duplicateResult.duplicateRunId;
            } else {
                console.log('[Manual Entry] No duplicate found.');
                session.isDuplicateRun = false;
                session.editingRunId = null;
            }
        } else {
            // Skip duplicate check if disabled in settings
            console.log('[Manual Entry] Duplicate check skipped due to user settings.');
            session.isDuplicateRun = false;
            session.editingRunId = null;
        }
        // ---> END Duplicate Check Logic <---
        
        session.status = 'reviewing_manual';
        const defaultType = session.settings?.defaultRunType || 'Farming';
        session.data.type = session.data.type || defaultType;
        session.uploadType = session.data.type;
        userSessions.set(interaction.user.id, session); // Save final state before dispatch

        // Always emit dataReview; handleDataReview will auto-submit if confirmBeforeSubmit is false
        console.log('[Manual Entry] Emitting dataReview dispatch.');
        trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'dataReview', interaction);
    } else {
        // --- More fields to collect ---
        await showNextManualField(interaction, commandInteractionId);
    }
}

module.exports = {
    handleManualEntryFlow,
    // Modal submit handler (called from central interaction router)
    async handleManualModalSubmit(interaction, field) {
        try {
            const userId = interaction.user.id;
            const session = userSessions.get(userId);
            if (!session) {
                await interaction.reply({ content: 'Session expired or not found. Please start manual entry again.', ephemeral: true });
                return;
            }
            const value = interaction.fields.getTextInputValue('tracker_input')?.trim();
            const fieldKey = field.toLowerCase().replace(/ /g, '');
            const decimalPreference = session.settings?.decimalPreference || 'Period (.)';
            if (['coins', 'cells', 'dice'].includes(fieldKey)) {
                session.manualData[`total${fieldKey.charAt(0).toUpperCase() + fieldKey.slice(1)}`] = standardizeNotation(value, decimalPreference);
            } else if (fieldKey === 'killedby') {
                session.manualData.killedBy = toTitleCase(value);
            } else if (fieldKey === 'duration') {
                session.manualData.roundDuration = value;
            } else if (fieldKey === 'date') {
                session.manualData.date = value;
            } else if (fieldKey === 'time') {
                session.manualData.time = value;
            } else if (fieldKey === 'notes' && value.toLowerCase() === 'n/a') {
                session.manualData.notes = '';
            } else if (fieldKey !== 'runtype') {
                session.manualData[fieldKey] = value;
            }
            userSessions.set(userId, session);
            await interaction.reply({ content: `Recorded ${field}.`, ephemeral: true });
            // Continue the flow
            const cmdId = session.commandInteractionId || null;
            await checkManualEntryCompletion(interaction, cmdId, session);
        } catch (err) {
            console.error('Error in handleManualModalSubmit:', err);
            try { await interaction.reply({ content: 'Failed to process input.', ephemeral: true }); } catch(e){}
        }
    }
}; 