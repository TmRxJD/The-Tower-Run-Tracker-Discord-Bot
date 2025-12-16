// Edit handlers for modifying data in the tracker
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { ComponentType } = require('discord.js');
const { Colors } = require('discord.js');
const trackerUI = require('../trackerUI');
const dataReviewHandlers = require('./dataReviewHandlers');
const { standardizeNotation, toTitleCase } = require('./trackerHelpers.js');

// Get access to shared state
const { userSessions } = require('./sharedState.js');
const { handleError } = require('./errorHandlers.js');
const { handleDataReview, handleDataSubmission } = require('./dataReviewHandlers.js');

/**
 * Handles the edit current run flow
 */
async function handleEditCurrentRun(interaction, runId) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        console.log('[DEBUG] handleEditCurrentRun called for user', userId, 'runId:', runId, 'session.data:', session?.data);

        if (!session || !session.data) {
            throw new Error('No session data found to edit');
        }

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
        // Show screenshot in the embed (bottom) for field selection
        if (session.screenshotAttachment && session.screenshotAttachment.url) {
            reviewEmbed.setImage('attachment://screenshot.png');
            replyOptions.files = [{
                attachment: session.screenshotAttachment.url,
                name: 'screenshot.png'
            }];
        }

        // Ensure the interaction is deferred or replied before editReply
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferUpdate();
        }
        console.log('[DEBUG] About to call interaction.editReply in handleEditCurrentRun. Interaction state:', {
            replied: interaction.replied,
            deferred: interaction.deferred,
            id: interaction.id
        });
        await interaction.editReply(replyOptions);

        // Setup collector for edit field selection
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            time: 300000 // 5 minutes
        });

        collector.on('collect', async i => {
            try {
                if (i.customId === 'tracker_edit_field' || i.customId === 'tracker_field_select') {
                    collector.stop();
                    await handleFieldEdit(i, i.values); // Use the old, working flow
                } else if (i.customId === 'tracker_return_review' || i.customId === 'tracker_back' || i.customId === 'tracker_cancel') {
                    collector.stop();
                    // Directly update the interaction to show the review screen with data (NO screenshot)
                    const reviewEmbed = trackerUI.createDataReviewEmbed(
                        session.data,
                        session.status === 'reviewing_manual' ? 'Manual' : 'Extracted',
                        session.isDuplicateRun,
                        session.settings?.decimalPreference
                    );
                    let replyOptions = {
                        embeds: [reviewEmbed],
                        components: [
                            trackerUI.createTypeSelectionRow(session.uploadType || session.settings?.defaultRunType || 'farming'),
                            ...trackerUI.createConfirmationButtons()
                        ]
                    };
                    // Do NOT include screenshot on review/cancel screens
                    await i.update(replyOptions);
                }
            } catch (error) {
                console.error('Error handling edit selection:', error);
                await handleError(i, error);
            }
        });
    } catch (error) {
        console.error('Error starting edit process:', error);
        await handleError(interaction, error);
    }
}

/**
 * Handles editing the data (copied from track_run_old.js, adapted for new structure)
 */
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

        // Only show screenshot if present and we're on the field selection screen
        let replyOptions = {
            embeds: [reviewEmbed],
            components: [
                trackerUI.createFieldSelectionRow(session.data),
                trackerUI.createNavigationButtons()
            ]
        };
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
}

/**
 * Handles the field edit flow after fields are selected (copied from track_run_old.js)
 */
async function handleFieldEdit(interaction, fields) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        session.originalData = { ...session.data };
        session.fieldsToEdit = fields;
        session.currentEditField = 0;
        session.status = 'editing_fields';
        await interaction.deferUpdate();
        await interaction.editReply({
            content: 'Starting edit mode...',
            embeds: [],
            components: []
        });
        await setupEditFieldFlow(interaction);
    } catch (error) {
        console.error('Error handling field edit:', error);
        await handleError(interaction, error);
    }
}

/**
 * Sets up the sequential edit field flow (copied from track_run_old.js)
 */
async function setupEditFieldFlow(interaction) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        const channel = interaction.channel;
        if (session.currentEditField >= session.fieldsToEdit.length) {
            await handleEditFieldsComplete(interaction);
            return;
        }
        const fieldKey = session.fieldsToEdit[session.currentEditField];
        await updateEditFieldPrompt(interaction);
        // Use modal for field input instead of message collector
        session.currentlyEditingField = fieldKey;
        userSessions.set(userId, session);
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        const modal = new ModalBuilder()
            .setCustomId(`tracker_edit_modal:${fieldKey}`)
            .setTitle(`Edit ${getDisplayFieldName(fieldKey)}`);
        const input = new TextInputBuilder()
            .setCustomId('tracker_input')
            .setLabel(`New value for ${getDisplayFieldName(fieldKey)}`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
        const messageObj = await interaction.fetchReply();
        const buttonCollector = messageObj.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: 300000 // 5 minutes
        });
        buttonCollector.on('collect', async i => {
            try {
                if (i.customId === 'tracker_back') {
                    if (session.currentEditField > 0) {
                        session.currentEditField--;
                        await updateEditFieldPrompt(i);
                    } else {
                        collector.stop();
                        buttonCollector.stop();
                        await handleDataEdit(i);
                    }
                } else if (i.customId === 'tracker_cancel') {
                    collector.stop();
                    buttonCollector.stop();
                    await handleDataReview(i, session.data);
                }
            } catch (error) {
                console.error('Error in button interaction:', error);
                await handleError(i, error);
            }
        });
    } catch (error) {
        console.error('Error setting up edit field flow:', error);
        await handleError(interaction, error);
    }
}

/**
 * Called when all fields have been edited (copied from track_run_old.js)
 */
async function handleEditFieldsComplete(interaction) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        const mergedData = { ...session.originalData };
        const editedFields = [];
        for (const field of session.fieldsToEdit) {
            if (mergedData[field] !== session.data[field]) {
                editedFields.push(field);
            }
            mergedData[field] = session.data[field];
        }
        session.actionLog = session.actionLog || [];
        session.actionLog.push({
            action: 'edited_run',
            data: mergedData,
            fields: editedFields,
            timestamp: new Date()
        });
        session.data = mergedData;
        // Remove the screenshot attachment from the message after editing is complete
        await interaction.editReply({
            embeds: [trackerUI.createDataReviewEmbed(mergedData, session.status === 'reviewing_manual' ? 'Manual' : 'Extracted', session.isDuplicateRun, session.settings?.decimalPreference)],
            components: [
                trackerUI.createTypeSelectionRow(session.uploadType || session.settings?.defaultRunType || 'farming'),
                ...trackerUI.createConfirmationButtons()
            ],
            files: [] // Remove any attached files
        });
        // --- PATCH: Attach a new collector to the new message for Accept/Edit/Cancel ---
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            time: 300000 // 5 minutes
        });
        collector.on('collect', async i => {
            try {
                if (i.customId === 'tracker_accept') {
                    collector.stop();
                    await handleDataSubmission(i);
                } else if (i.customId === 'tracker_edit') {
                    collector.stop();
                    await module.exports.handleDataEdit(i);
                } else if (i.customId === 'tracker_cancel') {
                    collector.stop();
                    await handleDataReview(i);
                }
            } catch (error) {
                console.error('Error in data review interaction:', error);
                await handleError(i, error);
            }
        });
        // --- END PATCH ---
    } catch (error) {
        console.error('Error handling edit fields completion:', error);
        await handleError(interaction, error);
    }
}

/**
 * Updates the edit field prompt (copied from track_run_old.js)
 */
async function updateEditFieldPrompt(interaction) {
    try {
        const userId = interaction.user.id;
        const session = userSessions.get(userId);
        const fields = session.fieldsToEdit;
        const currentIndex = session.currentEditField;
        const currentField = fields[currentIndex];
        const displayFieldName = getDisplayFieldName(currentField);
        const editEmbed = new EmbedBuilder()
            .setTitle('Edit Field')
            .setDescription(`Enter the new value for \n## **${displayFieldName}**\ninto chat:`)
            .addFields(
                { name: 'Format', value: getFieldFormatExample(currentField) },
                { name: 'Current Value', value: String(session.originalData[currentField] || 'N/A') },
                { name: 'Progress', value: `Field ${currentIndex + 1} of ${fields.length}` }
            )
            .setColor(Colors.Blue)
            .setFooter({ text: 'Type your response in the chat' });
        // During editing, attach the screenshot as a file only (no setImage)
        let replyOptions = {
            embeds: [editEmbed],
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('tracker_back')
                        .setLabel('Back')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('tracker_cancel')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Danger)
                )
            ],
            content: ''
        };
        if (session.screenshotAttachment && session.screenshotAttachment.url) {
            replyOptions.files = [{
                attachment: session.screenshotAttachment.url,
                name: 'screenshot.png'
            }];
        }
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(replyOptions);
        } else {
            await interaction.update(replyOptions);
        }
    } catch (error) {
        console.error('Error updating edit field prompt:', error);
    }
}

function getDisplayFieldName(internalName) {
    const fieldNameMap = {
        'tier': 'Tier',
        'wave': 'Wave',
        'roundDuration': 'Duration',
        'duration': 'Duration',
        'totalCoins': 'Coins',
        'coins': 'Coins',
        'totalCells': 'Cells',
        'cells': 'Cells',
        'totalDice': 'Dice',
        'dice': 'Dice',
        'killedBy': 'Killed By',
        'date': 'Date/Time',
        'time': 'Time',
        'notes': 'Notes',
        'note': 'Notes',
    };
    return fieldNameMap[internalName] || (internalName.charAt(0).toUpperCase() + internalName.slice(1));
}

function getFieldFormatExample(field) {
    const examples = {
        'tier': 'Enter a number between 1 and 18',
        'wave': 'Enter the number of waves (e.g., 7554)',
        'totalCoins': 'Enter a number including notation (e.g., 10.5q)',
        'coins': 'Enter a number including notation (e.g., 10.5q)',
        'totalCells': 'Enter a number including notation (e.g., 1.2M)',
        'cells': 'Enter a number including notation (e.g., 1.2M)',
        'totalDice': 'Enter a number including notation (e.g., 7.5K)',
        'dice': 'Enter a number including notation (e.g., 7.5K)',
        'roundDuration': 'Format as 1h30m45s',
        'duration': 'Format as 1h30m45s',
        'killedBy': 'Enemy name (e.g., Boss)',
        'date': 'YYYY-MM-DD',
        'time': 'HH:MM',
        'notes': 'Any additional notes (Use N/A if none)',
        'note': 'Any additional notes (Use N/A if none)'
    };
    return examples[field] || 'Enter a value';
}

module.exports = {
    handleEditCurrentRun,
    handleDataEdit,
    handleFieldEdit,
    async handleEditModalSubmit(interaction, field) {
        try {
            const userId = interaction.user.id;
            const session = userSessions.get(userId);
            if (!session) {
                await interaction.reply({ content: 'Session expired or not found. Restart the edit flow.', ephemeral: true });
                return;
            }
            const valueRaw = interaction.fields.getTextInputValue('tracker_input');
            let value = valueRaw;
            const fieldKey = field;
            if (["totalCoins", "totalCells", "totalDice", "coins", "cells", "dice"].includes(fieldKey)) {
                value = standardizeNotation(valueRaw);
            } else if (fieldKey === "killedBy" || fieldKey === "Killed By") {
                value = toTitleCase(valueRaw);
            }
            session.data[fieldKey] = value;
            session.currentEditField++;
            userSessions.set(userId, session);
            await interaction.reply({ content: `Updated ${getDisplayFieldName(fieldKey)}.`, ephemeral: true });
            // Continue flow
            await setupEditFieldFlow(interaction);
        } catch (err) {
            console.error('Error in handleEditModalSubmit:', err);
            try { await interaction.reply({ content: 'Failed to process input.', ephemeral: true }); } catch(e){}
        }
    }
};