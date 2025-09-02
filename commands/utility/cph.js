const { SlashCommandBuilder } = require('discord.js');

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
				.setRequired(false)),
	async execute(interaction) {
		const timeInput = interaction.options.getString('time');
		const coinsInput = interaction.options.getString('coins');
		const cellsInput = interaction.options.getString('cells');

		// Convert time input into total hours
		const timeRegex = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
		const matches = timeInput.match(timeRegex);
		const hours = matches[1] ? parseInt(matches[1]) : 0;
		const minutes = matches[2] ? parseInt(matches[2]) : 0;
		const seconds = matches[3] ? parseInt(matches[3]) : 0;
		const totalHours = hours + minutes / 60 + seconds / 3600;

		// Prevent division by zero
		if (totalHours === 0) {
			await interaction.reply("Invalid time input! Make sure to enter at least some time.");
			return;
		}

		// Function to convert shorthand notation (e.g., 1k, 1M) into numbers
		const parseNotation = (value) => {
			if (!value) return null;
			const notationMap = {
				'k': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12,
				'q': 1e15, 'Q': 1e18, 's': 1e21, 'S': 1e24
			};
			const match = value.match(/^(\d*\.?\d+)([kMBTqQsS]?)$/);
			if (!match) return null;
			const num = parseFloat(match[1]);
			const multiplier = notationMap[match[2]] || 1;
			return num * multiplier;
		};

		// Function to format numbers back into notation (e.g., 1.5M instead of 1500000)
		const formatNotation = (num) => {
			if (num >= 1e24) return (num / 1e24).toFixed(2) + "S";
			if (num >= 1e21) return (num / 1e21).toFixed(2) + "s";
			if (num >= 1e18) return (num / 1e18).toFixed(2) + "Q";
			if (num >= 1e15) return (num / 1e15).toFixed(2) + "q";
			if (num >= 1e12) return (num / 1e12).toFixed(2) + "T";
			if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
			if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
			if (num >= 1e3) return (num / 1e3).toFixed(2) + "k";
			return num.toFixed(2);
		};

		// Convert inputs
		const coins = parseNotation(coinsInput);
		const cells = parseNotation(cellsInput);

		// Prepare response
		let response = `> Game time: ${timeInput}, Coins: ${formatNotation(coins)}, Cells: ${formatNotation(cells)}\n`;
		if (coins !== null) {
			const coinsPerHour = coins / totalHours;
			response += `Coins per hour: ${formatNotation(coinsPerHour)}\n`;
		}
		if (cells !== null) {
			const cellsPerHour = cells / totalHours;
			response += `Cells per hour: ${formatNotation(cellsPerHour)}`;
		}

		await interaction.reply(response);
	},
};
