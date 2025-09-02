const { SlashCommandBuilder, EmbedBuilder, Colors } = require('discord.js');
const { migrateUserData } = require('./TrackerUtils/trackerHandlers/migrateToNewTracker.js');

module.exports = {
    data: new SlashCommandBuilder()
    .setName('migrate_user_tracker')
    .setDescription('Migrate tracker data for a specific user')
    .addUserOption(option =>
        option.setName('user')
            .setDescription('Select the Discord user to migrate')
            .setRequired(true)
    ),
    
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const userId = user.id;
        const username = user.username;
        await interaction.deferReply({ ephemeral: true });
        try {
            await migrateUserData(userId, username, interaction);
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Migration Complete')
                        .setDescription(`Migration for user <@${userId}> (${username}) is complete.`)
                        .setColor(Colors.Green)
                ]
            });
        } catch (error) {
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('Migration Failed')
                        .setDescription(`Migration for user <@${userId}> (${username}) failed.\nError: ${error.message}`)
                        .setColor(Colors.Red)
                ]
            });
        }
    }
};
