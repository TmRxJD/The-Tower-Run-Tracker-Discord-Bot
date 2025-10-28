const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function createMainMenuButtons(trackerType = 'Web', trackerLink = 'https://the-tower-run-tracker.com/', shareState = {}) {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_addrun')
            .setLabel('Add Run')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕'),
        new ButtonBuilder()
            .setCustomId('tracker_manual')
            .setLabel('Manual Entry')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝')
    );

    // Determine Share Last Run button state
    let shareLastBtn = new ButtonBuilder()
        .setCustomId('tracker_sharelast')
        .setEmoji('📢');
    if (shareState.shared) {
        shareLastBtn.setLabel('Shared').setStyle(ButtonStyle.Success).setDisabled(true);
    } else if (shareState.noRuns) {
        shareLastBtn.setLabel('No Runs').setStyle(ButtonStyle.Danger).setDisabled(true);
    } else {
        shareLastBtn.setLabel('Share Last Run').setStyle(ButtonStyle.Success);
    }

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_editlast')
            .setLabel('Edit Last')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        shareLastBtn,
        new ButtonBuilder()
            .setCustomId('tracker_viewruns')
            .setLabel('View Runs')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📈')
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel(trackerType === 'Spreadsheet' ? 'Spreadsheet Tracker' : 'Web Tracker')
            .setStyle(ButtonStyle.Link)
            .setURL(trackerLink)
            .setEmoji(trackerType === 'Spreadsheet' ? '📊' : '🔗'),
        new ButtonBuilder()
            .setCustomId('tracker_settings')
            .setLabel('Settings')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚙️'),        
        new ButtonBuilder()
            .setCustomId('tracker_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );

    // Return rows, filtering out empty ones if necessary
    return [row1, row2, row3].filter(row => row.components.length > 0);
}

function createNavigationButtons(backId = 'tracker_back', cancelId = 'tracker_cancel') {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(backId)
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('◀️'),
        new ButtonBuilder()
            .setCustomId(cancelId)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );
}

function createConfirmationButtons(includeEditCurrent = false) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_accept')
            .setLabel('Accept')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId('tracker_edit') // Changed from tracker_edit_current for simplicity
            .setLabel('Edit')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        new ButtonBuilder()
            .setCustomId('tracker_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );
    
    return [row];
}

function createSuccessButtons(username, runId, runCount, trackerType = 'Web', trackerLink = 'https://the-tower-run-tracker.com/') {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_share')
            .setLabel('Share to Channel')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📢'),
        new ButtonBuilder()
            .setCustomId('tracker_editlast')
            .setLabel('Edit Last')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️')
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_addrun')
            .setLabel('Add Another')
            .setStyle(ButtonStyle.Success)
            .setEmoji('➕'),
        new ButtonBuilder()
            .setLabel(trackerType === 'Spreadsheet' ? 'View Spreadsheet' : 'View Tracker')
            .setStyle(ButtonStyle.Link)
            .setURL(trackerLink)
            .setEmoji(trackerType === 'Spreadsheet' ? '📊' : '🔗')
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_main_menu')
            .setLabel('Main Menu')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🏠'),
        new ButtonBuilder()
            .setCustomId('tracker_cancel')
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );
    return [row1, row2, row3];
}

function createCancelButton() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );
}

const createErrorRecoveryButtons = (manualId, mainId, cancelId = 'cancel') => {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(mainId).setLabel('Main Menu').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(manualId).setLabel('Manual Entry').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Danger)
        )
    ];
};

module.exports = {
  createMainMenuButtons,
  createNavigationButtons,
  createConfirmationButtons,
  createSuccessButtons,
  createCancelButton,
  createErrorRecoveryButtons
};