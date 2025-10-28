// Error handlers for tracker
const { EmbedBuilder, Colors, AttachmentBuilder } = require('discord.js');
require('dotenv').config(); // Ensure dotenv is configured

// Get Error Log Channel ID from environment variables
const ERROR_LOG_CHANNEL_ID = '1344016216087592960'; 

/**
 * Helper to send an error embed to the error log channel
 */
async function handleError({ client, user, error, context, ocrOutput = null, attachmentUrl = null }) {
    try {
        const errorChannel = await client.channels.fetch(ERROR_LOG_CHANNEL_ID).catch(() => null);
        if (!errorChannel) {
            console.error(`Error log channel ${ERROR_LOG_CHANNEL_ID} not found or bot lacks permission.`);
            return;
        }
        const errorEmbed = new EmbedBuilder()
            .setTitle('🤖 Bot Error Log')
            .setDescription(`An error occurred for user **${user?.tag || 'Unknown User'}** (<@${user?.id || 'Unknown ID'}>).
\n**Context:**\n\`\`\`${context}\`\`\`\n\n**Error Message:**\n\`\`\`${String(error?.message || error).substring(0, 1000)}\`\`\``)
            .setColor(Colors.DarkRed)
            .setTimestamp();
        if (ocrOutput && Array.isArray(ocrOutput) && ocrOutput.length > 0) {
            const ocrText = ocrOutput.map(line => typeof line === 'object' ? line.text : String(line)).join('\n').substring(0, 1020);
            errorEmbed.addFields({ name: 'OCR Output (Raw)', value: `\`\`\`\n${ocrText}\n\`\`\``, inline: false });
        }
        if (attachmentUrl) {
            try {
                const attachment = new AttachmentBuilder(attachmentUrl);
                errorEmbed.setImage(`attachment://${attachment.name || 'error_image.png'}`);
                await errorChannel.send({ embeds: [errorEmbed], files: [attachment] });
                return;
            } catch (attachError) {
                console.error('Failed to create attachment for error log:', attachError);
                errorEmbed.addFields({ name: 'Attachment Error', value: `Failed to attach: ${attachmentUrl}` });
            }
        }
        await errorChannel.send({ embeds: [errorEmbed] });
    } catch (logErrorError) {
        console.error('Failed to log error to the designated channel:', logErrorError);
    }
}

/**
 * Handle errors in the tracker by replying to the user
 * @param {Interaction} interaction - Discord interaction
 * @param {any} [ocrOutput=null] - Optional raw OCR output (e.g., array of lines)
 * @param {string} [attachmentUrl=null] - Optional URL of the related attachment
 */
async function logError(client, user, error, context, ocrOutput = null, attachmentUrl = null) {
    console.log(`[DETAILED ERROR LOG] User: ${user?.id || 'Unknown'}, Context: ${context}`, error);

    if (!ERROR_LOG_CHANNEL_ID) {
        console.error('ERROR_LOG_CHANNEL_ID is not set in .env file. Cannot log error to channel.');
        return;
    }

    try {
        const errorChannel = await client.channels.fetch(ERROR_LOG_CHANNEL_ID).catch(() => null);
        if (!errorChannel) {
            console.error(`Error log channel ${ERROR_LOG_CHANNEL_ID} not found or bot lacks permission.`);
            return;
        }

        const errorEmbed = new EmbedBuilder()
            .setTitle('🤖 Bot Error Log')
            .setDescription(`An error occurred for user **${user?.tag || 'Unknown User'}** (<@${user?.id || 'Unknown ID'}>).\n\n**Context:**\n\`\`\`${context}\`\`\`\n\n**Error Message:**\n\`\`\`${String(error?.message || error).substring(0, 1000)}\`\`\`\n\n**Stack Trace:**\n\`\`\`${String(error?.stack).substring(0, 1000)}\`\`\``)
            .setColor(Colors.DarkRed)
            .setTimestamp();

        if (ocrOutput && Array.isArray(ocrOutput) && ocrOutput.length > 0) {
            const ocrText = ocrOutput.map(line => typeof line === 'object' ? line.text : String(line)).join('\n').substring(0, 1020);
            errorEmbed.addFields({ name: 'OCR Output (Raw)', value: `\`\`\`\n${ocrText}\n\`\`\``, inline: false });
        }

        const messageOptions = { embeds: [errorEmbed] };

        if (attachmentUrl) {
            try {
                // Use AttachmentBuilder for sending files from URLs
                const attachment = new AttachmentBuilder(attachmentUrl);
                messageOptions.files = [attachment];
                // Attempt to set image in embed - may fail if URL becomes invalid quickly
                errorEmbed.setImage(`attachment://${attachment.name || 'error_image.png'}`);
            } catch (attachError) {
                console.error('Failed to create attachment for error log:', attachError);
                errorEmbed.addFields({ name: 'Attachment Error', value: `Failed to attach: ${attachmentUrl}` });
            }
        }

        await errorChannel.send(messageOptions);

    } catch (logErrorError) {
        console.error('Failed to log error to the designated channel:', logErrorError);
    }
}

module.exports = {
    handleError,
    logError // Export the added function
};