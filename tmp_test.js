function parseDurationToHours(duration) {
    if (!duration || duration === 'Unknown') {
        return 0;
    }

    const normalized = duration.toLowerCase().replace(/\s+/g, '');
    const timeMatch = normalized.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!timeMatch) {
        return 0;
    }

    const hours = timeMatch[1] ? parseInt(timeMatch[1]) : 0;
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;

    return hours + minutes / 60 + seconds / 3600;
}

function formatRateWithNotation(amount, hours) {
    if (!amount || hours <= 0) return '0';
    const NOTATIONS = {
        K: 1e3, M: 1e6, B: 1e9, T: 1e12, q: 1e15, Q: 1e18, s: 1e21, S: 1e24, O: 1e27, N: 1e30, D: 1e33,
        AA: 1e36, AB: 1e39, AC: 1e42, AD: 1e45, AE: 1e48, AF: 1e51, AG: 1e54, AH: 1e57, AI: 1e60, AJ: 1e63
    };
    let numericValue;
    let notation = '';
    if (typeof amount === 'number') {
        numericValue = amount;
    } else {
        const match = String(amount).match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
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
    const rate = numericValue / hours;
    const notationEntries = Object.entries(NOTATIONS).reverse();
    for (const [not, multiplier] of notationEntries) {
        if (rate >= multiplier) {
            let formatted_num = (rate / multiplier).toFixed(2);
            if (formatted_num.endsWith('.00')) {
                formatted_num = formatted_num.slice(0, -3);
            } else if (formatted_num.endsWith('0')) {
                formatted_num = formatted_num.slice(0, -1);
            }
            return formatted_num + not;
        }
    }
    let formatted = rate.toFixed(1) + 'K';
    if (formatted.endsWith('.0K')) {
        formatted = formatted.slice(0, -3) + 'K';
    }
    return formatted;
}

function calculateHourlyRates(duration, amounts) {
    const durationHours = parseDurationToHours(duration);
    if (durationHours <= 0) return { coinsPerHour: '0', cellsPerHour: '0', dicePerHour: '0' };
    const rates = {};
    const coinsValue = amounts.totalCoins || amounts.coins || '0';
    rates.coinsPerHour = formatRateWithNotation(coinsValue, durationHours);
    return rates;
}

console.log(calculateHourlyRates('3h33m59s', { totalCoins: '54.09q' }));
