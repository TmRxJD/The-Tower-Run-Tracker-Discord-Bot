const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, AttachmentBuilder, StringSelectMenuBuilder } = require('discord.js');
const { userSessions } = require('./sharedState');
const { calculateHourlyRates, formatNumberForDisplay, formatRateWithNotation, parseNumberInput, NOTATIONS, avg } = require('./trackerHelpers');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');
const { trackerEmitter } = require('./sharedState');
const { loadSetting, saveSetting, loadAllSettings, saveMultipleSettings } = require('./settingsDB');

// --- Notation and average helpers (shared) ---

async function renderViewRuns(interaction, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset) {
    // Define available columns
    const allColumns = {
        'Tier': { width: 70, getValue: (run) => formatNumberForDisplay(run.tier ?? 0) },
        'Wave': { width: 70, getValue: (run) => String(run.wave ?? 0) },
        'Duration': { width: 90, getValue: (run) => run.duration || run.roundDuration || 0 },
        'Killed By': { width: 120, getValue: (run) => run.killedBy ?? '' },
        'Coins': { width: 90, getValue: (run) => formatNumberForDisplay(parseNumberInput(run.totalCoins ?? run.coins ?? 0)) },
        'Cells': { width: 90, getValue: (run) => formatNumberForDisplay(parseNumberInput(run.totalCells ?? run.cells ?? 0)) },
        'Dice': { width: 90, getValue: (run) => formatNumberForDisplay(parseNumberInput(run.totalDice ?? run.rerollShards ?? run.dice ?? 0)) },
        'Coins/Hr': { width: 90, getValue: (run) => {
            const val = calculateHourlyRates(run.duration || run.roundDuration, run).coinsPerHour || '';
            let d = val; if (!/[KMBTqQsSOND]|A[A-J]/.test(d)) d += 'K'; return d;
        }},
        'Cells/Hr': { width: 90, getValue: (run) => {
            const val = calculateHourlyRates(run.duration || run.roundDuration, run).cellsPerHour || '';
            let d = val; if (!/[KMBTqQsSOND]|A[A-J]/.test(d)) d += 'K'; return d;
        }},
        'Dice/Hr': { width: 90, getValue: (run) => {
            const val = calculateHourlyRates(run.duration || run.roundDuration, run).dicePerHour || '';
            let d = val; if (!/[KMBTqQsSOND]|A[A-J]/.test(d)) d += 'K'; return d;
        }},
        'Date': { width: 120, getValue: (run) => run.date || (run.timestamp ? new Date(run.timestamp).toLocaleDateString() : '') }
    };

    // Compute available options based on current selections
    const availableTypes = [...new Set(runs.filter(run => selectedTiers.includes('All') || selectedTiers.includes(String(run.tier))).map(run => run.type || 'Farming'))].sort();
    selectedTypes = selectedTypes.filter(t => availableTypes.includes(t));
    if (selectedTypes.length === 0) selectedTypes = availableTypes;
    if (session) session.viewRunsSelectedTypes = selectedTypes;

    const availableTiers = [...new Set(runs.filter(run => selectedTypes.includes(run.type || 'Farming') && run.tier !== undefined && run.tier !== null).map(run => String(run.tier)))].sort((a, b) => parseInt(a) - parseInt(b));
    selectedTiers = selectedTiers.filter(t => t === 'All' || availableTiers.includes(t));
    if (!selectedTiers.includes('All') && selectedTiers.length === 0) selectedTiers = ['All'];
    if (session) session.viewRunsSelectedTiers = selectedTiers;

    // Filter runs by selected types and tiers
    const filteredRuns = runs.filter(run => selectedTypes.includes(run.type || 'Farming') && (selectedTiers.includes('All') || selectedTiers.includes(String(run.tier))));
    // Sort filtered runs by dropdown order: types first, then tiers descending, then date descending
    const typeOrder = ['Farming', 'Overnight', 'Tournament', 'Milestone'];
    filteredRuns.sort((a, b) => {
        const aTypeIndex = typeOrder.indexOf(a.type || 'Farming');
        const bTypeIndex = typeOrder.indexOf(b.type || 'Farming');
        if (aTypeIndex !== bTypeIndex) return aTypeIndex - bTypeIndex;
        const aTier = parseInt(a.tier) || 0;
        const bTier = parseInt(b.tier) || 0;
        if (aTier !== bTier) return bTier - aTier; // descending tier
        const aDate = new Date(a.date || a.timestamp || 0);
        const bDate = new Date(b.date || b.timestamp || 0);
        return bDate - aDate; // descending date
    });
    // Adjust offset if necessary
    if (offset >= filteredRuns.length) {
        offset = Math.max(0, filteredRuns.length - count);
        if (session) session.viewRunsOffset = offset;
    }
    const selectedRuns = filteredRuns.slice(offset, offset + count);
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
    const avgTiers = formatNumberForDisplay(avg(selectedRuns.map(run => parseInt(run.tier || 0, 10))));
    const avgWaves = Math.round(avg(selectedRuns.map(run => parseInt(run.wave || 0, 10)))).toString();
    const avgDuration = selectedRuns[0].duration || selectedRuns[0].roundDuration || 'N/A';
    const avgCoins = formatNumberForDisplay(avg(selectedRuns.map(run => parseNumberInput(run.totalCoins || run.coins || 0))));
    const avgCells = formatNumberForDisplay(avg(selectedRuns.map(run => parseNumberInput(run.totalCells || run.cells || 0))));
    const avgDice = formatNumberForDisplay(avg(selectedRuns.map(run => parseNumberInput(run.totalDice || run.rerollShards || run.dice || 0))));
    const avgCoinsHr = formatRateWithNotation(avg(selectedRuns.map(run => parseNumberInput(calculateHourlyRates(run.duration || run.roundDuration, run).coinsPerHour || 0))), 1);
    const avgCellsHr = formatRateWithNotation(avg(selectedRuns.map(run => parseNumberInput(calculateHourlyRates(run.duration || run.roundDuration, run).cellsPerHour || 0))), 1);
    const avgDiceHr = formatRateWithNotation(avg(selectedRuns.map(run => parseNumberInput(calculateHourlyRates(run.duration || run.roundDuration, run).dicePerHour || 0))), 1);
    // Chart
    const timelineChartBuffer = await generateTimelineChart(selectedRuns);
    const timelineChartAttachment = new AttachmentBuilder(timelineChartBuffer, { name: 'runs_timeline_chart.png' });

    // Table
    const headers = selectedColumns;
    const colWidths = selectedColumns.map(col => allColumns[col].width);
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
        const values = selectedColumns.map(col => allColumns[col].getValue(run));
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

Below are the averages for the last ${count} runs of selected types (${selectedTypes.join(', ')}) and tiers (${selectedTiers.includes('All') ? 'All' : selectedTiers.join(', ')}).`)
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
    // Select menus
    const typeOptions = availableTypes.map(type => ({
        label: type,
        value: type,
        default: selectedTypes.includes(type)
    }));
    const typeSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('tracker_viewruns_types')
        .setPlaceholder('Select run types to display')
        .setMinValues(1)
        .setMaxValues(availableTypes.length)
        .addOptions(typeOptions);
    const columnsSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('tracker_viewruns_columns')
        .setPlaceholder('Select columns to display')
        .setMinValues(1)
        .setMaxValues(Object.keys(allColumns).length)
        .addOptions(Object.keys(allColumns).map(col => ({
            label: col,
            value: col,
            default: selectedColumns.includes(col)
        })));
    const countSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('tracker_viewruns_select')
        .setPlaceholder(`Showing ${offset + 1}-${Math.min(offset + count, filteredRuns.length)} of ${filteredRuns.length} runs`)
        .addOptions([
            { label: 'Show 5 runs per page', value: '5', default: count === 5 },
            { label: 'Show 10 runs per page', value: '10', default: count === 10 },
            { label: 'Show 20 runs per page', value: '20', default: count === 20 },
            { label: 'Show 35 runs per page', value: '35', default: count === 35 },
            { label: 'Show 50 runs per page', value: '50', default: count === 50 },
        ]);
    const uniqueTiers = availableTiers;
    const tierOptions = [
        { label: 'All Tiers', value: 'All', default: selectedTiers.includes('All') },
        ...uniqueTiers.map(tier => ({
            label: `Tier ${tier}`,
            value: String(tier),
            default: selectedTiers.includes(String(tier))
        }))
    ];
    const tierSelectMenu = new StringSelectMenuBuilder()
        .setCustomId('tracker_viewruns_tiers')
        .setPlaceholder('Select tiers to display')
        .setMinValues(1)
        .setMaxValues(uniqueTiers.length + 1)
        .addOptions(tierOptions);
    const row1 = new ActionRowBuilder().addComponents(columnsSelectMenu);
    const row2 = new ActionRowBuilder().addComponents(typeSelectMenu);
    const row3 = new ActionRowBuilder().addComponents(tierSelectMenu);
    const row4 = new ActionRowBuilder().addComponents(countSelectMenu);
    const row5 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tracker_viewruns_prev')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⬅️')
            .setDisabled(offset + count >= filteredRuns.length),
        new ButtonBuilder()
            .setCustomId('tracker_viewruns_next')
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('➡️')
            .setDisabled(offset === 0),
        /*
        new ButtonBuilder()
            .setCustomId('tracker_share_runs')
            .setLabel('Share')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📢'),
        */
        new ButtonBuilder()
            .setCustomId('tracker_main_menu')
            .setLabel('Main Menu')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🏠')
    );
    await interaction.editReply({ embeds: [embed], components: [row1, row2, row3, row4, row5], files: [tableAttachment, timelineChartAttachment] });
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
    // Initialize selected types, columns and count from DB or defaults
    let selectedTypes = JSON.parse(loadSetting(userId, 'viewRunsSelectedTypes', '["Farming","Overnight","Tournament","Milestone"]'));
    let selectedColumns = JSON.parse(loadSetting(userId, 'viewRunsSelectedColumns', '["Tier","Wave","Duration","Killed By","Coins","Cells","Dice","Coins/Hr","Cells/Hr","Dice/Hr","Date"]'));
    let selectedTiers = JSON.parse(loadSetting(userId, 'viewRunsSelectedTiers', '["All"]'));
    if (selectedTiers.includes('All') && selectedTiers.length > 1) {
        selectedTiers = ['All'];
    }
    session.viewRunsSelectedTiers = selectedTiers;
    let count = parseInt(loadSetting(userId, 'viewRunsCount', '10'), 10);
    let offset = parseInt(loadSetting(userId, 'viewRunsOffset', '0'), 10);
    // Handle select menu interaction (fix for Discord.js v14+)
    if (interaction.isStringSelectMenu?.()) {
        if (interaction.customId === 'tracker_viewruns_types' && interaction.values) {
            selectedTypes = interaction.values;
            saveSetting(userId, 'viewRunsSelectedTypes', JSON.stringify(selectedTypes));
        } else if (interaction.customId === 'tracker_viewruns_columns' && interaction.values) {
            selectedColumns = interaction.values;
            saveSetting(userId, 'viewRunsSelectedColumns', JSON.stringify(selectedColumns));
        } else if (interaction.customId === 'tracker_viewruns_tiers' && interaction.values) {
            let newSelected = interaction.values;
            if (newSelected.includes('All') && newSelected.length > 1) {
                selectedTiers = newSelected.filter(t => t !== 'All');
            } else if (newSelected.includes('All')) {
                selectedTiers = ['All'];
            } else {
                selectedTiers = newSelected;
            }
            saveSetting(userId, 'viewRunsSelectedTiers', JSON.stringify(selectedTiers));
            session.viewRunsSelectedTiers = selectedTiers;
        } else if (interaction.customId === 'tracker_viewruns_select' && interaction.values && interaction.values[0]) {
            count = parseInt(interaction.values[0], 10) || 10;
            saveSetting(userId, 'viewRunsCount', count.toString());
        }
    }

    // Render the initial viewRuns UI
    await renderViewRuns(interaction, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
        filter: i => [
            'tracker_viewruns_types',
            'tracker_viewruns_columns',
            'tracker_viewruns_tiers',
            'tracker_viewruns_select',
            'tracker_viewruns_prev',
            'tracker_viewruns_next',
            'tracker_share_runs',
            'tracker_main_menu'
        ].includes(i.customId) && i.user.id === userId,
        time: 300000
    });
    collector.on('collect', async i => {
        await i.deferUpdate();
        if (i.customId === 'tracker_viewruns_types') {
            selectedTypes = i.values;
            saveSetting(userId, 'viewRunsSelectedTypes', JSON.stringify(selectedTypes));
            offset = 0;
            saveSetting(userId, 'viewRunsOffset', '0');
            await renderViewRuns(i, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);
        } else if (i.customId === 'tracker_viewruns_columns') {
            selectedColumns = i.values;
            saveSetting(userId, 'viewRunsSelectedColumns', JSON.stringify(selectedColumns));
            await renderViewRuns(i, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);
        } else if (i.customId === 'tracker_viewruns_tiers') {
            let newSelected = i.values;
            if (newSelected.includes('All') && newSelected.length > 1) {
                selectedTiers = newSelected.filter(t => t !== 'All');
            } else if (newSelected.includes('All')) {
                selectedTiers = ['All'];
            } else {
                selectedTiers = newSelected;
            }
            saveSetting(userId, 'viewRunsSelectedTiers', JSON.stringify(selectedTiers));
            session.viewRunsSelectedTiers = selectedTiers;
            offset = 0;
            saveSetting(userId, 'viewRunsOffset', '0');
            await renderViewRuns(i, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);
        } else if (i.customId === 'tracker_viewruns_select') {
            // Update count and re-render UI in-place, do not recurse
            let newCount = 10;
            if (i.values && i.values[0]) {
                newCount = parseInt(i.values[0], 10) || 10;
            }
            count = newCount;
            saveSetting(userId, 'viewRunsCount', count.toString());
            offset = 0;
            saveSetting(userId, 'viewRunsOffset', '0');
            await renderViewRuns(i, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);
        } else if (i.customId === 'tracker_viewruns_prev') {
            offset += count;
            saveSetting(userId, 'viewRunsOffset', offset.toString());
            await renderViewRuns(i, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);
        } else if (i.customId === 'tracker_viewruns_next') {
            if (offset >= count) {
                offset -= count;
            } else {
                offset = 0;
            }
            saveSetting(userId, 'viewRunsOffset', offset.toString());
            await renderViewRuns(i, runs, count, userId, selectedTypes, selectedColumns, selectedTiers, session, offset);
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
                            return `${context.dataset.label}: ${formatNumberForDisplay(value)}`;
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
                            return formatNumberForDisplay(value);
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
                            return formatNumberForDisplay(value);
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
                            return formatNumberForDisplay(value);
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
                            return formatNumberForDisplay(value);
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