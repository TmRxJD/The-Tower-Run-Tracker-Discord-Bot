// Settings handlers for tracker
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, Colors, time } = require('discord.js');

// Import shared state and emitter
const { userSettings, trackerEmitter } = require('./sharedState.js');
const { handleError } = require('./errorHandlers.js');
const trackerApi = require('./trackerAPI.js');

/**
 * Handle settings flow
 * NOTE: This function now ONLY prepares the UI content and sets up its collector.
 * Navigation is handled by emitting events.
 */
async function handleSettingsFlow(interaction, commandInteractionId = interaction.id) {
    try {
        if (!interaction.deferred) {
            await interaction.deferReply({ ephemeral: true });
        }
        const userId = interaction.user.id;
        
        // Fetch latest settings from API
        let apiSettings = await trackerApi.getUserSettings(userId);
        if (!apiSettings) {
            apiSettings = {
                scanLanguage: 'English',
                timezone: 'UTC', // Default to UTC
                defaultTracker: 'Web',
                autoDetectDuplicates: true,
                confirmBeforeSubmit: true,
                shareNotes: false
            };
        } else if (!apiSettings.timezone) {
            apiSettings.timezone = 'UTC'; // Ensure default is UTC if unset
        }
        userSettings.set(userId, apiSettings);
        const currentSettings = userSettings.get(userId);
        
        // Create settings embed
        const settingsEmbed = new EmbedBuilder()
            .setTitle('⚙️ Tracker Settings')
            .setDescription('Configure your personal tracking preferences.\n\nUse the dropdowns and buttons below to update your settings. Settings are saved automatically.')
            .addFields(
                 { name: 'Scan Language', value: 'Choose the language for OCR text extraction.\n**' + (currentSettings.scanLanguage || 'English') + '**', inline: true },
                 { name: 'Timezone', value: 'Set your preferred timezone for run timestamps.\n**' + (currentSettings.timezone || 'UTC') + '**', inline: true },
                 { name: 'Tracker', value: 'Select between the web-based or spreadsheet tracker.\n**' + (currentSettings.defaultTracker || 'Web') + '**', inline: true },
                 { name: 'Auto-detect duplicates', value: 'Enable/disable automatic duplicate run detection.\n**' + (currentSettings.autoDetectDuplicates ? 'Enabled ✅' : 'Disabled ❌') + '**', inline: true },
                 { name: 'Confirm before submit', value: 'Require confirmation before saving a run.\n**' + (currentSettings.confirmBeforeSubmit ? 'Enabled ✅' : 'Disabled ❌') + '**', inline: true },
                 { name: 'Share Settings', value: 'Configure what elements appear in your share messages.', inline: true },
                 { name: 'Import', value: 'Import your previous runs from the old spreadsheet', inline: true }
             )
            .setColor(Colors.Blue)
            .setFooter({ text: 'Settings are saved automatically' });

        // Timezone data: label, value, description, offset
        const timezones = [
            { label: 'UTC', value: 'UTC', desc: 'Coordinated Universal Time (UTC+0)', offset: 0 },
            { label: 'GMT', value: 'GMT', desc: 'Greenwich Mean Time (UTC+0)', offset: 0 },
            { label: 'WAT', value: 'WAT', desc: 'West Africa Time (UTC+1)', offset: 1 },
            { label: 'CET', value: 'CET', desc: 'Central European Time (UTC+1)', offset: 1 },
            { label: 'EET', value: 'EET', desc: 'Eastern European Time (UTC+2)', offset: 2 },
            { label: 'MSK', value: 'MSK', desc: 'Moscow Standard Time (UTC+3)', offset: 3 },
            { label: 'EAT', value: 'EAT', desc: 'East Africa Time (UTC+3)', offset: 3 },
            { label: 'IST', value: 'IST', desc: 'India Standard Time (UTC+5:30)', offset: 5.5 },
            { label: 'CST_CH', value: 'CST (China)', desc: 'China Standard Time (UTC+8)', offset: 8 },
            { label: 'JST', value: 'JST', desc: 'Japan Standard Time (UTC+9)', offset: 9 },
            { label: 'AEST', value: 'AEST', desc: 'Australian Eastern Standard Time (UTC+10)', offset: 10 },
            { label: 'NZST', value: 'NZST', desc: 'New Zealand Standard Time (UTC+12)', offset: 12 },
            { label: 'ART', value: 'ART', desc: 'Argentina Time (UTC-3)', offset: -3 },
            { label: 'BRT', value: 'BRT', desc: 'Brasília Time (UTC-3)', offset: -3 },
            { label: 'EST', value: 'EST', desc: 'Eastern Standard Time (US & Canada) (UTC-5)', offset: -5 },
            { label: 'CST', value: 'CST', desc: 'Central Standard Time (US & Canada) (UTC-6)', offset: -6 },
            { label: 'MST', value: 'MST', desc: 'Mountain Standard Time (US & Canada) (UTC-7)', offset: -7 },
            { label: 'PST', value: 'PST', desc: 'Pacific Standard Time (US & Canada) (UTC-8)', offset: -8 },
            { label: 'AKST', value: 'AKST', desc: 'Alaska Standard Time (UTC-9)', offset: -9 },
            { label: 'HST', value: 'HST', desc: 'Hawaii-Aleutian Standard Time (UTC-10)', offset: -10 }
        ];
        // Language data
        const languages = [
            { label: 'English', value: 'English', description: 'English language scanning', emoji: '🇺🇸' },
            { label: 'Spanish', value: 'Spanish', description: 'Spanish language scanning', emoji: '🇪🇸' },
            { label: 'French', value: 'French', description: 'French language scanning', emoji: '🇫🇷' },
            { label: 'German', value: 'German', description: 'German language scanning', emoji: '🇩🇪' },
            { label: 'Italian', value: 'Italian', description: 'Italian language scanning', emoji: '🇮🇹' },
            { label: 'Portuguese', value: 'Portuguese', description: 'Portuguese language scanning', emoji: '🇧🇷' },
            { label: 'Russian', value: 'Russian', description: 'Russian language scanning', emoji: '🇷🇺' }
        ];
        // Tracker type data
        const trackerTypes = [
            { label: 'Web', value: 'Web', description: 'Use the new web-based tracker', emoji: '🌐' },
            { label: 'Spreadsheet', value: 'Spreadsheet', description: 'Use the old spreadsheet-based tracker', emoji: '📊' }
        ];
        // Helper: Map UTC offset to clockface emoji
        function getClockEmoji(offset) {
            let hour = Math.round(offset);
            if (hour < 0) hour = 12 + (hour % 12);
            if (hour === 0) hour = 12;
            hour = ((hour - 1) % 12) + 1;
            const clockEmojis = ['🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛'];
            return clockEmojis[(hour - 1) % 12];
        }
        // Dropdowns (single source for both initial and updated menus)
        const languageDropdown = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tracker_language_select')
                .setPlaceholder('Select scan language')
                .addOptions(languages.map(lang => ({
                    ...lang,
                    default: currentSettings.scanLanguage === lang.value
                })))
        );
        const timezoneDropdown = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tracker_timezone_select')
                .setPlaceholder('Select timezone')
                .addOptions(timezones.map(tz => ({
                    label: tz.label,
                    value: tz.value,
                    description: tz.desc,
                    emoji: getClockEmoji(tz.offset),
                    default: currentSettings.timezone === tz.value
                })))
        );
        const trackerTypeDropdown = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('tracker_tracker_select')
                .setPlaceholder('Select tracker type')
                .addOptions(trackerTypes.map(type => ({
                    ...type,
                    default: currentSettings.defaultTracker === type.value
                })))
        );

        // Create settings buttons with decimal preference toggle
        const settingsButtonsRow = new ActionRowBuilder().addComponents(   
            new ButtonBuilder()
                .setCustomId('tracker_setting_duplicates')
                .setLabel(`${currentSettings.autoDetectDuplicates ? '✅' : '❌'} duplicate detection`)
                .setStyle(currentSettings.autoDetectDuplicates ? ButtonStyle.Success : ButtonStyle.Danger),
                
            new ButtonBuilder()
                .setCustomId('tracker_setting_confirm')
                .setLabel(`${currentSettings.confirmBeforeSubmit ? '✅' : '❌'} confirmation`)
                .setStyle(currentSettings.confirmBeforeSubmit ? ButtonStyle.Success : ButtonStyle.Danger),

                new ButtonBuilder()
                .setCustomId('tracker_share_settings')
                .setLabel('Share Settings')
                .setStyle(ButtonStyle.Primary)
        );
        
        // Create back button row with import button before it
        const backButtonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('tracker_import')
                .setLabel('Import')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('tracker_back')
                .setLabel('Back to Main Menu')
                .setStyle(ButtonStyle.Secondary)
        );
        
        // Show the settings (Edit the reply)
        await interaction.editReply({
            embeds: [settingsEmbed],
            components: [
                languageDropdown,
                timezoneDropdown,
                trackerTypeDropdown,
                settingsButtonsRow,
                backButtonRow
            ]
        });
        
        // Set up collector for this specific message
        const message = await interaction.fetchReply();
        const collector = message.createMessageComponentCollector({ 
             // Filter needed to prevent other interaction collectors from interfering
             filter: i => [
                'tracker_setting_duplicates', 
                'tracker_setting_confirm', 
                'tracker_back', 
                'tracker_language_select', 
                'tracker_timezone_select',
                'tracker_tracker_select',
                'tracker_share_settings',
                'tracker_import'
             ].includes(i.customId) && i.user.id === userId,
             time: 300000 
        });
        
        collector.on('collect', async i => {
            // Get the commandInteractionId from the original interaction if possible, or fallback
            const commandInteractionId = interaction.message?.interaction?.id || interaction.id;
            try {
                const latestSettings = userSettings.get(userId);
                if (!latestSettings) {
                    console.warn(`[Settings Collect] User settings disappeared for ${userId}`);
                    await i.reply({ content: 'Session error, please restart settings.', ephemeral: true });
                    collector.stop(); // Stop if session is lost
                    return;
                }

                let settingChanged = false;
                // Defer the interaction immediately
                await i.deferUpdate(); 

                // Explicitly stop collector on any navigation or flow-changing button
                if (i.customId === 'tracker_back') {
                    collector.stop('back');
                    trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
                    return;
                } else if (i.customId === 'tracker_import') {
                    collector.stop('import');
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'importUserData', i);
                    return;
                }

                if (i.customId === 'tracker_setting_duplicates') {
                    latestSettings.autoDetectDuplicates = !latestSettings.autoDetectDuplicates;
                    settingChanged = true;
                } else if (i.customId === 'tracker_setting_confirm') {
                    latestSettings.confirmBeforeSubmit = !latestSettings.confirmBeforeSubmit;
                    settingChanged = true;
                } else if (i.customId === 'tracker_share_settings') {
                    collector.stop('shareSettings');
                    trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'shareSettings', i);
                    return;
                } else if (i.customId === 'tracker_language_select') {
                    if (i.isStringSelectMenu()) { // Ensure it's a select menu interaction
                        latestSettings.scanLanguage = i.values[0];
                        settingChanged = true;
                    }
                } else if (i.customId === 'tracker_timezone_select') {
                    if (i.isStringSelectMenu()) { // Ensure it's a select menu interaction
                        latestSettings.timezone = i.values[0];
                        settingChanged = true;
                    }
                } else if (i.customId === 'tracker_tracker_select') {
                    if (i.isStringSelectMenu()) {
                        latestSettings.defaultTracker = i.values[0];
                        settingChanged = true;
                    }
                }

                if (settingChanged) {
                    // Save the updated settings back to the Map
                    userSettings.set(userId, latestSettings);
                    // Save to backend
                    await trackerApi.editUserSettings(userId, latestSettings);
                    
                    // --- Re-render UI components directly ---
                    const updatedSettingsEmbed = new EmbedBuilder()
                         .setTitle('⚙️ Tracker Settings')
                         .setDescription('Configure your personal tracking preferences.\n\nUse the dropdowns and buttons below to update your settings. Settings are saved automatically.')
            
                         .addFields(
                             { name: 'Scan Language', value: 'Choose the language for OCR text extraction.\n**' + (latestSettings.scanLanguage || 'English') + '**', inline: true },
                             { name: 'Timezone', value: 'Set your preferred timezone for run timestamps.\n**' + (latestSettings.timezone || 'UTC') + '**', inline: true },
                             { name: 'Tracker', value: 'Select between the web-based or spreadsheet tracker.\n**' + (latestSettings.defaultTracker || 'Web') + '**', inline: true },
                             { name: 'Auto-detect duplicates', value: 'Enable/disable automatic duplicate run detection.\n**' + (latestSettings.autoDetectDuplicates ? 'Enabled ✅' : 'Disabled ❌') + '**', inline: true },
                             { name: 'Confirm before submit', value: 'Require confirmation before saving a run.\n**' + (latestSettings.confirmBeforeSubmit ? 'Enabled ✅' : 'Disabled ❌') + '**', inline: true },
                             { name: 'Share Settings', value: 'Configure what elements appear in your share messages.', inline: true },
                             { name: 'Import', value: 'Import your previous runs from the old spreadsheet', inline: true }
                         )
                         .setColor(Colors.Blue)
                         .setFooter({ text: 'Settings are saved automatically' });

                    const updatedLanguageDropdown = new ActionRowBuilder().addComponents(
                         new StringSelectMenuBuilder()
                             .setCustomId('tracker_language_select')
                             .setPlaceholder('Select scan language')
                             .addOptions(languages.map(lang => ({
                                ...lang,
                                default: latestSettings.scanLanguage === lang.value
                             })))
                     );

                    const updatedTimezoneDropdown = new ActionRowBuilder().addComponents(
                            new StringSelectMenuBuilder()
                                .setCustomId('tracker_timezone_select')
                                .setPlaceholder('Select timezone')
                                .addOptions(
                                    timezones.map(tz => ({
                                        label: tz.label,
                                        value: tz.value,
                                        description: tz.desc,
                                        emoji: getClockEmoji(tz.offset),
                                        default: latestSettings.timezone === tz.value
                                    }))
                                )
                    );

                    const updatedTrackerTypeDropdown = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('tracker_tracker_select')
                            .setPlaceholder('Select tracker type')
                            .addOptions(trackerTypes.map(type => ({
                                ...type,
                                default: latestSettings.defaultTracker === type.value
                            })))
                    );

                    const updatedSettingsButtonsRow = new ActionRowBuilder().addComponents(
                         new ButtonBuilder()
                             .setCustomId('tracker_setting_duplicates')
                             .setLabel(`${latestSettings.autoDetectDuplicates ? '✅' : '❌'} duplicate detection`)
                             .setStyle(latestSettings.autoDetectDuplicates ? ButtonStyle.Success : ButtonStyle.Danger),
                         new ButtonBuilder()
                             .setCustomId('tracker_setting_confirm')
                             .setLabel(`${latestSettings.confirmBeforeSubmit ? '✅' : '❌'} confirmation`)
                             .setStyle(latestSettings.confirmBeforeSubmit ? ButtonStyle.Success : ButtonStyle.Danger)
                     );

                    const updatedBackButtonRow = new ActionRowBuilder().addComponents(
                         new ButtonBuilder()
                             .setCustomId('tracker_import')
                             .setLabel('Import')
                             .setStyle(ButtonStyle.Primary),
                         new ButtonBuilder()
                             .setCustomId('tracker_back')
                             .setLabel('Back to Main Menu')
                             .setStyle(ButtonStyle.Secondary)
                     );
                     // --- End Re-render ---

                     // Edit the reply using the current interaction 'i' with the updated components
                     await i.editReply({
                         embeds: [updatedSettingsEmbed],
                         components: [
                             updatedLanguageDropdown,
                             updatedTimezoneDropdown,
                             updatedTrackerTypeDropdown,
                             updatedSettingsButtonsRow,
                             updatedBackButtonRow
                         ]
                     });
                     // The collector continues running, no need to stop or recurse.
                } 
                // No 'else' needed here because we already deferred 'i' at the start.
                // If no setting changed, the deferUpdate is enough acknowledgement.
                
            } catch (error) {
                // Get commandInteractionId safely
                 const commandInteractionId = interaction.message?.interaction?.id || interaction.id;
                console.error('Error processing settings interaction:', error);
                // Try emitting error using the commandInteractionId if possible
                 if(commandInteractionId) {
                    trackerEmitter.emit(`error_${commandInteractionId}`, i, error); 
                 }
                // Attempt to inform user on the component interaction
                 try {
                     // Check if 'i' can be replied to or followed up
                     if (!i.replied && !i.deferred) {
                         await i.reply({ content: 'An error occurred updating settings.', ephemeral: true });
                     } else if (i.editable) { // Check if editable before following up
                         await i.followUp({ content: 'An error occurred updating settings.', ephemeral: true });
                     }
                 } catch (replyError) {
                     console.error('Failed to send error follow-up:', replyError);
                 } 
            }
        });
        
        // Add collector end handler (optional but good practice)
        collector.on('end', (collected, reason) => {
            const userId = interaction.user.id;
            const username = interaction.user.username;
            console.log(`[Settings Collector] Ended for user ${username} (${userId}). Reason: ${reason}`);
            if (reason === 'time') {
                // Optionally remove buttons on timeout
                 interaction.editReply({ components: [] }).catch(() => {});
                // Clean up session? Maybe not necessary if main timeout handles it.
                // Clean up event listeners associated with the original command interaction if needed
                // trackerEmitter.emit(`cleanup_${commandInteractionId}`); // Example cleanup event
             }
             // If stopped manually (e.g., 'Back' button), the relevant handler already took action.
         });
        
    } catch (error) {
        const commandInteractionId = interaction.message?.interaction?.id || interaction.id;
        console.error('Error in handleSettingsFlow:', error);
        // Emit error using the original interaction context
        if(commandInteractionId){
             trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
        }
    }
}

module.exports = {
    handleSettingsFlow
};