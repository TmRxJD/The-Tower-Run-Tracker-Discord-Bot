// Share settings handlers for tracker
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, Colors } = require('discord.js');
const { userSessions, trackerEmitter } = require('./sharedState.js');
const { handleError } = require('./errorHandlers.js');
const { createShareEmbed, formatNumberForDisplay } = require('../trackerUI/trackerUIEmbeds.js');
const { calculateHourlyRates, parseNumberInput } = require('./trackerHelpers.js');
const path = require('path');
const { loadSetting, saveSetting, loadAllSettings, saveMultipleSettings } = require('./settingsDB.js');

/**
 * Load share settings for a user
 */
async function loadShareSettings(userId) {
    try {
        const settings = loadAllSettings(userId);
        if (Object.keys(settings).length > 0) {
            return {
                includeTier: settings.includeTier === 'true',
                includeWave: settings.includeWave === 'true',
                includeDuration: settings.includeDuration === 'true',
                includeKilledBy: settings.includeKilledBy === 'true',
                includeTotalCoins: settings.includeTotalCoins === 'true',
                includeTotalCells: settings.includeTotalCells === 'true',
                includeTotalDice: settings.includeTotalDice === 'true',
                includeCoinsPerHour: settings.includeCoinsPerHour === 'true',
                includeCellsPerHour: settings.includeCellsPerHour === 'true',
                includeDicePerHour: settings.includeDicePerHour === 'true',
                includeNotes: settings.includeNotes === 'true',
                includeScreenshot: settings.includeScreenshot === 'true'
            };
        } else {
            // Return defaults
            return {
                includeTier: true,
                includeWave: true,
                includeDuration: true,
                includeKilledBy: true,
                includeTotalCoins: true,
                includeTotalCells: true,
                includeTotalDice: true,
                includeCoinsPerHour: true,
                includeCellsPerHour: true,
                includeDicePerHour: true,
                includeNotes: true,
                includeScreenshot: false
            };
        }
    } catch (error) {
        console.error('Error loading share settings:', error);
        // Return defaults on error
        return {
            includeTier: true,
            includeWave: true,
            includeDuration: true,
            includeKilledBy: true,
            includeTotalCoins: true,
            includeTotalCells: true,
            includeTotalDice: true,
            includeCoinsPerHour: true,
            includeCellsPerHour: true,
            includeDicePerHour: true,
            includeNotes: true,
            includeScreenshot: false
        };
    }
}

/**
 * Save share settings for a user
 */
async function saveShareSettings(userId, settings) {
    try {
        const settingsToSave = {
            includeTier: settings.includeTier ? 'true' : 'false',
            includeWave: settings.includeWave ? 'true' : 'false',
            includeDuration: settings.includeDuration ? 'true' : 'false',
            includeKilledBy: settings.includeKilledBy ? 'true' : 'false',
            includeTotalCoins: settings.includeTotalCoins ? 'true' : 'false',
            includeTotalCells: settings.includeTotalCells ? 'true' : 'false',
            includeTotalDice: settings.includeTotalDice ? 'true' : 'false',
            includeCoinsPerHour: settings.includeCoinsPerHour ? 'true' : 'false',
            includeCellsPerHour: settings.includeCellsPerHour ? 'true' : 'false',
            includeDicePerHour: settings.includeDicePerHour ? 'true' : 'false',
            includeNotes: settings.includeNotes ? 'true' : 'false',
            includeScreenshot: settings.includeScreenshot ? 'true' : 'false'
        };
        saveMultipleSettings(userId, settingsToSave);
    } catch (error) {
        console.error('Error saving share settings:', error);
    }
}

/**
 * Create preview share embed
 */
function createPreviewShareEmbed(selectedElements, user) {
    // Example data
    const exampleRunData = {
        tier: 14,
        wave: 8309,
        duration: '7h 36m 5s',
        roundDuration: '7h 36m 5s',
        killedBy: 'Boss',
        totalCoins: '90.01q',
        coins: '90.01q',
        totalCells: '810.80K',
        cells: '810.80K',
        rerollShards: '11.33K',
        totalDice: '11.33K',
        notes: 'Example notes for preview',
        note: 'Example notes for preview'
    };

    // Calculate hourly rates
    const stats = calculateHourlyRates(exampleRunData.duration, exampleRunData);

    // Create share embed with selected elements
    const shareEmbed = new EmbedBuilder()
        .setAuthor({ name: user.username + ' Shared a Run', iconURL: user.displayAvatarURL() })
        .setTitle('Farming Run #1')
        .setDescription(
            (selectedElements.includeTier ? `🔢 Tier: **14**\n` : '') +
            (selectedElements.includeWave ? `🌊 Wave: **8309**\n` : '') +
            (selectedElements.includeDuration ? `⏱️ Duration: **7h 36m 5s**\n` : '') +
            (selectedElements.includeKilledBy ? `💀 Killed By: **Scatter**\n` : '') +
            (selectedElements.includeTotalCoins ? `🪙 Total Coins: **90.01q**\n` : '') +
            (selectedElements.includeTotalCells ? `🔋 Total Cells: **810.80K**\n` : '') +
            (selectedElements.includeTotalDice ? `🎲 Total Dice: **11.33K**\n` : '') +
            ((selectedElements.includeCoinsPerHour || selectedElements.includeCellsPerHour || selectedElements.includeDicePerHour) ? '### **📈 Earnings per Hour**' : '')
        )
        .setColor(Colors.Gold)
        .setThumbnail('https://i.postimg.cc/pTVP1MPh/Screenshot-2025-05-04-124710.png')
        .setFooter({ text: ' Tracked with The Tower Run Tracker\nUse /track to log a run\n\n\nUse the dropdown below to select which elements you want to include in your share messages. The display will update in real time to show how your selections will affect the appearance of your share messages.' });

    if (selectedElements.includeCoinsPerHour || selectedElements.includeCellsPerHour || selectedElements.includeDicePerHour) {
        const fields = [];
        if (selectedElements.includeCoinsPerHour) {
            fields.push({ name: '🪙\nCoins', value: formatNumberForDisplay(parseNumberInput(stats.coinsPerHour)), inline: true });
        }
        if (selectedElements.includeCellsPerHour) {
            fields.push({ name: '🔋\nCells', value: formatNumberForDisplay(parseNumberInput(stats.cellsPerHour)), inline: true });
        }
        if (selectedElements.includeDicePerHour) {
            fields.push({ name: '🎲\nDice', value: formatNumberForDisplay(parseNumberInput(stats.dicePerHour)), inline: true });
        }
        shareEmbed.addFields(fields);
    }

    if (selectedElements.includeNotes) {
        shareEmbed.addFields({ name: '\nNotes', value: 'Lorem ipsum dolor sit amet.' });
    }

    if (selectedElements.includeScreenshot) {
        shareEmbed.setImage('attachment://example_screenshot.jpg');
    }

    return shareEmbed;
}

/**
 * Handle share settings flow
 */
async function handleShareSettingsFlow(interaction, commandInteractionId) {
    try {
        const userId = interaction.user.id;
        const user = interaction.user;

        // Load current share settings
        let currentSettings = await loadShareSettings(userId);
        let lastSavedSettings = { ...currentSettings };
        let hasUnsavedChanges = false;
        let isSaved = false;

        // Create initial preview embed
        const previewEmbed = createPreviewShareEmbed(currentSettings, user);

        // Elements dropdown
        const elementsDropdown = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('share_elements_select')
                .setPlaceholder('Select elements to include')
                .setMinValues(0)
                .setMaxValues(12)
                .addOptions([
                    { label: 'Tier', value: 'tier', description: 'Include tier in share messages', default: currentSettings.includeTier },
                    { label: 'Wave', value: 'wave', description: 'Include wave in share messages', default: currentSettings.includeWave },
                    { label: 'Duration', value: 'duration', description: 'Include duration in share messages', default: currentSettings.includeDuration },
                    { label: 'Killed By', value: 'killed_by', description: 'Include killed by in share messages', default: currentSettings.includeKilledBy },
                    { label: 'Total Coins', value: 'total_coins', description: 'Include total coins in share messages', default: currentSettings.includeTotalCoins },
                    { label: 'Total Cells', value: 'total_cells', description: 'Include total cells in share messages', default: currentSettings.includeTotalCells },
                    { label: 'Total Dice', value: 'total_dice', description: 'Include total dice in share messages', default: currentSettings.includeTotalDice },
                    { label: 'Coins per Hour', value: 'coins_per_hour', description: 'Include coins per hour in earnings section', default: currentSettings.includeCoinsPerHour },
                    { label: 'Cells per Hour', value: 'cells_per_hour', description: 'Include cells per hour in earnings section', default: currentSettings.includeCellsPerHour },
                    { label: 'Dice per Hour', value: 'dice_per_hour', description: 'Include dice per hour in earnings section', default: currentSettings.includeDicePerHour },
                    { label: 'Notes', value: 'notes', description: 'Include notes in share messages', default: currentSettings.includeNotes },
                    { label: 'Screenshot', value: 'screenshot', description: 'Include screenshot in share messages', default: currentSettings.includeScreenshot }
                ])
        );

        // Buttons
        const buttonsRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('share_back')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('share_accept')
                .setLabel('Accept')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(true)
        );

        // Show the UI
        const files = currentSettings.includeScreenshot ? [{ attachment: path.join(__dirname, '..', 'assets', 'example_screenshot.jpg'), name: 'example_screenshot.jpg' }] : [];
        await interaction.editReply({
            embeds: [previewEmbed],
            components: [elementsDropdown, buttonsRow],
            files
        });

        // Set up collector
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({
            filter: i => [
                'share_elements_select',
                'share_back',
                'share_accept'
            ].includes(i.customId) && i.user.id === userId,
            time: 300000
        });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();

                if (i.customId === 'share_elements_select') {
                    if (i.isStringSelectMenu()) {
                        const selected = i.values;
                        currentSettings.includeTier = selected.includes('tier');
                        currentSettings.includeWave = selected.includes('wave');
                        currentSettings.includeDuration = selected.includes('duration');
                        currentSettings.includeKilledBy = selected.includes('killed_by');
                        currentSettings.includeTotalCoins = selected.includes('total_coins');
                        currentSettings.includeTotalCells = selected.includes('total_cells');
                        currentSettings.includeTotalDice = selected.includes('total_dice');
                        currentSettings.includeCoinsPerHour = selected.includes('coins_per_hour');
                        currentSettings.includeCellsPerHour = selected.includes('cells_per_hour');
                        currentSettings.includeDicePerHour = selected.includes('dice_per_hour');
                        currentSettings.includeNotes = selected.includes('notes');
                        currentSettings.includeScreenshot = selected.includes('screenshot');

                        hasUnsavedChanges = JSON.stringify(currentSettings) !== JSON.stringify(lastSavedSettings);

                        if (isSaved) {
                            isSaved = false;
                        }

                        // Update preview
                        const updatedPreview = createPreviewShareEmbed(currentSettings, user);
                        const updatedFiles = currentSettings.includeScreenshot ? [{ attachment: path.join(__dirname, '..', 'assets', 'example_screenshot.jpg'), name: 'example_screenshot.jpg' }] : [];

                        // Update dropdown defaults
                        const updatedDropdown = new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('share_elements_select')
                                .setPlaceholder('Select elements to include')
                                .setMinValues(0)
                                .setMaxValues(12)
                                .addOptions([
                                    { label: 'Tier', value: 'tier', description: 'Include tier in share messages', default: currentSettings.includeTier },
                                    { label: 'Wave', value: 'wave', description: 'Include wave in share messages', default: currentSettings.includeWave },
                                    { label: 'Duration', value: 'duration', description: 'Include duration in share messages', default: currentSettings.includeDuration },
                                    { label: 'Killed By', value: 'killed_by', description: 'Include killed by in share messages', default: currentSettings.includeKilledBy },
                                    { label: 'Total Coins', value: 'total_coins', description: 'Include total coins in share messages', default: currentSettings.includeTotalCoins },
                                    { label: 'Total Cells', value: 'total_cells', description: 'Include total cells in share messages', default: currentSettings.includeTotalCells },
                                    { label: 'Total Dice', value: 'total_dice', description: 'Include total dice in share messages', default: currentSettings.includeTotalDice },
                                    { label: 'Coins per Hour', value: 'coins_per_hour', description: 'Include coins per hour in earnings section', default: currentSettings.includeCoinsPerHour },
                                    { label: 'Cells per Hour', value: 'cells_per_hour', description: 'Include cells per hour in earnings section', default: currentSettings.includeCellsPerHour },
                                    { label: 'Dice per Hour', value: 'dice_per_hour', description: 'Include dice per hour in earnings section', default: currentSettings.includeDicePerHour },
                                    { label: 'Notes', value: 'notes', description: 'Include notes in share messages', default: currentSettings.includeNotes },
                                    { label: 'Screenshot', value: 'screenshot', description: 'Include screenshot in share messages', default: currentSettings.includeScreenshot }
                                ])
                        );

                        // Update buttons
                        const updatedButtonsRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('share_back')
                                .setLabel(hasUnsavedChanges ? 'Cancel' : 'Back')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('share_accept')
                                .setLabel('Accept')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(!hasUnsavedChanges)
                        );

                        await i.editReply({
                            embeds: [updatedPreview],
                            components: [updatedDropdown, updatedButtonsRow],
                            files: updatedFiles
                        });
                    }
                } else if (i.customId === 'share_back') {
                    if (hasUnsavedChanges) {
                        // Reset to last saved
                        currentSettings = { ...lastSavedSettings };
                        hasUnsavedChanges = false;
                        isSaved = false;

                        // Update UI to show reset state before continuing
                        const resetPreview = createPreviewShareEmbed(currentSettings, user);
                        const resetFiles = currentSettings.includeScreenshot ? [{ attachment: path.join(__dirname, '..', 'assets', 'example_screenshot.jpg'), name: 'example_screenshot.jpg' }] : [];

                        const resetDropdown = new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('share_elements_select')
                                .setPlaceholder('Select elements to include')
                                .setMinValues(0)
                                .setMaxValues(12)
                                .addOptions([
                                    { label: 'Tier', value: 'tier', description: 'Include tier in share messages', default: currentSettings.includeTier },
                                    { label: 'Wave', value: 'wave', description: 'Include wave in share messages', default: currentSettings.includeWave },
                                    { label: 'Duration', value: 'duration', description: 'Include duration in share messages', default: currentSettings.includeDuration },
                                    { label: 'Killed By', value: 'killed_by', description: 'Include killed by in share messages', default: currentSettings.includeKilledBy },
                                    { label: 'Total Coins', value: 'total_coins', description: 'Include total coins in share messages', default: currentSettings.includeTotalCoins },
                                    { label: 'Total Cells', value: 'total_cells', description: 'Include total cells in share messages', default: currentSettings.includeTotalCells },
                                    { label: 'Total Dice', value: 'total_dice', description: 'Include total dice in share messages', default: currentSettings.includeTotalDice },
                                    { label: 'Coins per Hour', value: 'coins_per_hour', description: 'Include coins per hour in earnings section', default: currentSettings.includeCoinsPerHour },
                                    { label: 'Cells per Hour', value: 'cells_per_hour', description: 'Include cells per hour in earnings section', default: currentSettings.includeCellsPerHour },
                                    { label: 'Dice per Hour', value: 'dice_per_hour', description: 'Include dice per hour in earnings section', default: currentSettings.includeDicePerHour },
                                    { label: 'Notes', value: 'notes', description: 'Include notes in share messages', default: currentSettings.includeNotes },
                                    { label: 'Screenshot', value: 'screenshot', description: 'Include screenshot in share messages', default: currentSettings.includeScreenshot }
                                ])
                        );

                        const resetButtonsRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('share_back')
                                .setLabel('Back')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('share_accept')
                                .setLabel('Accept')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(true)
                        );

                        await i.editReply({
                            embeds: [resetPreview],
                            components: [resetDropdown, resetButtonsRow],
                            files: resetFiles
                        });

                        // Small delay to show the reset state
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        collector.stop('back');
                        trackerEmitter.emit(`navigate_${commandInteractionId}`, 'settings', i);
                    }
                } else if (i.customId === 'share_accept') {
                    // Save settings
                    await saveShareSettings(userId, currentSettings);
                    lastSavedSettings = { ...currentSettings };
                    hasUnsavedChanges = false;
                    isSaved = true;

                    // Update button to Saved!
                    const savedButtonsRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('share_back')
                            .setLabel('Back')
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId('share_accept')
                            .setLabel('Saved!')
                            .setStyle(ButtonStyle.Success)
                            .setDisabled(true)
                    );

                    // Update dropdown with saved settings as defaults
                    const savedDropdown = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('share_elements_select')
                            .setPlaceholder('Select elements to include')
                            .setMinValues(0)
                            .setMaxValues(12)
                            .addOptions([
                                { label: 'Tier', value: 'tier', description: 'Include tier in share messages', default: currentSettings.includeTier },
                                { label: 'Wave', value: 'wave', description: 'Include wave in share messages', default: currentSettings.includeWave },
                                { label: 'Duration', value: 'duration', description: 'Include duration in share messages', default: currentSettings.includeDuration },
                                { label: 'Killed By', value: 'killed_by', description: 'Include killed by in share messages', default: currentSettings.includeKilledBy },
                                { label: 'Total Coins', value: 'total_coins', description: 'Include total coins in share messages', default: currentSettings.includeTotalCoins },
                                { label: 'Total Cells', value: 'total_cells', description: 'Include total cells in share messages', default: currentSettings.includeTotalCells },
                                { label: 'Total Dice', value: 'total_dice', description: 'Include total dice in share messages', default: currentSettings.includeTotalDice },
                                { label: 'Coins per Hour', value: 'coins_per_hour', description: 'Include coins per hour in earnings section', default: currentSettings.includeCoinsPerHour },
                                { label: 'Cells per Hour', value: 'cells_per_hour', description: 'Include cells per hour in earnings section', default: currentSettings.includeCellsPerHour },
                                { label: 'Dice per Hour', value: 'dice_per_hour', description: 'Include dice per hour in earnings section', default: currentSettings.includeDicePerHour },
                                { label: 'Notes', value: 'notes', description: 'Include notes in share messages', default: currentSettings.includeNotes },
                                { label: 'Screenshot', value: 'screenshot', description: 'Include screenshot in share messages', default: currentSettings.includeScreenshot }
                            ])
                    );

                    await i.editReply({
                        components: [savedDropdown, savedButtonsRow],
                        files
                    });
                }
            } catch (error) {
                console.error('Error in share settings collect:', error);
                await handleError(i, error);
            }
        });

        collector.on('end', (collected, reason) => {
            console.log(`[Share Settings Collector] Ended. Reason: ${reason}`);
            if (reason === 'time') {
                interaction.editReply({ components: [] }).catch(() => {});
            }
        });

    } catch (error) {
        console.error('Error in handleShareSettingsFlow:', error);
        await handleError(interaction, error);
    }
}

module.exports = {
    handleShareSettingsFlow,
    loadShareSettings,
    saveShareSettings
};