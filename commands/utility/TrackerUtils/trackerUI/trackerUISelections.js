const { ActionRowBuilder, SelectMenuBuilder } = require('discord.js');
const { getDisplayFieldName } = require('./trackerUIEmbeds.js');

function createFieldSelectionRow(data) {
    const options = Object.keys(data)
        // Filter out internal/unwanted fields if necessary
        .filter(key => !['_id', 'userId', '__v', 'settings', 'runId', 'id'].includes(key)) 
        .map(key => ({
            label: getDisplayFieldName(key), 
            value: key, 
            description: `Current: ${String(data[key]).substring(0, 50)}`
            // No 'default' needed here as it's multi-select capable via min/max values
        }));

    // Ensure options don't exceed Discord limit (25)
    const limitedOptions = options.slice(0, 25);

    return new ActionRowBuilder().addComponents(
        // Use SelectMenuBuilder here
        new SelectMenuBuilder() 
            .setCustomId('tracker_field_select')
            .setPlaceholder('Select field(s) to edit')
            // Allow multiple selections
            .setMinValues(1)
            .setMaxValues(limitedOptions.length) // Allow selecting up to all displayed options
            .addOptions(limitedOptions) // Add the potentially limited options
    );
}

/**
 * Creates the action row with the run type selection dropdown.
 * @param {string} [defaultType='farming'] - The default run type to pre-select (lowercase).
 * @returns {ActionRowBuilder} The action row containing the select menu.
 */
function createTypeSelectionRow(defaultType = 'farming') {
    // Normalize defaultType to lowercase
    const normalizedDefault = defaultType.toLowerCase(); 

    return new ActionRowBuilder().addComponents(
        new SelectMenuBuilder() 
            .setCustomId('tracker_type_select')
            .setPlaceholder('Select run type')
            .addOptions(
                {
                    label: 'Farming',
                    value: 'Farming', // Keep value capitalized for consistency elsewhere
                    description: 'Standard run for resource collection.',
                    default: normalizedDefault === 'farming',
                },
                {
                    label: 'Overnight',
                    value: 'Overnight',
                    description: 'Long run, typically while AFK.',
                    default: normalizedDefault === 'overnight',
                },
                {
                    label: 'Tournament',
                    value: 'Tournament',
                    description: 'Run competing in a tournament event.',
                    default: normalizedDefault === 'tournament',
                },
                {
                    label: 'Milestone',
                    value: 'Milestone',
                    description: 'Run focused on reaching a specific goal.',
                    default: normalizedDefault === 'milestone',
                }
                // Add other types as needed
            )
    );
}

module.exports = {
    createFieldSelectionRow,
    createTypeSelectionRow
};