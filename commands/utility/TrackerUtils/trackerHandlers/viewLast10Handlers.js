const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, AttachmentBuilder, StringSelectMenuBuilder } = require('discord.js');
const { userSessions } = require('./sharedState');
const { calculateHourlyRates } = require('./trackerHelpers');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');
const { trackerEmitter } = require('./sharedState');

// --- Notation and average helpers (shared) ---
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

async function renderViewRuns(interaction, runs, count, userId) {
    const selectedRuns = runs.slice(0, count);
    if (selectedRuns.length === 0) {
        const embed = new EmbedBuilder()
            .setTitle('No Runs Found')
            .setDescription('You have no runs to display.')
            .setColor(Colors.Red);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('tracker_main_menu')
                .setLabel('Return to Main Menu')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🏠')
        );
        await interaction.editReply({ embeds: [embed], components: [row], files: [] });
        return;
    }
    // Prepare data for chart
    const labels = selectedRuns.map((run, i) => `#${runs.length - i}`);
    const tiers = selectedRuns.map(run => run.tier || 0);
    const waves = selectedRuns.map(run => run.wave || 0);
    const durations = selectedRuns.map(run => run.duration || run.roundDuration || 0);
    const coins = selectedRuns.map(run => run.totalCoins || run.coins || 0);
    const cells = selectedRuns.map(run => run.totalCells || run.cells || 0);
    const dice = selectedRuns.map(run => run.totalDice || run.rerollShards || run.dice || 0);
    const killedBy = selectedRuns.map(run => run.killedBy || 'Apathy');
    const coinsHr = selectedRuns.map(run => calculateHourlyRates(run.duration || run.roundDuration, run).coinsPerHour || 0);
    const cellsHr = selectedRuns.map(run => calculateHourlyRates(run.duration || run.roundDuration, run).cellsPerHour || 0);
    const diceHr = selectedRuns.map(run => calculateHourlyRates(run.duration || run.roundDuration, run).dicePerHour || 0);
    // Calculate averages
    const avgTiers = formatNumberOutput(avg(selectedRuns.map(run => run.tier || 0)));
    const avgWaves = formatNumberOutput(avg(selectedRuns.map(run => run.wave || 0)));
    const avgDuration = selectedRuns[0].duration || selectedRuns[0].roundDuration || 'N/A';
    const avgCoins = formatNumberOutput(avg(selectedRuns.map(run => run.totalCoins || run.coins || 0)));
    const avgCells = formatNumberOutput(avg(selectedRuns.map(run => run.totalCells || run.cells || 0)));
    const avgDice = formatNumberOutput(avg(selectedRuns.map(run => run.totalDice || run.rerollShards || run.dice || 0)));
    const avgCoinsHr = formatNumberOutput(avg(selectedRuns.map(run => calculateHourlyRates(run.duration || run.roundDuration, run).coinsPerHour || 0)));
    const avgCellsHr = formatNumberOutput(avg(selectedRuns.map(run => calculateHourlyRates(run.duration || run.roundDuration, run).cellsPerHour || 0)));
    const avgDiceHr = formatNumberOutput(avg(selectedRuns.map(run => calculateHourlyRates(run.duration || run.roundDuration, run).dicePerHour || 0)));
    // Chart
    const timelineChartBuffer = await generateTimelineChart(selectedRuns);
    const timelineChartAttachment = new AttachmentBuilder(timelineChartBuffer, { name: 'runs_timeline_chart.png' });

    // Table
    const headers = ['Tier', 'Wave', 'Duration', 'Killed By', 'Coins', 'Cells', 'Dice', 'Coins/Hr', 'Cells/Hr', 'Dice/Hr', 'Date'];
    const colWidths = [70, 70, 90, 120, 90, 90, 90, 90, 90, 90, 120];
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const rowHeight = 38;
    const headerHeight = 44;
    const tableHeight = headerHeight + rowHeight * selectedRuns.length + 10;
    const tableCanvasRaw = createCanvas(tableWidth, tableHeight);
    const ctx = tableCanvasRaw.getContext('2d');
    ctx.fillStyle = '#23272A';
    ctx.fillRect(0, 0, tableWidth, tableHeight);
    ctx.fillStyle = '#18191c';
    ctx.fillRect(0, 0, tableWidth, headerHeight);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight);
    ctx.lineTo(tableWidth, headerHeight);
    ctx.stroke();
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 18px Segoe UI, Arial';
    let x = 0;
    for (let i = 0; i < headers.length; i++) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(headers[i], x + colWidths[i] / 2, headerHeight / 2);
        x += colWidths[i];
    }
    for (let r = 0; r < selectedRuns.length; r++) {
        const y = headerHeight + r * rowHeight;
        ctx.fillStyle = r % 2 === 0 ? '#23272A' : '#18191c';
        ctx.fillRect(0, y, tableWidth, rowHeight);
        ctx.fillStyle = '#e0e0e0';
        ctx.font = '16px Segoe UI, Arial';
        let x = 0;
        const run = selectedRuns[r];
        const duration = run.duration || run.roundDuration || 0;
        const coinsHrVal = calculateHourlyRates(run.duration || run.roundDuration, run).coinsPerHour || '';
        const cellsHrVal = calculateHourlyRates(run.duration || run.roundDuration, run).cellsPerHour || '';
        const diceHrVal = calculateHourlyRates(run.duration || run.roundDuration, run).dicePerHour || '';
        const date = run.date || (run.timestamp ? new Date(run.timestamp).toLocaleDateString() : '');
        const values = [
            formatNumberOutput(run.tier ?? 0),
            formatNumberOutput(run.wave ?? 0),
            duration,
            run.killedBy ?? '',
            formatNumberOutput(run.totalCoins ?? run.coins ?? 0),
            formatNumberOutput(run.totalCells ?? run.cells ?? 0),
            formatNumberOutput(run.totalDice ?? run.rerollShards ?? run.dice ?? 0),
            coinsHrVal ? formatNumberOutput(coinsHrVal, 1) : '',
            cellsHrVal ? formatNumberOutput(cellsHrVal, 1) : '',
            diceHrVal ? formatNumberOutput(diceHrVal, 1) : '',
            date
        ];
        for (let c = 0; c < values.length; c++) {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(values[c]), x + colWidths[c] / 2, y + rowHeight / 2);
            x += colWidths[c];
        }
    }
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    x = 0;
    for (let i = 0; i < colWidths.length; i++) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, tableHeight);
        ctx.stroke();
        x += colWidths[i];
    }
    ctx.beginPath();
    ctx.moveTo(tableWidth - 1, 0);
    ctx.lineTo(tableWidth - 1, tableHeight);
    ctx.stroke();
    for (let r = 0; r <= selectedRuns.length; r++) {
        const y = headerHeight + r * rowHeight;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(tableWidth, y);
        ctx.stroke();
    }
    const tableBuffer = tableCanvasRaw.toBuffer('image/png');
    const tableAttachment = new AttachmentBuilder(tableBuffer, { name: 'runs_table.png' });
    // Embed
    const embed = new EmbedBuilder()
        .setTitle(`View Runs`)
        .setDescription(`View your previous runs and their details.

Below are the averages for the last ${count} runs.`)
        .setColor('#23272A')
        .setImage('attachment://runs_table.png')
        .setThumbnail('attachment://runs_timeline_chart.png')
        .addFields(
            { name: '#️⃣\nTier', value: avgTiers, inline: true },
            { name: '🌊\nWave', value: avgWaves, inline: true },
            { name: '⏱️\nDuration', value: avgDuration, inline: true },
            { name: '🪙\nCoins', value: avgCoins, inline: true },
            { name: '🔋\nCells', value: avgCells, inline: true },
            { name: '🎲\nDice', value: avgDice, inline: true },
            { name: '🪙\nCoins/Hr', value: avgCoinsHr, inline: true },
            { name: '🔋\nCells/Hr', value: avgCellsHr, inline: true },
            { name: '🎲\nDice/Hr', value: avgDiceHr, inline: true }
        );
    // Select menu and buttons
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('tracker_viewruns_select')
        .setPlaceholder(`Viewing last ${count} runs`)
        .addOptions([
            { label: 'Showing Last 5 Runs', value: '5', default: count === 5 },
            { label: 'Showing Last 10 Runs', value: '10', default: count === 10 },
            { label: 'Showing Last 20 Runs', value: '20', default: count === 20 },
            { label: 'Showing Last 35 Runs', value: '35', default: count === 35 },
            { label: 'Showing Last 50 Runs', value: '50', default: count === 50 },
        ]);
    const row1 = new ActionRowBuilder().addComponents(selectMenu);
    const row2 = new ActionRowBuilder().addComponents(
        /*
        new ButtonBuilder()
            .setCustomId('tracker_share_runs')
            .setLabel('Share')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📢'),
        */
        new ButtonBuilder()
            .setCustomId('tracker_main_menu')
            .setLabel('Return to Main Menu')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🏠')
    );
    await interaction.editReply({ embeds: [embed], components: [row1, row2], files: [tableAttachment, timelineChartAttachment] });
}

async function handleViewRuns(interaction, commandInteractionId) {
    const userId = interaction.user.id;
    const session = userSessions.get(userId);
    let runs = session?.cachedRunData?.allRuns || [];
    // Sort runs by date (descending, most recent first)
    runs = runs.slice().sort((a, b) => {
        const aDate = new Date(a.date || a.timestamp || 0);
        const bDate = new Date(b.date || b.timestamp || 0);
        return bDate - aDate;
    });
    // Default to 10 if not specified
    let count = 10;
    // Handle select menu interaction (fix for Discord.js v14+)
    if (interaction.isStringSelectMenu?.() || interaction.isSelectMenu?.()) {
        if (interaction.values && interaction.values[0]) {
            count = parseInt(interaction.values[0], 10) || 10;
        }
    }
    console.log('[DEBUG] commandInteractionId in handleViewRuns:', commandInteractionId);
    await renderViewRuns(interaction, runs, count, userId);

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        filter: i => [
            'tracker_viewruns_select',
            'tracker_share_runs',
            'tracker_main_menu'
        ].includes(i.customId) && i.user.id === userId,
        time: 300000
    });
    collector.on('collect', async i => {
        await i.deferUpdate();
        if (i.customId === 'tracker_viewruns_select') {
            // Update count and re-render UI in-place, do not recurse
            let newCount = 10;
            if (i.values && i.values[0]) {
                newCount = parseInt(i.values[0], 10) || 10;
            }
            await renderViewRuns(i, runs, newCount, userId);
        } else if (i.customId === 'tracker_main_menu') {
            collector.stop();
            trackerEmitter.emit(`navigate_${commandInteractionId}`, 'mainMenu', i);
        } else if (i.customId === 'tracker_share_runs') {
            collector.stop();
            trackerEmitter.emit(`dispatch_${commandInteractionId}`, 'shareRuns', {
                interaction: i,
                session: userSessions.get(userId)
            });
        }
    });
    collector.on('end', async () => {
        try {
            const disabledRow = message.components.map(row => {
                row.components.forEach(c => c.setDisabled(true));
                return row;
            });
            await message.edit({ components: disabledRow });
        } catch (e) { /* ignore edit errors */ }
    });
}

function generateTimelineChart(selectedRuns) {
    // Reverse the order of selectedRuns to ensure the timeline reads left to right
    const reversedRuns = [...selectedRuns].reverse();

    const labels = reversedRuns.map(run => new Date(run.date || run.timestamp).toLocaleDateString());

    // Convert notational data to numerical values for calculations
    const waves = reversedRuns.map(run => parseNumberInput(run.wave || 0));
    const coins = reversedRuns.map(run => parseNumberInput(run.totalCoins || run.coins || 0));
    const cells = reversedRuns.map(run => parseNumberInput(run.totalCells || run.cells || 0));
    const dice = reversedRuns.map(run => parseNumberInput(run.totalDice || run.rerollShards || run.dice || 0));

    const width = 900;
    const height = 500;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: '#23272A' });

    // Calculate dynamic ranges for each dataset
    const calculateRange = (data) => {
        if (data.length === 0) return { min: 0, max: 1 }; // Default range if no data
        const max = Math.max(...data);
        const min = Math.min(...data);
        const rangePadding = (max - min) * 0.25 || max * 0.25; // Add 25% padding or default to 25% of max
        return { min: Math.max(0, min - rangePadding), max: max + rangePadding };
    };

    const wavesRange = calculateRange(waves);
    const coinsRange = calculateRange(coins);
    const cellsRange = calculateRange(cells);
    const diceRange = calculateRange(dice);

    const chartConfig = {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Waves',
                    data: waves,
                    borderColor: 'rgba(54, 162, 235, 1)',
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y'
                },
                {
                    label: 'Coins',
                    data: coins,
                    borderColor: 'rgba(75, 192, 192, 1)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y1'
                },
                {
                    label: 'Cells',
                    data: cells,
                    borderColor: 'rgba(153, 102, 255, 1)',
                    backgroundColor: 'rgba(153, 102, 255, 0.2)',
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y2'
                },
                {
                    label: 'Dice',
                    data: dice,
                    borderColor: 'rgba(255, 159, 64, 1)',
                    backgroundColor: 'rgba(255, 159, 64, 0.2)',
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'y3'
                }
            ]
        },
        options: {
            plugins: {
                legend: { labels: { color: '#e0e0e0' }, position: 'top' },
                title: { display: true, text: 'Timeline of Last Runs', color: '#e0e0e0' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const value = context.raw;
                            return `${context.dataset.label}: ${formatNumberOutput(value)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#b0b0b0' },
                    grid: { color: 'rgba(80,80,80,0.3)' }
                },
                y: {
                    type: 'linear',
                    position: 'left',
                    title: { display: true, text: 'Waves', color: '#54a2eb' },
                    ticks: {
                        color: '#54a2eb',
                        callback: function(value) {
                            return formatNumberOutput(value);
                        }
                    },
                    grid: { color: 'rgba(80,80,80,0.3)' },
                    min: wavesRange.min,
                    max: wavesRange.max
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    title: { display: true, text: 'Coins', color: '#4bc0c0' },
                    ticks: {
                        color: '#4bc0c0',
                        callback: function(value) {
                            return formatNumberOutput(value);
                        }
                    },
                    grid: { drawOnChartArea: false },
                    min: coinsRange.min,
                    max: coinsRange.max
                },
                y2: {
                    type: 'linear',
                    position: 'left',
                    offset: true,
                    title: { display: true, text: 'Cells', color: '#9966ff' },
                    ticks: {
                        color: '#9966ff',
                        callback: function(value) {
                            return formatNumberOutput(value);
                        }
                    },
                    grid: { drawOnChartArea: false },
                    min: cellsRange.min,
                    max: cellsRange.max
                },
                y3: {
                    type: 'linear',
                    position: 'right',
                    offset: true,
                    title: { display: true, text: 'Dice', color: '#ff9f40' },
                    ticks: {
                        color: '#ff9f40',
                        callback: function(value) {
                            return formatNumberOutput(value);
                        }
                    },
                    grid: { drawOnChartArea: false },
                    min: diceRange.min,
                    max: diceRange.max
                }
            }
        }
    };
    return chartJSNodeCanvas.renderToBuffer(chartConfig);
}

module.exports = { handleViewRuns };