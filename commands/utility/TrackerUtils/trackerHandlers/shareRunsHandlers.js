// Handler for sharing the last N runs summary (mimics View Runs UI)
const { EmbedBuilder, Colors, AttachmentBuilder } = require('discord.js');
const { userSessions } = require('./sharedState');
const { calculateHourlyRates, parseNumberInput, NOTATIONS, avg, formatNumberForDisplay } = require('./trackerHelpers');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');

// --- Notation and average helpers (shared) ---

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
        const duration = run.duration || run.roundDuration || 'N/A';
        const coins = parseNumberInput(run.totalCoins || run.coins || 0);
        const cells = parseNumberInput(run.totalCells || run.cells || 0);
        const dice = parseNumberInput(run.totalDice || run.rerollShards || run.dice || 0);
        let coinsHr = duration !== 'N/A' ? calculateHourlyRates(duration, run).coinsPerHour : 'N/A';
        if (coinsHr !== 'N/A' && !/[KMBTqQsSOND]|A[A-J]/.test(coinsHr)) coinsHr += 'K';
        let cellsHr = duration !== 'N/A' ? calculateHourlyRates(duration, run).cellsPerHour : 'N/A';
        if (cellsHr !== 'N/A' && !/[KMBTqQsSOND]|A[A-J]/.test(cellsHr)) cellsHr += 'K';
        let diceHr = duration !== 'N/A' ? calculateHourlyRates(duration, run).dicePerHour : 'N/A';
        if (diceHr !== 'N/A' && !/[KMBTqQsSOND]|A[A-J]/.test(diceHr)) diceHr += 'K';
        embed.addFields({
            name: `Run #${index + 1}`,
            value: `Tier: ${run.tier || 'N/A'}, Wave: ${run.wave || 'N/A'}, Duration: ${duration}\nCoins: ${formatNumberForDisplay(coins)}, Cells: ${formatNumberForDisplay(cells)}, Dice: ${formatNumberForDisplay(dice)}\nCoins/Hr: ${coinsHr}, Cells/Hr: ${cellsHr}, Dice/Hr: ${diceHr}`,
            inline: false
        });
    });

    // Send the embed as a message
    await interaction.channel.send({ embeds: [embed] });
}

module.exports = { handleShareRuns };