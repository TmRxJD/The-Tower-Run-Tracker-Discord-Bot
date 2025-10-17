const { SlashCommandBuilder } = require('discord.js');
const { parseDurationToHours, parseNumberInput, formatNumberForDisplay } = require('./TrackerUtils/trackerHandlers/trackerHelpers.js');

// Corrected version of formatRateWithNotation to fix the bug for rates < 1000
function formatRateWithNotation(amount, hours) {
    if (!amount || hours <= 0) return '0';
    
    // Notation constants
    const NOTATIONS = {
        K: 1e3, M: 1e6, B: 1e9, T: 1e12, q: 1e15, Q: 1e18, s: 1e21, S: 1e24, O: 1e27, N: 1e30, D: 1e33,
        AA: 1e36, AB: 1e39, AC: 1e42, AD: 1e45, AE: 1e48, AF: 1e51, AG: 1e54, AH: 1e57, AI: 1e60, AJ: 1e63
    };
    
    // Extract numeric value and notation
    let numericValue;
    let notation = '';
    
    if (typeof amount === 'number') {
        numericValue = amount;
    } else {
        const match = String(amount).match(/^(\d+(?:\.\d+)?)([KMBTSqQsS]*)$/i);
        if (match) {
            numericValue = parseFloat(match[1]);
            notation = match[2];
            if (notation) {
                const multiplier = NOTATIONS[notation];
                if (multiplier) {
                    numericValue *= multiplier;
                }
            }
        } else {
            numericValue = parseFloat(amount);
        }
    }
    
    if (isNaN(numericValue)) return '0';
    
    // Calculate rate
    const rate = numericValue / hours;
    
    const notationEntries = Object.entries(NOTATIONS).reverse();
    for (const [not, multiplier] of notationEntries) {
        if (rate >= multiplier) {
            let formatted = (rate / multiplier).toFixed(2) + not;
            if (formatted.startsWith('0.')) {
                let shiftedRate = rate * 1000;
                let shiftedFormatted = shiftedRate.toFixed(2);
                if (shiftedFormatted.endsWith('.00')) {
                    shiftedFormatted = shiftedFormatted.slice(0, -3);
                } else if (shiftedFormatted.endsWith('0')) {
                    shiftedFormatted = shiftedFormatted.slice(0, -1);
                }
                if (not === 'K') {
                    return shiftedFormatted + 'K';
                } else if (not === 'M') {
                    return shiftedFormatted + 'M';
                } else if (not === 'B') {
                    return shiftedFormatted + 'B';
                } else if (not === 'T') {
                    return shiftedFormatted + 'T';
                } else if (not === 'q') {
                    return shiftedFormatted + 'q';
                } else if (not === 'Q') {
                    return shiftedFormatted + 'Q';
                } else if (not === 's') {
                    return shiftedFormatted + 's';
                } else if (not === 'S') {
                    return shiftedFormatted + 'S';
                } else if (not === 'O') {
                    return shiftedFormatted + 'O';
                } else if (not === 'N') {
                    return shiftedFormatted + 'N';
                } else if (not === 'D') {
                    return shiftedFormatted + 'D';
                } else if (not === 'AA') {
                    return shiftedFormatted + 'AA';
                } // Add more if needed
                else {
                    return shiftedFormatted + not; // Fallback
                }
            }
            // Remove unnecessary trailing zeros
            if (formatted.endsWith('.00')) {
                formatted = formatted.slice(0, -3);
            } else if (formatted.endsWith('0')) {
                formatted = formatted.slice(0, -1);
            }
            return formatted;
        }
    }
    // If rate < 1000, return as is
    return Math.round(rate).toString();
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
				.setDescription('Enter dice earned (e.g., 1k, 1M, 1B)')
				.setRequired(false)),
	async execute(interaction) {
		const timeInput = interaction.options.getString('time');
		const coinsInput = interaction.options.getString('coins');
		const cellsInput = interaction.options.getString('cells');
		const diceInput = interaction.options.getString('dice');

		// Parse time input into total hours, allowing spaces and mixed case
		const cleanedTimeInput = timeInput.replace(/\s/g, '').toLowerCase();
		const totalHours = parseDurationToHours(cleanedTimeInput);

		// Prevent division by zero
		if (totalHours === 0) {
			await interaction.reply("Invalid time input! Make sure to enter at least some time.");
			return;
		}

		// Parse inputs
		const parseValue = (input) => {
			if (!input) return null;
			let standardizedInput = input.replace(/,/g, '').trim();
			// Standardize notation to uppercase except q Q s S
			standardizedInput = standardizedInput.replace(/k/g, 'K').replace(/m/g, 'M').replace(/b/g, 'B').replace(/t/g, 'T');
			// q Q s S remain as is
			const num = parseNumberInput(standardizedInput);
			const match = standardizedInput.match(/^(\d+|\d*\.\d+)([KMBTqQsSOND]|A[A-J])?$/i);
			if (!match) return null;
			return num;
		};
		const coins = parseValue(coinsInput);
		const cells = parseValue(cellsInput);
		const dice = parseValue(diceInput);

		// Prepare response
		let responseParts = [`> Game time: ${cleanedTimeInput}`];
		if (coins !== null) responseParts.push(`> Coins: ${formatNumberForDisplay(coins)}`);
		if (cells !== null) responseParts.push(`> Cells: ${formatNumberForDisplay(cells)}`);
		if (dice !== null) responseParts.push(`> Dice: ${formatNumberForDisplay(dice)}`);
		let response = responseParts.join('\n') + '\n';

		if (coins !== null) {
			const coinsPerHourStr = formatRateWithNotation(coins, totalHours);
			response += `Coins per hour: ${coinsPerHourStr}\n`;
		}
		if (cells !== null) {
			const cellsPerHourStr = formatRateWithNotation(cells, totalHours);
			response += `Cells per hour: ${cellsPerHourStr}\n`;
		}
		if (dice !== null) {
			const dicePerHourStr = formatRateWithNotation(dice, totalHours);
			response += `Dice per hour: ${dicePerHourStr}`;
		}

		await interaction.reply(response);
	},
};
