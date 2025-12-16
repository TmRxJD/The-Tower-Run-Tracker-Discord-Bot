const { SlashCommandBuilder } = require('discord.js');
const {
	parseDurationToHours,
	standardizeNotation,
	parseNumberInput,
	formatNumberForDisplay,
	formatRateWithNotation,
	normalizeDecimalSeparator
} = require('./TrackerUtils/trackerHandlers/trackerHelpers.js');

const VALUE_PATTERN = /^(\d+|\d*\.\d+)([KMBTqQsSOND]|A[A-J])?$/i;

function parseResource(rawValue) {
	if (!rawValue) return null;
	const cleaned = normalizeDecimalSeparator(rawValue);
	if (!cleaned) return null;
	if (!VALUE_PATTERN.test(cleaned)) {
		return { error: true };
	}
	const normalized = standardizeNotation(cleaned);
	const value = parseNumberInput(normalized);
	if (!Number.isFinite(value) || value < 0) {
		return { error: true };
	}
	return { value };
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('cph')
		.setDescription('Calculate coins or cells earned per hour')
		.addStringOption(option => 
			option.setName('time')
				.setDescription('Enter game time (e.g., 5h10m14s)')
				.setRequired(true))
		.addStringOption(option => 
			option.setName('coins')
				.setDescription('Enter coins earned (e.g., 1k, 1M, 1B)')
				.setRequired(false))
		.addStringOption(option => 
			option.setName('cells')
				.setDescription('Enter cells earned (e.g., 1k, 1M, 1B)')
				.setRequired(false))
		.addStringOption(option =>
			option.setName('dice')
				.setDescription('Enter dice earned (e.g., 750, 1.2K)')
				.setRequired(false)),
	async execute(interaction) {
		const timeInput = interaction.options.getString('time');
		const coinsInput = interaction.options.getString('coins');
		const cellsInput = interaction.options.getString('cells');
		const diceInput = interaction.options.getString('dice');

		const totalHours = parseDurationToHours(timeInput);
		if (totalHours <= 0) {
			await interaction.reply('Invalid time input! Please include at least one valid time component (e.g., 1h30m, 45m, 1:15:00).');
			return;
		}

		const resources = [
			{ key: 'coins', label: 'Coins', emoji: '🪙', raw: coinsInput },
			{ key: 'cells', label: 'Cells', emoji: '🔋', raw: cellsInput },
			{ key: 'dice', label: 'Dice', emoji: '🎲', raw: diceInput }
		].filter(resource => resource.raw);

		if (!resources.length) {
			await interaction.reply('Please provide at least one resource amount (coins, cells, or dice).');
			return;
		}

		const invalid = [];
		const computed = [];
		for (const resource of resources) {
			const parsed = parseResource(resource.raw);
			if (!parsed || parsed.error) {
				invalid.push(resource.label);
				continue;
			}
			const perHour = formatRateWithNotation(parsed.value, totalHours);
			computed.push({
				label: resource.label,
				emoji: resource.emoji,
				total: parsed.value,
				perHour
			});
		}

		if (invalid.length) {
			await interaction.reply(`Invalid amount provided for: ${invalid.join(', ')}. Use notation like 1.5M or 750k.`);
			return;
		}

		const summaryLines = computed.map(resource => {
			const totalDisplay = formatNumberForDisplay(resource.total);
			return `${resource.emoji} ${resource.label}: ${totalDisplay} total → ${resource.perHour}/hr`;
		});

		const durationDisplay = totalHours >= 0.01 ? totalHours.toFixed(2) : totalHours.toString();
		const header = `> Game time: ${timeInput.trim()} (${durationDisplay}h)`;
		const response = [header, ...summaryLines].join('\n');

		await interaction.reply(response);
	},
};
