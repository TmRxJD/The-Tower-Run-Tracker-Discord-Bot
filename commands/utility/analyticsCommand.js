// Analytics command for tracker bot
const { SlashCommandBuilder, EmbedBuilder, Colors } = require('discord.js');
const analyticsDB = require('./TrackerUtils/analyticsDB');

module.exports = {
    category: 'utility',
    data: new SlashCommandBuilder()
        .setName('analytics')
        .setDescription('View bot usage analytics')
        .addIntegerOption(option =>
            option.setName('days_back')
                .setDescription('Number of days back to display (default: 7)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(30)),

    execute: async function(interaction) {
        const days = interaction.options.getInteger('days_back') || 7;

        await interaction.deferReply({ ephemeral: true });

        try {
            // Log this command usage
            analyticsDB.logCommandUsage(interaction.user.id, 'analytics');

            const data = analyticsDB.getAnalytics(days);

            const embed = new EmbedBuilder()
                .setTitle(`Bot Analytics - Last ${days} Days`)
                .setColor(Colors.Blue)
                .setDescription('Daily usage statistics for the tracker bot.')
                .setTimestamp();

            for (const day of data.reverse()) { // Reverse to show oldest first
                embed.addFields({
                    name: day.date,
                    value: `**Commands Used:** ${day.commands}\n**Unique Users:** ${day.uniqueUsers}\n**New Users:** ${day.newUsers}\n**Runs Uploaded:** ${day.runs}`,
                    inline: true
                });
            }

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in analytics command:', error);
            await interaction.editReply({ content: 'An error occurred while fetching analytics.' });
        }
    }
};