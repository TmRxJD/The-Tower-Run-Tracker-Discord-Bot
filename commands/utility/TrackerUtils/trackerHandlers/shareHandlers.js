// Handlers for sharing run results (Adapted from track_run_old.js)
const { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { userSessions, trackerEmitter } = require('./sharedState.js'); // Added trackerEmitter
const { handleError } = require('./errorHandlers.js');
const { calculateHourlyRates, getNumberSuffix } = require('./trackerHelpers.js'); // Use current helpers
const { createShareEmbed } = require('../trackerUI/trackerUIEmbeds.js');

/**
 * Handles the sharing of a completed run to the current channel.
 * @param {Interaction} interaction - The button interaction object.
 */
async function handleShare(interaction) {
    // This interaction is the one from the Share Button click (shareInteraction from the collector)
    const commandInteractionId = interaction.message?.interaction?.id; // Get original interaction ID if possible
    const userId = interaction.user.id;
    const username = interaction.user.username; // Get username
    const session = userSessions.get(userId);
    console.log(`[Share Handler] Triggered for user ${username} (${userId})`); // Add username

    // Basic session checks
    if (!session || !session.data) {
        console.warn('[Share Handler] Session or run data missing.');
        await interaction.followUp({ content: 'Your session has expired or run data is missing. Cannot share.', ephemeral: true }).catch(()=>{});
        return;
    }
    if (!interaction.channel) {
        console.error('[Share Handler] Interaction channel missing.');
         // Cannot send message without channel
         await interaction.followUp({ content: 'Cannot find channel to share message in.', ephemeral: true }).catch(()=>{});
        return;
    }

    try {
        // --- Get data from session --- 
        const runData = session.data;
        const runId = runData?.runId; // Get runId from session data
        // Add +1 to runCount for share embed
        const runCount = (session.cachedRunData?.allRuns?.length || 0) + 1;
        const runTypeCounts = session?.cachedRunData?.runTypeCounts || {};
        // --- End Get data from session ---

        // --- Update in-memory cache with the new run if not present ---
        if (runId && session.cachedRunData) {
            const alreadyExists = session.cachedRunData.allRuns?.some(r => r.runId === runId || r.id === runId);
            if (!alreadyExists) {
                const newRun = { ...runData, runId, id: runId };
                session.cachedRunData.allRuns = session.cachedRunData.allRuns || [];
                session.cachedRunData.allRuns.unshift(newRun); // Add to front for recency
                session.cachedRunData.lastRun = newRun;
            }
        }

        if (!runId) {
            console.error('[Share Handler] Could not find runId in session data.');
            await interaction.followUp({ content: 'Could not find the run ID to share. Please try again.', ephemeral: true }).catch(()=>{});
            return;
        }
        const user = interaction.user;
        // Calculate stats and create the embed to share
        const stats = calculateHourlyRates(runData.duration || runData.roundDuration, runData);
        const shareEmbed = createShareEmbed(
            interaction.member?.displayName || interaction.user.username,
            runData,
            runCount,
            'https://the-tower-run-tracker.com/',
            !!session.screenshotAttachment,
            userSessions.get(userId)?.settings?.decimalPreference || 'Period (.)',
            runTypeCounts,
            user,
            // Default to false if not set, but always pass a boolean
            Boolean(userSessions.get(userId)?.settings?.shareNotes) // Pass shareNotes setting as boolean
        );
        const shareOptions = { embeds: [shareEmbed] };
        const hasScreenshot = !!session.screenshotAttachment;
        if (hasScreenshot && session.screenshotAttachment?.url) {
            shareOptions.files = [{ attachment: session.screenshotAttachment.url, name: 'screenshot.png' }];
            shareEmbed.setImage('attachment://screenshot.png'); 
        }

        // Send the separate share message to the channel
        console.log('[Share Handler] Sending share message to channel.');
        await interaction.channel.send(shareOptions);
        console.log('[Share Handler] Share message sent successfully.');

        // --- Mark this run as shared in the session so main menu disables share button ---
        if (session && runId) {
            session.lastRunShared = true;
            userSessions.set(userId, session);
        }

    } catch (error) {
        console.error('[Share Handler] Error sending share message:', error);
        // Use ephemeral reply/followUp for errors
        const errorContent = 'An error occurred while trying to share the run.';
        try {
             if (interaction.replied || interaction.deferred) {
                 if (interaction.editable) {
                     await interaction.followUp({ content: errorContent, ephemeral: true });
                 }
             } else {
                 // Should be deferred, so followUp is likely needed
                 await interaction.followUp({ content: errorContent, ephemeral: true });
             }
        } catch (replyError) {
            console.error('[Share Handler] Failed to send error reply:', replyError);
        }
        // Optionally emit global error if needed, but maybe handled by caller?
        // if (commandInteractionId) {
        //     trackerEmitter.emit(`error_${commandInteractionId}`, interaction, error);
        // }
    }
}

module.exports = {
    handleShare
};