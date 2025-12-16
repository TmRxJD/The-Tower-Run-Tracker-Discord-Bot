// Slash command to update roles for all or a specific user based on their web tracker run count
const { SlashCommandBuilder, EmbedBuilder, Colors } = require('discord.js');
const { userSessions } = require('./TrackerUtils/trackerHandlers/sharedState');
const fs = require('fs');
const path = require('path');
const { getRoleThresholdsFromConfig } = require('./TrackerUtils/trackerHandlers/logHandlers');
const CONFIG_PATH = path.join(__dirname, './TrackerUtils/trackerConfig.json');
let config = { roleIds: {}, successLogChannelId: null };
const trackerAPI = require('./TrackerUtils/trackerHandlers/trackerAPI');
const sheetHandlers = require('./TrackerUtils/trackerHandlers/sheetHandlers');

try {
    if (fs.existsSync(CONFIG_PATH)) {
        const rawData = fs.readFileSync(CONFIG_PATH, 'utf-8');
        config = JSON.parse(rawData);
        console.log(`[updateRoles] Loaded config from ${CONFIG_PATH}`);
    }
} catch (e) {
    console.error(`[updateRoles] Failed to load config from ${CONFIG_PATH}:`, e);
    // fallback to default config
}

// Standalone role update function for this command
async function updateMemberRoles(guild, user, runCount, config) {
    let configChanged = false;
    const roleThresholds = getRoleThresholdsFromConfig(config.roleIds);
    const allTrackerRoleIds = Object.values(config.roleIds);
    console.log(`[updateRoles] Checking/creating roles for user ${user.tag} (${user.id}), runCount: ${runCount}`);

    // --- Ensure Roles Exist ---
    const roleCreationPromises = [];
    for (const roleInfo of roleThresholds) {
        let existingRole = guild.roles.cache.get(roleInfo.id);
        if (!existingRole || roleInfo.id.startsWith('ROLE_ID_HERE')) {
            existingRole = guild.roles.cache.find(role => role.name === roleInfo.name);
            if (existingRole) {
                config.roleIds[roleInfo.name] = existingRole.id;
                roleInfo.id = existingRole.id;
                configChanged = true;
                console.log(`[updateRoles] Matched existing role by name: ${roleInfo.name} -> ${existingRole.id}`);
            }
        }
        if (!existingRole) {
            console.log(`[updateRoles] Creating missing role: ${roleInfo.name}`);
            roleCreationPromises.push(
                guild.roles.create({
                    name: roleInfo.name,
                    hoist: true,
                    mentionable: false,
                    reason: 'Auto-created role for Tower Run Tracker stats'
                }).then(createdRole => {
                    config.roleIds[roleInfo.name] = createdRole.id;
                    roleInfo.id = createdRole.id;
                    configChanged = true;
                    console.log(`[updateRoles] Created role: ${roleInfo.name} -> ${createdRole.id}`);
                }).catch((err) => {
                    console.error(`[updateRoles] Failed to create role ${roleInfo.name}:`, err);
                })
            );
        }
    }
    if (roleCreationPromises.length > 0) {
        await Promise.all(roleCreationPromises);
        if (configChanged) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
            console.log(`[updateRoles] Updated config with new role IDs`);
        }
    }

    // --- End Ensure Roles Exist ---
    // Determine the highest role the user qualifies for using the *derived* thresholds
    let targetRoleId = null;
    const currentAllRoleIds = Object.values(config.roleIds);
    for (const roleInfo of roleThresholds) {
        if (runCount >= roleInfo.count) {
            targetRoleId = roleInfo.id;
            break;
        }
    }
    let member;
    try {
        member = await guild.members.fetch(user.id);
    } catch (err) {
        console.error(`[updateRoles] Could not fetch member ${user.tag} (${user.id}) in guild:`, err);
        throw new Error('Could not fetch member in guild');
    }
    if (!targetRoleId || targetRoleId.startsWith('ROLE_ID_HERE')) {
        // Remove all tracker roles if not qualified
        const rolesToRemove = member.roles.cache.filter(role => currentAllRoleIds.includes(role.id));
        if (rolesToRemove.size > 0) {
            await member.roles.remove(rolesToRemove, 'Run count no longer meets threshold');
            console.log(`[updateRoles] Removed all tracker roles from ${user.tag} (${user.id}) (not qualified)`);
        }
        return { updated: false, removed: rolesToRemove.size };
    }
    const hasTargetRole = member.roles.cache.has(targetRoleId);
    const rolesToRemove = member.roles.cache.filter(
        role => currentAllRoleIds.includes(role.id) && role.id !== targetRoleId
    );
    let rolesUpdated = false;
    if (!hasTargetRole) {
        await member.roles.add(targetRoleId, `Reached ${runCount} tracked runs`);
        rolesUpdated = true;
        console.log(`[updateRoles] Added role ${targetRoleId} to ${user.tag} (${user.id}) for ${runCount} runs`);
    }
    if (rolesToRemove.size > 0) {
        await member.roles.remove(rolesToRemove, `User promoted to role ${targetRoleId}`);
        rolesUpdated = true;
        console.log(`[updateRoles] Removed old tracker roles from ${user.tag} (${user.id})`);
    }
    return { updated: rolesUpdated, removed: rolesToRemove.size };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('update-roles')
        .setDescription('Update run tracker roles for all members or a specific user.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('Specific user to update roles for')
                .setRequired(false)
        ),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const client = interaction.client;
        const guild = interaction.guild;
        const targetUser = interaction.options.getUser('user');
        let membersToCheck = [];
        let report = [];
        let updatedCount = 0;
        let checkedCount = 0;
        let withWebTracker = 0;
        let withSheetTracker = 0;
        let failedCount = 0;
        let failedMembers = [];
        let updatedMembers = [];
        let noWebTracker = [];
        let progressMsg = null;

        if (targetUser) {
            membersToCheck = [targetUser];
            console.log(`[updateRoles] Running for specific user: ${targetUser.tag} (${targetUser.id})`);
        } else {
            // Bulk fetching all members requires the Guild Members privileged intent.
            // To avoid requiring that intent, require an explicit user parameter now.
            await interaction.editReply({ content: 'Bulk member updates are disabled to avoid requiring privileged intents. Please run this command with a `user` option: `/update-roles user:@User`', ephemeral: true });
            return;
        }

        const total = membersToCheck.length;
        let lastProgress = 0;
        let progressEmbed = new EmbedBuilder()
            .setTitle('Updating Tracker Roles')
            .setColor(Colors.Blue)
            .setDescription(`Starting role update for ${total} member(s)...`);
        progressMsg = await interaction.editReply({ embeds: [progressEmbed] });

        for (let i = 0; i < total; i++) {
            const user = membersToCheck[i];
            checkedCount++;
            let runCount = 0;
            let hasWebTracker = false;
            let hasSheetTracker = false;
            let updateResult = null;
            let trackerType = 'Web';
            let userSettings = null;
            try {
                // Try to get user settings (preferably from trackerAPI, fallback to default)
                if (trackerAPI.getUserSettings) {
                    userSettings = await trackerAPI.getUserSettings(user.id);
                    trackerType = userSettings?.defaultTracker || 'Web';
                    console.log(`[updateRoles] User ${user.tag} (${user.id}) settings:`, userSettings);
                }
            } catch (e) {
                console.warn(`[updateRoles] Failed to get user settings for ${user.tag} (${user.id}), defaulting to Web tracker.`, e);
            }
            try {
                if (trackerType === 'Spreadsheet') {
                    // Use sheetHandlers to get run count from spreadsheet
                    const username = user.username;
                    const sheetData = await sheetHandlers.getSheetData(username);
                    if (sheetData && Array.isArray(sheetData.allRuns)) {
                        runCount = sheetData.allRuns.length;
                        hasSheetTracker = true;
                        withSheetTracker++;
                        console.log(`[updateRoles] User ${user.tag} (${user.id}) run count from Sheet: ${runCount}`);
                    } else {
                        noWebTracker.push(user.tag);
                        console.warn(`[updateRoles] No sheet data for user ${user.tag} (${user.id})`);
                    }
                } else {
                    // Default: use web tracker
                    runCount = await trackerAPI.getTotalRunCount(user.id);
                    if (typeof runCount === 'number' && runCount > 0) {
                        hasWebTracker = true;
                        withWebTracker++;
                        console.log(`[updateRoles] User ${user.tag} (${user.id}) run count from Web: ${runCount}`);
                    } else {
                        noWebTracker.push(user.tag);
                        console.warn(`[updateRoles] No web tracker data for user ${user.tag} (${user.id})`);
                    }
                }
            } catch (err) {
                failedCount++;
                failedMembers.push(`${user.tag} (${user.id}): ${err.message}`);
                console.error(`[updateRoles] Failed to get run count for ${user.tag} (${user.id}):`, err);
                continue;
            }
            if (hasWebTracker || hasSheetTracker) {
                try {
                    const result = await updateMemberRoles(guild, user, runCount, config);
                    if (result.updated) {
                        updatedCount++;
                        updatedMembers.push(`${user.tag} (${user.id}) - ${runCount} runs`);
                        console.log(`[updateRoles] Updated roles for ${user.tag} (${user.id})`);
                    } else if (result.removed > 0) {
                        console.log(`[updateRoles] Removed roles for ${user.tag} (${user.id})`);
                    }
                } catch (err) {
                    failedCount++;
                    failedMembers.push(`${user.tag} (${user.id}): ${err.message}`);
                    console.error(`[updateRoles] Failed to update roles for ${user.tag} (${user.id}):`, err);
                }
            }
            // Update progress every 5% or last member
            const percent = Math.floor(((i + 1) / total) * 100);
            if (percent !== lastProgress || i === total - 1) {
                lastProgress = percent;
                progressEmbed.setDescription(
                    `Progress: **${percent}%**\n
                    Checked: ${checkedCount}/${total}\n
                    With Web Tracker: ${withWebTracker}\n
                    With Sheet Tracker: ${withSheetTracker}\n
                    Roles Updated: ${updatedCount}\n
                    Failures: **${failedCount}**`
                );
                // Always edit the original reply to avoid unknown message errors
                await interaction.editReply({ embeds: [progressEmbed] });
            }
        }

        // Prepare markdown report
        let mdReport = `# Tracker Role Update Report\n\n`;
        mdReport += `**Total Members Checked:** ${membersToCheck.length}\n`;
        mdReport += `**Checked (Processed):** ${checkedCount}\n`;
        mdReport += `**With Web Tracker:** ${withWebTracker}\n`;
        mdReport += `**With Sheet Tracker:** ${withSheetTracker}\n`;
        mdReport += `**Roles Updated:** ${updatedCount}\n`;
        mdReport += `**Failures:** ${failedCount}\n`;
        mdReport += `\n## Updated Members\n`;
        mdReport += updatedMembers.length ? updatedMembers.join('\n') : 'None';
        mdReport += `\n\n## No Web/Sheet Tracker\n`;
        mdReport += noWebTracker.length ? noWebTracker.join('\n') : 'None';
        mdReport += `\n\n## Failures\n`;
        mdReport += failedMembers.length ? failedMembers.join('\n') : 'None';

        // Save report to file
        const reportPath = path.join(__dirname, '../../trackerRoleUpdateReport.md');
        fs.writeFileSync(reportPath, mdReport, 'utf-8');
        console.log(`[updateRoles] Wrote report to ${reportPath}`);

        // Final embed
        const finalEmbed = new EmbedBuilder()
            .setTitle('Tracker Role Update Complete')
            .setColor(Colors.Green)
            .addFields(
                { name: 'Total Members', value: `**${membersToCheck.length}**`, inline: true },
                { name: 'Checked (Processed)', value: `**${checkedCount}**`, inline: true },
                { name: 'With Web Tracker', value: `**${withWebTracker}**`, inline: true },
                { name: 'With Sheet Tracker', value: `**${withSheetTracker}**`, inline: true },
                { name: 'Roles Updated', value: `**${updatedCount}**`, inline: true },
                { name: 'Failures', value: `**${failedCount}**`, inline: true }
            );
        // Always edit the original reply to avoid unknown message errors
        await interaction.editReply({ embeds: [finalEmbed], files: [{ attachment: reportPath, name: 'trackerRoleUpdateReport.md' }] });
        console.log(`[updateRoles] Sent summary embed and report to user`);

        const successLogChannelId = config.successLogChannelId;
        if (!successLogChannelId || successLogChannelId === 'YOUR_SUCCESS_LOG_CHANNEL_ID_HERE') {
            console.warn('[LogSuccess] successLogChannelId is not set in trackerConfig.json. Skipping success log.');
            return;
        }
        try {
            const client = interaction.client;
            const logChannel = await client.channels.fetch(successLogChannelId);

            if (!logChannel || !logChannel.isTextBased()) {
                console.error(`[LogSuccess] Could not find success log channel or it's not text-based: ${successLogChannelId}`);
                return;
            }

            await logChannel.send({
                embeds: [finalEmbed],
                files: [{ attachment: reportPath, name: 'trackerRoleUpdateReport.md' }]
            });

            console.log(`[updateRoles] Sent summary embed and report to log channel (${config.successLogChannelId})`);
        } catch (e) {
            console.error(`[updateRoles] Failed to send report to log channel (${config.successLogChannelId}):`, e);
            // Optionally log error, but don't fail the command
        }
    }
};
