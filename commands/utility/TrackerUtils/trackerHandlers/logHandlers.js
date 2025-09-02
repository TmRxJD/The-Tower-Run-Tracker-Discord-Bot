// Handlers for logging tracker events
const { EmbedBuilder, Colors } = require('discord.js');
const { getNumberSuffix, calculateHourlyRates } = require('./trackerHelpers.js'); // Import helpers
const fs = require('fs');
const path = require('path');
const { userSessions } = require('./sharedState.js');

// --- Configuration Loading ---
const CONFIG_PATH = path.join(__dirname, '..', 'trackerConfig.json'); // Path to config relative to this file's parent

let config = { roleIds: {}, successLogChannelId: null }; // Default config

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const rawData = fs.readFileSync(CONFIG_PATH, 'utf-8');
            config = JSON.parse(rawData);
            console.log('[Config] Loaded trackerConfig.json successfully.');
            // Basic validation
            if (!config.roleIds || typeof config.roleIds !== 'object') {
                console.warn('[Config] roleIds missing or invalid in config, resetting.');
                config.roleIds = {};
            }
            if (!config.successLogChannelId) {
                 console.warn('[Config] successLogChannelId missing in config.');
                 config.successLogChannelId = null;
            }
        } else {
            console.warn(`[Config] trackerConfig.json not found at ${CONFIG_PATH}. Using default values. Please ensure the file exists.`);
            // Save default config if file doesn't exist? Or require manual creation?
            // For now, just use defaults.
        }
    } catch (error) {
        console.error('[Config] Error loading trackerConfig.json:', error);
        // Fallback to default config on error
        config = { roleIds: {}, successLogChannelId: null };
    }
    return config;
}

function saveConfig(newConfig) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
        console.log('[Config] Saved updated trackerConfig.json successfully.');
        config = newConfig; // Update in-memory config
    } catch (error) {
        console.error('[Config] Error saving trackerConfig.json:', error);
    }
}

// Load config when module initializes
loadConfig();
// --- End Configuration Loading ---

// --- Role Threshold Derivation ---
function getRoleThresholdsFromConfig(roleIdConfig) {
    const thresholds = [];
    for (const name in roleIdConfig) {
        const id = roleIdConfig[name];
        // Attempt to parse count from the name (e.g., "100 Runs Tracked")
        const match = name.match(/^(\d+)\s+Runs/);
        // Special case for "Run Tracker"
        let count = 1;
        if (name === 'Run Tracker') {
            count = 1;
        } else if (match && match[1]) {
            count = parseInt(match[1], 10);
        } else {
            console.warn(`[Config] Could not parse run count from role name: "${name}". Defaulting to 1.`);
            count = 1; // Default or skip? Defaulting to 1 for now.
        }

        if (!isNaN(count)) {
            thresholds.push({ count, name, id });
        }
    }
    // Sort descending by count
    return thresholds.sort((a, b) => b.count - a.count);
}
// --- End Role Threshold Derivation ---


/**
 * Logs details of a successful run to a dedicated channel.
 * Adapted from track_run_old.js
 * @param {Interaction} interaction - The interaction object (to get client, user).
 * @param {object} runData - The data for the run that was logged/edited.
 * @param {number} runCount - The user's total run count *after* this run.
 * @param {string} webLink - The static link to the web tracker.
 * @param {object|null} attachment - Screenshot attachment object (optional, needs .url property if provided).
 */
async function logSuccessfulRun(interaction, runData, runCount, webLink, attachment = null, runTypeCounts = {}) {
    const userId = interaction.user.id;
    const session = userSessions.get(userId);
    const trackerType = session.settings?.defaultTracker || 'Web';
    
    // Use channel ID from loaded config
    const successLogChannelId = '1344016135498240130';
    if (!successLogChannelId || successLogChannelId === 'YOUR_SUCCESS_LOG_CHANNEL_ID_HERE') {
        console.warn('[LogSuccess] successLogChannelId is not set in trackerConfig.json. Skipping success log.');
        return;
    }

    try {
        const client = interaction.client;
        const user = interaction.user;

        const logChannel = await client.channels.fetch(successLogChannelId);
        if (!logChannel || !logChannel.isTextBased()) {
            console.error(`[LogSuccess] Could not find success log channel or it's not text-based: ${successLogChannelId}`);
            return;
        }

        // --- Calculate Hourly Rates --- 
        const stats = calculateHourlyRates(runData.roundDuration, runData);
        // --- End Calculate Hourly Rates ---

        // Determine run type for title
    const runType = runData?.type
        ? runData.type.charAt(0).toUpperCase() + runData.type.slice(1)
        : 'Farming'; // Default if type somehow missing
    const typeCount = runTypeCounts && runTypeCounts[runType] ? runTypeCounts[runType] : 0;
    const title = `${runType} Run #${typeCount}`;

        const logEmbed = new EmbedBuilder()
            .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
            .setTitle(title)
            .setDescription(`Run successfully logged for <@${user.id}>`) 
            .setColor(Colors.Green)
            .setTimestamp()
            .setURL(webLink)
            .addFields(
                { name: '#️⃣\nTier|Wave', value: String(runData.tier || 'N/A') + ' | ' + String(runData.wave || 'N/A'), inline: true },
                { name: '⏱️\nDuration', value: String(runData.roundDuration || 'N/A'), inline: true },
                { name: '⚔️\nKilled By', value: String(runData.killedBy || 'N/A'), inline: true },
                { name: '💰\nCoins/hr', value: String(stats.coinsPerHour || 'N/A'), inline: true }, 
                { name: '🔋\nCells/hr', value: String(stats.cellsPerHour || 'N/A'), inline: true }, 
                { name: '🎲\nDice/hr', value: String(stats.dicePerHour || 'N/A'), inline: true },               
                { name: '📋\nRun Type', value: String(runData.type || 'N/A'), inline: true },
                { name: '🗓️\nDate', value: String(runData.date || 'N/A'), inline: true },
                { name: '⏰\nTime', value: String(runData.time || 'N/A'), inline: true }                          
            );

        // Add notes if present
        if (runData.notes && runData.notes.length > 0) {
            logEmbed.addFields({ name: '📝\nNotes', value: String(runData.notes || 'N/A'), inline: false });
        }

        // Add logic to include a link to the user's specific sheet if they log to a sheet
        if (trackerType === 'Spreadsheet') {
            const sheetLink = await getSpreadsheetLink(user.username);
            logEmbed.addFields({ name: '📄\nSpreadsheet Link', value: `[View Sheet](${sheetLink})`, inline: false });
        }

        const logMessageOptions = { embeds: [logEmbed] };

        if (attachment?.url) {
            logEmbed.setThumbnail(attachment.url);
            // Note: Discord embeds can directly display image URLs in thumbnails/images.
        }

        await logChannel.send(logMessageOptions);
        console.log(`[LogSuccess] Successfully logged run for ${user.username} (${user.id}) to channel ${successLogChannelId}`);

        // --- Handle Role Assignment (Pass current config) ---
        await updateUserRoles(interaction, runCount, config); // Pass config
        // --- End Handle Role Assignment ---

    } catch (error) {
        console.error(`[LogSuccess] Failed to log successful run for user ${interaction.user.id}:`, error);
    }
}

/**
 * Updates the user's roles based on their total run count.
 * Always updates roles in the designated run tracker server, regardless of where the command was used.
 * Attempts to create roles defined in config if they don't exist and saves new IDs.
 * @param {Interaction} interaction - The interaction object.
 * @param {number} runCount - The user's current total run count.
 * @param {object} currentConfig - The currently loaded configuration object.
 */
async function updateUserRoles(interaction, runCount, currentConfig) {
    // Always use the designated run tracker server for role updates
    const RUN_TRACKER_GUILD_ID = '1343406545920196608';
    if (!RUN_TRACKER_GUILD_ID) {
        console.error('[UpdateRoles] RUN_TRACKER_GUILD_ID is not set in config or environment. Skipping role update.');
        return;
    }

    const client = interaction.client;
    let guild;
    try {
        guild = await client.guilds.fetch(RUN_TRACKER_GUILD_ID);
    } catch (err) {
        console.error(`[UpdateRoles] Could not fetch run tracker guild (${RUN_TRACKER_GUILD_ID}):`, err);
        return;
    }

    let member;
    try {
        member = await guild.members.fetch(interaction.user.id);
    } catch (err) {
        console.error(`[UpdateRoles] Could not fetch member ${interaction.user.id} in run tracker guild:`, err);
        return;
    }

    let configChanged = false; // Flag to track if we need to save the config
    const roleThresholds = getRoleThresholdsFromConfig(currentConfig.roleIds);
    const allTrackerRoleIds = Object.values(currentConfig.roleIds);

    // --- Ensure Roles Exist ---
    const roleCreationPromises = [];
    for (const roleInfo of roleThresholds) {
        let existingRole = guild.roles.cache.get(roleInfo.id);
        if (!existingRole || roleInfo.id.startsWith('ROLE_ID_HERE')) {
            existingRole = guild.roles.cache.find(role => role.name === roleInfo.name);
            if (existingRole) {
                currentConfig.roleIds[roleInfo.name] = existingRole.id;
                roleInfo.id = existingRole.id;
                configChanged = true;
            }
        }
        if (!existingRole) {
            console.log(`[UpdateRoles] Role '${roleInfo.name}' not found. Attempting to create...`);
            roleCreationPromises.push(
                guild.roles.create({
                    name: roleInfo.name,
                    hoist: true,
                    mentionable: false,
                    reason: 'Auto-created role for Tower Run Tracker stats'
                }).then(createdRole => {
                    console.log(`[UpdateRoles] Successfully created role '${createdRole.name}' with ID ${createdRole.id}.`);
                    currentConfig.roleIds[roleInfo.name] = createdRole.id;
                    roleInfo.id = createdRole.id;
                    configChanged = true;
                }).catch(createError => {
                    console.error(`[UpdateRoles] Failed to create role '${roleInfo.name}':`, createError.message);
                    if (createError.code === 50013) {
                        console.error('[UpdateRoles] Bot is missing "Manage Roles" permission for role creation.');
                    }
                })
            );
        }
    }
    if (roleCreationPromises.length > 0) {
        await Promise.all(roleCreationPromises);
        if (configChanged) {
            saveConfig(currentConfig);
            console.log('[UpdateRoles] Saved config file after role creation/ID updates.');
        }
    }
    // --- End Ensure Roles Exist ---

    // Determine the highest role the user qualifies for using the *derived* thresholds
    let targetRoleId = null;
    const currentAllRoleIds = Object.values(currentConfig.roleIds);
    for (const roleInfo of roleThresholds) {
        if (runCount >= roleInfo.count) {
            targetRoleId = roleInfo.id;
            break;
        }
    }
    if (!targetRoleId || targetRoleId.startsWith('ROLE_ID_HERE')) {
        console.log(`[UpdateRoles] User ${member.user.username} (${runCount} runs) doesn't qualify for any specific role or target role ID is placeholder/invalid.`);
        const rolesToRemove = member.roles.cache.filter(role => currentAllRoleIds.includes(role.id));
        if (rolesToRemove.size > 0) {
            await member.roles.remove(rolesToRemove, 'Run count no longer meets threshold');
            console.log(`[UpdateRoles] Removed ${rolesToRemove.size} tracker roles from ${member.user.username}.`);
        }
        return;
    }
    const hasTargetRole = member.roles.cache.has(targetRoleId);
    const rolesToRemove = member.roles.cache.filter(
        role => currentAllRoleIds.includes(role.id) && role.id !== targetRoleId
    );
    let rolesUpdated = false;
    if (!hasTargetRole) {
        try {
            const targetRoleInfo = roleThresholds.find(r => r.id === targetRoleId);
            const targetRoleName = targetRoleInfo ? targetRoleInfo.name : 'Unknown Role';
            await member.roles.add(targetRoleId, `Reached ${runCount} tracked runs`);
            console.log(`[UpdateRoles] Added role ${targetRoleName} (${targetRoleId}) to ${member.user.username}`);
            rolesUpdated = true;
        } catch (addError) {
            console.error(`[UpdateRoles] Failed to add role ${targetRoleId} to ${member.user.username}:`, addError.message);
            if (addError.code === 50013) {
                console.error('[UpdateRoles] Bot is missing "Manage Roles" permission.');
            }
        }
    }
    if (rolesToRemove.size > 0) {
        try {
            await member.roles.remove(rolesToRemove, `User promoted to role ${targetRoleId}`);
            console.log(`[UpdateRoles] Removed ${rolesToRemove.size} other tracker roles from ${member.user.username}`);
            rolesUpdated = true;
        } catch (removeError) {
            console.error(`[UpdateRoles] Failed to remove roles from ${member.user.username}:`, removeError.message);
            if (removeError.code === 50013) {
                console.error('[UpdateRoles] Bot is missing "Manage Roles" permission.');
            }
        }
    }
    if (!rolesUpdated && hasTargetRole) {
        const targetRoleInfo = roleThresholds.find(r => r.id === targetRoleId);
        const targetRoleName = targetRoleInfo ? targetRoleInfo.name : 'Unknown Role';
        console.log(`[UpdateRoles] User ${member.user.username} already has the correct role: ${targetRoleName} (${targetRoleId}). No changes needed.`);
    }
}

module.exports = {
    logSuccessfulRun,
    getRoleThresholdsFromConfig,
    // Don't export updateUserRoles directly if it's only used internally
};