// Handler for sharing the last N runs summary (mimics View Runs UI)
const { EmbedBuilder, Colors, AttachmentBuilder } = require('discord.js');
const { userSessions } = require('./sharedState');
const { calculateHourlyRates } = require('./trackerHelpers');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');

// --- Notation and average helpers (shared, copy from viewLast10Handlers.js) ---
const NOTATIONS = {
    K: 1e3, M: 1e6, B: 1e9, T: 1e12, q: 1e15, Q: 1e18, s: 1e21, S: 1e24, O: 1e27, N: 1e30, D: 1e33,
    AA: 1e36, AB: 1e39, AC: 1e42, AD: 1e45, AE: 1e48, AF: 1e51, AG: 1e54, AH: 1e57, AI: 1e60, AJ: 1e63
};
function parseNumberInput(input) {
    if (typeof input === 'number') return input;
    const inputStr = String(input).replace(/,/g, '').trim();
    const match = inputStr.match(/^(\d+|\d*\.\d+)([KMBTqQsSOND]|A[A-J])?$/);
    if (!match) {
        const number = parseFloat(inputStr);
        if (!isNaN(number)) return number;
        return 0;
    }
    const [_, numberPart, notation] = match;
    const number = parseFloat(numberPart);
    if (isNaN(number)) return 0;
    if (!notation) return number;
    const multiplier = NOTATIONS[notation];
    if (!multiplier) return number;
    return number * multiplier;
}
function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + parseNumberInput(b), 0) / arr.length;
}
function formatNumberOutput(number, precision = 2) {
    if (typeof number !== 'number' || isNaN(number)) return String(number);
    if (number < 1000) return Math.round(number).toString();
    const notationEntries = Object.entries(NOTATIONS).reverse();
    for (const [notation, value] of notationEntries) {
        if (number >= value) {
            return (number / value).toFixed(precision) + notation;
        }
    }
    return number.toString();
}

async function handleShareRuns(eventInteraction) {
    console.log('[DEBUG] Received eventInteraction in handleShareRuns:', eventInteraction);
    // Extract interaction and session from eventInteraction
    const { interaction, session } = eventInteraction;

    // Validate interaction and session
    if (!interaction || !interaction.user || !session) {
        throw new Error('Invalid interaction or session object in handleShareRuns.');
    }

    // Fetch runs from the session
    const runs = session?.cachedRunData?.allRuns || [];
    if (runs.length === 0) {
        await interaction.reply({ content: 'No runs available to share.', ephemeral: true });
        return;
    }

    // Sort and limit the runs
    const count = session?.lastViewRunsCount || 10;
    const selectedRuns = runs.slice(0, count);

    // Create an embed for the runs summary
    const embed = new EmbedBuilder()
        .setTitle('Shared Runs Summary')
        .setDescription(`Here are the last ${count} runs:`)
        .setColor(Colors.Blue);

    selectedRuns.forEach((run, index) => {
        embed.addFields({
            name: `Run #${index + 1}`,
            value: `Tier: ${run.tier || 'N/A'}, Wave: ${run.wave || 'N/A'}, Duration: ${run.duration || 'N/A'}, Coins: ${run.totalCoins || 'N/A'}, Cells: ${run.totalCells || 'N/A'}, Dice: ${run.totalDice || 'N/A'}`,
            inline: false
        });
    });

    // Send the embed as a message
    await interaction.channel.send({ embeds: [embed] });
}

module.exports = { handleShareRuns };