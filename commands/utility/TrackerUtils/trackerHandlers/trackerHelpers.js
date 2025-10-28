// Shared constants and functions
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
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Standardizes number notation (uppercase except 'q')
 */
function standardizeNotation(value) {
    if (!value || typeof value !== 'string') return value;
    // Match number and notation parts
    const match = value.match(/^([\d.,]+)([a-zA-Z]*)$/);
    if (!match) return value;
    const number = match[1];
    let notation = match[2];
    // If there's notation, standardize it (uppercase except Q/q and S/s, which are preserved as-is)
    if (notation) {
        notation = notation.split('').map(c => {
            if (c === 'q' || c === 'Q' || c === 's' || c === 'S') {
                return c; // preserve case for Q/q and S/s
            }
            return c.toUpperCase();
        }).join('');
        return number + notation;
    }
    return value;
}

/**
 * Formats numbers for display with notation if large, and handles decimal preference.
 * Ensures coefficient is always >= 1 for notation (e.g., 500K instead of 0.5M).
 */
function formatNumberForDisplay(value, decimalPreference = 'Period (.)') {
    if (value === null || value === undefined || value === 'N/A') return 'N/A'; // Handle null/undefined
    if (typeof value === 'string' && value.trim() === '') return '';
    let num = value;
    if (typeof value === 'string') {
        // Try to parse if it's a string
        num = parseFloat(value.replace(/,/g, ''));
        if (isNaN(num)) return value; // If not a number, return as is
    }
    if (typeof num !== 'number' || isNaN(num)) return String(value);

    // Notation constants
    const NOTATIONS = {
        K: 1e3, M: 1e6, B: 1e9, T: 1e12, q: 1e15, Q: 1e18, s: 1e21, S: 1e24, O: 1e27, N: 1e30, D: 1e33,
        AA: 1e36, AB: 1e39, AC: 1e42, AD: 1e45, AE: 1e48, AF: 1e51, AG: 1e54, AH: 1e57, AI: 1e60, AJ: 1e63
    };

    if (num < 1000) {
        let str = Math.round(num).toString();
        if (decimalPreference === 'Comma (,)' && str.includes('.')) {
            str = str.replace(/\./g, ',');
        }
        return str;
    }

    const notationEntries = Object.entries(NOTATIONS).reverse();
    for (const [notation, multiplier] of notationEntries) {
        if (num >= multiplier) {
            let num_str = (num / multiplier).toFixed(2);
            if (num_str.endsWith('.00')) {
                num_str = num_str.slice(0, -3);
            } else if (num_str.endsWith('0')) {
                num_str = num_str.slice(0, -1);
            }
            let formatted = num_str + notation;
            if (decimalPreference === 'Comma (,)' && formatted.includes('.')) {
                formatted = formatted.replace(/\./g, ',');
            }
            return formatted;
        }
    }
    let str = num.toString();
    if (decimalPreference === 'Comma (,)' && str.includes('.')) {
        str = str.replace(/\./g, ',');
    }
    return str;
}

/**
 * Format time duration strings consistently
 */
function formatDuration(durationString) {
    // Default if input is invalid
    if (!durationString || typeof durationString !== 'string') {
        return '0h0m0s';
    }
    
    // Try to extract hours, minutes, seconds using various formats
    const normalized = durationString.toLowerCase().replace(/\s+/g, '');
    
    // Extract numbers for hours, minutes, seconds
    const hoursMatch = normalized.match(/(\d+)h/);
    const minutesMatch = normalized.match(/(\d+)m/);
    const secondsMatch = normalized.match(/(\d+)s/);
    
    const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
    const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
    const seconds = secondsMatch ? parseInt(secondsMatch[1]) : 0;
    
    // If no valid time component was found, default to 0h0m0s
    if (hours === 0 && minutes === 0 && seconds === 0) {
        return '0h0m0s';
    }
    
    return `${hours}h${minutes}m${seconds}s`;
}

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, etc.)
 */
function getNumberSuffix(num) {
    const j = num % 10;
    const k = num % 100;
    if (j === 1 && k !== 11) return "st";
    if (j === 2 && k !== 12) return "nd";
    if (j === 3 && k !== 13) return "rd";
    return "th";
}

/**
 * Convert string to title case
 */
function toTitleCase(str) {
    if (!str) return '';
    return str
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Preprocesses an image for better OCR accuracy
 * @param {Buffer} buffer - The original image buffer
 * @returns {Promise<Buffer>} - The processed image buffer ready for OCR
 */
async function preprocessImage(buffer) {    
    try {
        let currentBuffer = buffer;
        let currentSize = currentBuffer.length;
        const MAX_SIZE = 188743680; // Approx. 180MB maximum size for OCR processing
        let reductionFactor = 1;  

        const reductionStep = 0.9; // Reduce quality by 10% each iteration if needed

        // Apply image processing to enhance text readability
        const processed = await sharp(currentBuffer)
            .trim() // Remove excess whitespace around the edges
            //.toFormat('tiff', { compression: 'lzw' }) // Convert to TIFF with LZW compression for OCR
            .toBuffer();

        currentBuffer = processed;
        currentSize = currentBuffer.length;
        
        // If the processed image is still too large, reduce its size/quality
        if (currentSize > MAX_SIZE) {
            console.log(`[DEBUG] Image too large. Current size: ${currentSize / 1024 / 1024} MB`);
            
            while (currentSize > MAX_SIZE && reductionFactor > 0.5) {
                console.log(`[DEBUG] Reducing image quality. Current size: ${currentSize / 1024 / 1024} MB`);

                const reduced = await sharp(currentBuffer)
                    .toFormat('tiff', { 
                        compression: 'lzw', 
                        quality: Math.max(50, 85 * reductionFactor)
                    })
                    .toBuffer();

                currentBuffer = reduced; 
                currentSize = currentBuffer.length; 
                reductionFactor *= reductionStep; 

                console.log(`[DEBUG] Reduced image size to: ${currentSize / 1024 / 1024} MB`);
            }
        }

        return currentBuffer;

    } catch (error) {
        console.error('[ERROR] Image preprocessing failed:', error);
        throw error;
    }
}

/**
 * Extracts date and time from image metadata and filename
 * @param {Object} attachment - Image attachment from Discord
 * @returns {Object} - Object containing date and time values
 */
async function extractDateTimeFromImage(attachment) {
    try {
        // Default to current date and time
        const now = new Date();
        const result = {
            date: formatDate(now),
            time: formatTime(now),
            timestamp: now
        };
        
        // Exit early if no attachment
        if (!attachment) return result;
        
        // Try to extract from filename first
        const filename = attachment.name || attachment.filename || '';
        if (filename) {
            console.log(`[DATETIME] Analyzing filename: ${filename}`);
            
            // Handle Screenshot_YYYYMMDD_HHMMSS format (common on mobile screenshots)
            const screenshotPattern = /Screenshot_(\d{8})_(\d{6}).*\.(jpg|jpeg|png)/i;
            const screenshotMatch = filename.match(screenshotPattern);
            if (screenshotMatch) {
                const dateStr = screenshotMatch[1]; // YYYYMMDD
                const timeStr = screenshotMatch[2]; // HHMMSS
                
                const year = parseInt(dateStr.substring(0, 4));
                const month = parseInt(dateStr.substring(4, 6));
                const day = parseInt(dateStr.substring(6, 8));
                
                const hours = parseInt(timeStr.substring(0, 2));
                const minutes = parseInt(timeStr.substring(2, 4));
                const seconds = parseInt(timeStr.substring(4, 6));
                
                const extractedDate = new Date(year, month - 1, day, hours, minutes, seconds);
                
                if (!isNaN(extractedDate.getTime())) {
                    console.log(`[DATETIME] Found date/time in screenshot filename: ${extractedDate.toISOString()}`);
                    result.date = formatDate(extractedDate);
                    result.time = formatTime(extractedDate);
                    result.timestamp = extractedDate;
                    return result; // Return early as this is a high-confidence match
                }
            }
            
            // Look for date patterns like YYYY-MM-DD or MM-DD-YYYY
            const datePatterns = [
                /(\d{4})[-_.](\d{2})[-_.](\d{2})/,  // YYYY-MM-DD
                /(\d{2})[-_.](\d{2})[-_.](\d{4})/,  // MM-DD-YYYY
                /(\d{2})[-_.](\d{2})[-_.](\d{2})/   // MM-DD-YY
            ];
            
            for (const pattern of datePatterns) {
                const match = filename.match(pattern);
                if (match) {
                    // Parse based on pattern
                    let year, month, day;
                    if (match[1].length === 4) {
                        // YYYY-MM-DD
                        year = match[1];
                        month = match[2];
                        day = match[3];
                    } else {
                        // MM-DD-YYYY or MM-DD-YY
                        month = match[1];
                        day = match[2];
                        year = match[3].length === 2 ? `20${match[3]}` : match[3];
                    }
                    
                    // Create date object from parts
                    const extractedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                    if (!isNaN(extractedDate.getTime())) {
                        console.log(`[DATETIME] Found date in filename: ${extractedDate.toISOString().split('T')[0]}`);
                        result.date = formatDate(extractedDate);
                        result.timestamp = extractedDate;
                        break;
                    }
                }
            }
            
            // Look for time patterns like HH:MM or HH-MM
            const timePattern = /(\d{1,2})[:-](\d{2})(?:[:-](\d{2}))?(?:\s*(am|pm))?/i;
            const timeMatch = filename.match(timePattern);
            if (timeMatch) {
                let hours = parseInt(timeMatch[1]);
                const minutes = parseInt(timeMatch[2]);
                const seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;
                
                // Handle AM/PM
                if (timeMatch[4]) {
                    const isPM = timeMatch[4].toLowerCase() === 'pm';
                    if (isPM && hours < 12) hours += 12;
                    if (!isPM && hours === 12) hours = 0;
                }
                
                // Use current date but extracted time
                const extractedTime = new Date(result.timestamp);
                extractedTime.setHours(hours, minutes, seconds);
                
                if (!isNaN(extractedTime.getTime())) {
                    console.log(`[DATETIME] Found time in filename: ${extractedTime.toTimeString()}`);
                    result.time = formatTime(extractedTime);
                    result.timestamp = extractedTime;
                }
            }
        }
        
        return result;
    } catch (error) {
        console.error('[ERROR] Failed to extract date/time from image:', error);
        // Fall back to current date and time
        const now = new Date();
        return {
            date: formatDate(now),
            time: formatTime(now),
            timestamp: now
        };
    }
}

/**
 * Format date to MM/DD/YY format
 * @param {Date} dateObj - Date object to format
 * @returns {string} - Formatted date string
 */
function formatDate(dateObj) {
    if (!dateObj) return 'Unknown Date';
    
    const formattedDate = `${dateObj.getMonth() + 1}/${dateObj.getDate()}/${dateObj.getFullYear().toString().slice(-2)}`;
    return formattedDate;
}

/**
 * Format time value (HH:MM:SS)
 * @param {Date} time - Date object
 * @returns {string} - Formatted time string
 */
function formatTime(time) {
    if (!(time instanceof Date)) time = new Date(time);
    
    const hours = time.getHours().toString().padStart(2, '0');
    const minutes = time.getMinutes().toString().padStart(2, '0');
    const seconds = time.getSeconds().toString().padStart(2, '0');
    
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Extract text from an image using OCR
 * @param {Buffer} imageBuffer - Processed image buffer ready for OCR
 * @returns {Promise<Array>} - Array of text objects detected in the image
 */
async function extractTextFromImage(imageBuffer) {
    try {
        const { default: Ocr } = await import('@gutenye/ocr-node');
        const ocr = await Ocr.create();
        const result = await ocr.detect(imageBuffer);
        return result;
    } catch (error) {
        console.error('[ERROR] OCR processing failed:', error);
        throw error;
    }
}

// Language to decimal indicator mapping
const languageDecimalMap = {
    English: '.',
    German: ',',
    French: ',',
    Spanish: ',',
    Italian: ',',
    Portuguese: ',',    
    Russian: ','
};

function getDecimalForLanguage(language) {
    return languageDecimalMap[language] || '.';
}

// OCR field translations for each supported language
const ocrFieldTranslations = {
    English: {
        coins: "Coins Earned",
        cells: "Cells Earned",
        dice: "Reroll Shards Earned",
        duration: "Real Time",
        killedBy: "Killed By",
        tier: "Tier",
        wave: "Wave"
    },
    German: {
        coins: "Verdiente Münzen",
        cells: "Verdiente Zellen",
        dice: "Erhaltene Zufallsscherben",
        duration: "Echtzeit",
        killedBy: "Getötet Von",
        tier: "Stufe",
        wave: "Welle"
    },
    French: {
        coins: "Pièces Obtenues",
        cells: "Composants Obtenus",
        dice: "Fragments De Relance Obtenus",
        duration: "Temps Réel",
        killedBy: "Tué Par",
        tier: "Difficulté",
        wave: "Vague"
    },
    Spanish: {
        coins: "Monedas Ganadas",
        cells: "Baterias Ganadas",
        dice: "Cambiar Equirlas Conseguidas Al Azar",
        duration: "Tiempo Real",
        killedBy: "Muerto Por",
        tier: "Nivel",
        wave: "Oleada"
    },
    Italian: {
        coins: "Gettoni Guadagnate",
        cells: "Cell Guadagnate",
        dice: "Fragmenti Di Cambio Guadagnati",
        duration: "Tempo Effettivo",
        killedBy: "Ucciso Da",
        tier: "Grado",
        wave: "Ondata"
    },
    Portuguese: {
        coins: "Moedas Ganhas",
        cells: "Células Ganhas",
        dice: "Fragmentos De Variacão Obtidos",
        duration: "Tempo Real",
        killedBy: "Mortos Por",
        tier: "Grau",
        wave: "Onda"
    },
    Russian: {
        coins: "Заработанные Монеты",
        cells: "Заработанные Ячейки",
        dice: "Полученные Кубики Переката",
        duration: "Реальное Время",
        killedBy: "Убит",
        tier: "ypoBeHb",
        wave: "Волна"
    },
};

// Fuzzy similarity helper for loose field matching
function similarity(a, b) {
    a = a.toLowerCase();
    b = a.toLowerCase();
    let matches = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) matches++;
    }
    return matches / Math.max(a.length, b.length);
}

function getFieldExactOrFuzzy(lines, fieldKeys) {
    // Normalize keys for matching
    const normalizedKeys = fieldKeys.map(k => k.replace(/\s+/g, '').toLowerCase());
    for (const line of lines) {
        const normalizedLine = line.replace(/\s+/g, '').toLowerCase();
        for (const key of normalizedKeys) {
            if (normalizedLine.startsWith(key)) {
                // Extract value after the key
                const valuePart = line.slice(line.toLowerCase().indexOf(key) + key.length).trim();
                const match = valuePart.match(/(\d[\d.,]*\s*\+|\d[\d.,]*)([a-zA-Z]*)/);
                if (match) {
                    const numericPortion = match[1] ? match[1].replace(/\s+/g, '') : '';
                    const suffix = match[2] || '';
                    return numericPortion + suffix;
                }
            }
            if (normalizedLine.includes(key)) {
                const match = line.match(/(\d[\d.,]*\s*\+|\d[\d.,]*)([a-zA-Z]*)/);
                if (match) {
                    const numericPortion = match[1] ? match[1].replace(/\s+/g, '') : '';
                    const suffix = match[2] || '';
                    return numericPortion + suffix;
                }
            }
        }
    }
    // Fuzzy match fallback (stricter)
    let bestMatch = { line: '', key: '', score: 0 };
    for (const line of lines) {
        for (const key of normalizedKeys) {
            const score = similarity(line.replace(/\s+/g, '').toLowerCase(), key);
            if (score > bestMatch.score) {
                bestMatch = { line, key, score };
            }
        }
    }
    if (bestMatch.score > 0.8) {
        const match = bestMatch.line.match(/(\d[\d.,]*\s*\+|\d[\d.,]*)([a-zA-Z]*)/);
        if (match) {
            const numericPortion = match[1] ? match[1].replace(/\s+/g, '') : '';
            const suffix = match[2] || '';
            return numericPortion + suffix;
        }
    }
    return null;
}

/**
 * Processes OCR results and extracts game data
 * @param {Array} gutenyeResult - Array of OCR text results
 * @param {Object} dateTimeInfo - Date/time information
 * @param {string} notes - User-provided notes for the run
 * @param {string} decimalIndicator - Decimal indicator for the scan language (default '.')
 * @returns {Object} - Extracted run data in structured format
 */
function formatOCRExtraction(gutenyeResult, dateTimeInfo, notes, decimalIndicator = '.', scanLanguage = 'English') {
    console.log("[DEBUG] Starting formatOCRExtraction...");

    // Support both backend (array of strings) and onboard (array of objects) OCR results
    let lines;
    if (Array.isArray(gutenyeResult) && typeof gutenyeResult[0] === 'string') {
        lines = gutenyeResult;
    } else if (Array.isArray(gutenyeResult) && typeof gutenyeResult[0] === 'object' && gutenyeResult[0] !== null && 'text' in gutenyeResult[0]) {
        lines = gutenyeResult.map(item => item.text);
    } else {
        lines = [];
    }
    console.log("[DEBUG] OCR lines extracted:", lines);

    // Helper functions for text processing
    const normalizeDecimal = (text) => {
        if (typeof text !== 'string') text = String(text);
        if (decimalIndicator === ',') {
            // Replace comma with period for parsing
            return text.replace(/,/g, '.');
        }
        return text;
    };

    const fixOCRMisreads = (text) => {
        if (!text || typeof text !== 'string') {
            console.log("[DEBUG] fixOCRMisreads: Input is invalid or not a string.");
            return '0';
        }
    // Match numeric part and notation suffix (K, M, B, T, S, Q, etc.)
    const regex = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)([KMBTSqQsS]*)/;
    const match = text.match(regex);
        if (!match) {
            console.log("[DEBUG] fixOCRMisreads: Regex match failed for text:", text);
            return text;
        }
        let numberPart = match[1];
        let notationPart = match[2]; 
        if (parseFloat(numberPart) === 0) {
            console.log("[DEBUG] fixOCRMisreads: Number part is 0, removing notation.");
            notationPart = '';
        }
        // Replace common OCR misreads with correct digits
        numberPart = numberPart
            .replace(/O/g, '0')
            .replace(/B/g, '8')
            .replace(/S/g, '5')
            .replace(/I/g, '1')
            .replace(/l/g, '1')
            .replace(/Z/g, '2')
            .replace(/G/g, '6')
            .replace(/[^0-9.]/g, ''); 
        if (notationPart) {
            return numberPart + notationPart;
        }
        return parseInt(numberPart, 10);
    };

    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const fuzzyContains = (line, expected) => normalize(line).includes(normalize(expected));

    // Extract tier and wave values
    // Remove duplicate declaration of tier and wave
    const tierWave = getTierAndWave(lines);
    let tier = tierWave.tier;
    let wave = tierWave.wave;
    let tierDisplay = tierWave.tierRaw || (typeof tier === 'number' && !Number.isNaN(tier) ? String(tier) : null);
    let tierHasPlus = tierDisplay ? tierDisplay.includes('+') : false;

    // Extract field value from OCR text lines
    const getField = (lines, expectedField) => {
        for (const line of lines) {
            if (fuzzyContains(line, expectedField)) {
                // Try to extract numeric value with optional suffix
                const regex = /(\d+[\.,]?\d*)([a-zA-Z]*)/;
                const match = line.match(regex);
                if (match) {
                    const value = match[1] + (match[2] || '');
                    return value;
                }
                // Special case for "Killed By" field
                if (line.includes("Killed By")) {
                    return line.replace("Killed By", "").trim();
                }
            }
        }
        return '0';
    };

    // Process a field value, applying OCR fixes and formatting
    const processField = (rawValue) => {
        let fixed = fixOCRMisreads(normalizeDecimal(rawValue));
        // Keep notation suffixes (K, M, B, T, S, Q, etc.) if present
        if (typeof fixed === 'string' && /[KMBTSqQsS]/.test(fixed)) {
            return fixed;
        }
        return parseInt(fixed, 10);
    };

    const fields = ocrFieldTranslations[scanLanguage] || ocrFieldTranslations['English'];
    // For robust matching, collect all translations for each field
    const allTranslations = (field) => Object.values(ocrFieldTranslations).map(f => f[field]).filter(Boolean);

    // Use exact or fuzzy field matching for all fields
    let totalCoins = processField(getFieldExactOrFuzzy(lines, allTranslations('coins')));
    let totalCells = processField(getFieldExactOrFuzzy(lines, allTranslations('cells')));
    let totalDice = processField(getFieldExactOrFuzzy(lines, allTranslations('dice')));

    // Duration (roundDuration)
    let roundDuration = 'Unknown';
    // Only use 'Real Time' (or its translations) for duration
    for (const line of lines) {
        for (const durationKey of allTranslations('duration')) {
            const normalizedKey = durationKey.replace(/\s+/g, '').toLowerCase();
            const normalizedLine = line.replace(/\s+/g, '').toLowerCase();
            if (normalizedLine.startsWith(normalizedKey) || normalizedLine.includes(normalizedKey)) {
                // Extract duration after the key
                const valuePart = line.slice(line.toLowerCase().indexOf(durationKey.toLowerCase()) + durationKey.length).trim();
                const durationMatch = valuePart.match(/(\d+d)?\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
                if (durationMatch && (durationMatch[1] || durationMatch[2] || durationMatch[3] || durationMatch[4])) {
                    const days = durationMatch[1] ? parseInt(durationMatch[1]) : 0;
                    const hours = durationMatch[2] ? parseInt(durationMatch[2]) : 0;
                    const minutes = durationMatch[3] ? parseInt(durationMatch[3]) : 0;
                    const seconds = durationMatch[4] ? parseInt(durationMatch[4]) : 0;
                    let totalHours = hours + (days * 24);
                    roundDuration = `${totalHours}h${minutes}m${seconds}s`;
                    roundDuration = formatDuration(roundDuration);
                } else {
                    // If no match, try to extract any duration pattern from the line
                    const fallbackMatch = line.match(/(\d+d)?\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
                    if (fallbackMatch && (fallbackMatch[1] || fallbackMatch[2] || fallbackMatch[3] || fallbackMatch[4])) {
                        const days = fallbackMatch[1] ? parseInt(fallbackMatch[1]) : 0;
                        const hours = fallbackMatch[2] ? parseInt(fallbackMatch[2]) : 0;
                        const minutes = fallbackMatch[3] ? parseInt(fallbackMatch[3]) : 0;
                        const seconds = fallbackMatch[4] ? parseInt(fallbackMatch[4]) : 0;
                        let totalHours = hours + (days * 24);
                        roundDuration = `${totalHours}h${minutes}m${seconds}s`;
                        roundDuration = formatDuration(roundDuration);
                    }
                }
                break;
            }
        }
    }
    // If still unknown, do NOT fallback to 'Game Time' or any other line
    if (roundDuration === 'Unknown') roundDuration = '0h0m0s';

    // Killed By
    let killedByRaw = null;
    for (const line of lines) {
        for (const killedByKey of allTranslations('killedBy')) {
            if (line.trim().toLowerCase() === killedByKey.trim().toLowerCase() || line.toLowerCase().includes(killedByKey.toLowerCase())) {
                const match = line.match(/(?:Killed By|Getötet Von|Tué Par|Muerto Por|Ucciso Da|Mortos Por|Убит)\s*(.*)/i);
                if (match && match[1]) {
                    killedByRaw = match[1].trim();
                } else {
                    // If not matched, try to get the last word(s)
                    killedByRaw = line.split(/\s+/).slice(-1)[0];
                }
            }
        }
    }
    let killedBy = killedByRaw && killedByRaw !== 'Unknown' ? killedByRaw : 'Apathy';

    // Tier
    let fuzzyTier = getFieldExactOrFuzzy(lines, allTranslations('tier'));

    const tierCandidates = [tierWave.tierRaw, fuzzyTier, tier];
    for (const candidate of tierCandidates) {
        const { numeric, hasPlus, display } = parseTierString(candidate);
        if (numeric !== null && !Number.isNaN(numeric)) {
            const tierIsUnset = typeof tier !== 'number' || Number.isNaN(tier) || tier <= 0 || tier === 'Unknown';
            if (tierIsUnset) {
                tier = numeric;
            }
            if (!tierDisplay || hasPlus) {
                tierDisplay = display;
            }
            if (hasPlus) {
                tierHasPlus = true;
                break;
            }
        }
    }

    if (!tierDisplay && typeof tier === 'number' && !Number.isNaN(tier)) {
        tierDisplay = String(tier);
    }
    // Wave
    let fuzzyWave = getFieldExactOrFuzzy(lines, allTranslations('wave'));
    if ((wave === 'Unknown' || wave === 0) && fuzzyWave && fuzzyWave !== '0' && fuzzyWave !== 'Unknown') {
        wave = parseInt(fuzzyWave, 10);
    }

    // Use provided date/time or fall back to current time
    let date, time;
    if (dateTimeInfo && typeof dateTimeInfo === 'object') {
        date = dateTimeInfo.date;
        time = dateTimeInfo.time;
    } else {
        // Double-fallback in case dateTimeInfo is missing or malformed
        const now = new Date();
        date = formatDate(now);
        time = formatTime(now);
    }

    // Return structured data object with all extracted fields
    const extractedData = {
        tier: tier,
        wave: wave,
        totalCoins: totalCoins,  
        totalCells: totalCells,
        totalDice: totalDice,
        roundDuration: roundDuration,
        killedBy: killedBy,
        date: date,
        time: time,
        notes: notes,
    tierDisplay: tierDisplay,
    tierHasPlus: tierHasPlus,
        // Add coverage data for sharing (will be populated from parsed battle report)
        totalEnemies: null,
        destroyedByOrbs: null,
        taggedByDeathWave: null,
        destroyedInSpotlight: null,
        destroyedInGoldenBot: null
    };

    console.log("[DEBUG] Final extracted data:", extractedData);
    return extractedData;
}

/**
 * Calculate hourly rates based on duration and amounts
 * @param {string} duration - Duration string (1h30m45s format)
 * @param {Object} amounts - Object with amount fields
 * @param {Object} [rawData] - Optional raw/canonical data (e.g., parsed battle report)
 * @returns {Object} - Calculated rates
 */
function calculateHourlyRates(duration, amounts = {}, rawData = null) {
    const rates = {
        coinsPerHour: '0',
        cellsPerHour: '0',
        dicePerHour: '0'
    };

    const sources = [amounts, rawData].filter(source => !!source);

    const getFirstValue = (keys) => {
        for (const source of sources) {
            for (const key of keys) {
                if (source[key] !== undefined && source[key] !== null) {
                    const value = String(source[key]).trim();
                    if (value && !/^n\/?a$/i.test(value)) {
                        return value;
                    }
                }
            }
        }
        return null;
    };

    const normalizeRateValue = (value) => {
        if (value === null || value === undefined) return null;
        const trimmed = String(value).trim();
        if (!trimmed || /^n\/?a$/i.test(trimmed)) return null;
        const standardized = standardizeNotation(trimmed);
        const parsed = parseNumberInput(standardized);
        if (!isNaN(parsed) && parsed > 0) {
            return formatNumberForDisplay(parsed);
        }
        if (parsed === 0) {
            return '0';
        }
        return standardized;
    };

    const directCoinRate = normalizeRateValue(getFirstValue(['coinsPerHour', 'Coins per hour']));
    if (directCoinRate !== null) {
        rates.coinsPerHour = directCoinRate;
    }

    const directCellRate = normalizeRateValue(getFirstValue(['cellsPerHour', 'Cells per hour']));
    if (directCellRate !== null) {
        rates.cellsPerHour = directCellRate;
    }

    const directDiceRate = normalizeRateValue(getFirstValue(['dicePerHour', 'Dice per hour']));
    if (directDiceRate !== null) {
        rates.dicePerHour = directDiceRate;
    }

    const durationHours = parseDurationToHours(duration);
    if (durationHours > 0) {
        if (rates.coinsPerHour === '0') {
            const coinsValue = getFirstValue(['totalCoins', 'coins', 'Coins earned']) || '0';
            rates.coinsPerHour = formatRateWithNotation(standardizeNotation(coinsValue), durationHours);
        }

        if (rates.cellsPerHour === '0') {
            const cellsValue = getFirstValue(['totalCells', 'cells', 'Cells Earned']) || '0';
            rates.cellsPerHour = formatRateWithNotation(standardizeNotation(cellsValue), durationHours);
        }

        if (rates.dicePerHour === '0') {
            const diceValue = getFirstValue(['totalDice', 'rerollShards', 'dice', 'Reroll Shards Earned']) || '0';
            rates.dicePerHour = formatRateWithNotation(standardizeNotation(diceValue), durationHours);
        }
    }

    return rates;
}

/**
 * Format rate with appropriate notation
 * @param {string|number} amount - Amount, possibly with notation
 * @param {number} hours - Duration in hours
 * @returns {string} - Formatted rate
 */
/**
 * Format rate with appropriate notation
 * @param {string|number} amount - Amount, possibly with notation
 * @param {number} hours - Duration in hours
 * @returns {string} - Formatted rate
 */
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
            let formatted_num = (rate / multiplier).toFixed(2);
            if (formatted_num.endsWith('.00')) {
                formatted_num = formatted_num.slice(0, -3);
            } else if (formatted_num.endsWith('0')) {
                formatted_num = formatted_num.slice(0, -1);
            }
            let formatted = formatted_num + not;
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
            return formatted;
        }
    }
    // If rate < 1000, return with K and 1 decimal place
    let formatted = rate.toFixed(1) + 'K';
    if (formatted.endsWith('.0K')) {
        formatted = formatted.slice(0, -3) + 'K';
    }
    return formatted;
}

/**
 * Converts duration string format to hours
 * @param {string} duration - Duration in format like "1h30m15s"
 * @returns {number} - Total hours as decimal
 */
function parseDurationToHours(duration) {
    if (!duration || duration === 'Unknown') {
        return 0;
    }

    const timeMatch = duration.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!timeMatch) {
        return 0;
    }

    const hours = timeMatch[1] ? parseInt(timeMatch[1]) : 0;
    const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const seconds = timeMatch[3] ? parseInt(timeMatch[3]) : 0;

    return hours + minutes / 60 + seconds / 3600;
}

/**
 * Checks for potential duplicate runs based on key fields.
 * @param {Object} extractedData - The data from the current run being submitted.
 * @param {Array} existingRuns - An array of the user's previous runs from the cache/API.
 * @returns {Object} - An object { isDuplicate: boolean, duplicateRunId: string|null }
 */
function findPotentialDuplicateRun(extractedData, existingRuns) {
    if (!extractedData || !existingRuns || existingRuns.length === 0) {
        return { isDuplicate: false, duplicateRunId: null };
    }

    // Define key fields for identifying duplicates
    const currentTier = extractedData.tier;
    const currentWave = extractedData.wave;
    const currentDuration = formatDuration(extractedData.duration || extractedData.roundDuration); // Use helper
    const currentCoins = extractedData.totalCoins || extractedData.coins || 0; // Use helper
    console.log(`[Duplicate Check] Current Run Data for Matching: Tier=${currentTier}, Wave=${currentWave}, Duration=${currentDuration}`);

    // Check if any existing run matches
    for (const existingRun of existingRuns) {
        const existingTier = existingRun.tier;
        const existingWave = existingRun.wave;
        const existingDuration = formatDuration(existingRun.duration || existingRun.roundDuration); // Use helper
        const existingCoins = existingRun.totalCoins || existingRun.coins || 0; // Use helper
        const existingRunId = existingRun.runId || existingRun._id || existingRun.id; 

        // Detailed logging for comparison
        //console.log(`[Duplicate Check] Comparing with Existing Run ID ${existingRunId}: Tier=${existingTier}, Wave=${existingWave}, Duration=${existingDuration}`);
        const tierMatch = currentTier == existingTier; // Use loose equality for potential type mismatch (e.g., 15 vs '15')
        const waveMatch = currentWave == existingWave; // Use loose equality
        const durationMatch = currentDuration === existingDuration; // Strict equality after formatting
        const coinMatch = currentCoins == existingCoins; // Use loose equality
        //console.log(`[Duplicate Check] Matches: Tier=${tierMatch}, Wave=${waveMatch}, Duration=${durationMatch}`);

        if (
            existingRunId && 
            tierMatch &&
            waveMatch &&
            durationMatch &&
            coinMatch
        ) {
            console.log(`[Duplicate Check] Found potential duplicate: Existing Run ID ${existingRunId}`);
            return { isDuplicate: true, duplicateRunId: existingRunId };
        }
    }

    // No duplicate found
    return { isDuplicate: false, duplicateRunId: null };
}

function getTierAndWave(lines) {
    let tier = 'Unknown';
    let wave = 'Unknown';
    let tierRaw = null;

    for (const line of lines) {
        const tierMatch = line.match(/Tier\s*[:|-]?\s*(\d+)(\s*\+)?/i);
        if (tierMatch) {
            tier = parseInt(tierMatch[1], 10);
            tierRaw = tierMatch[2] ? `${tierMatch[1]}+` : tierMatch[1];
        }
        const waveMatch = line.match(/Wave\s*[:|-]?\s*(\d+)/i);
        if (waveMatch) {
            wave = parseInt(waveMatch[1], 10);
        }
    }

    return { tier, wave, tierRaw };
}

function parseTierString(rawTier) {
    if (rawTier === null || rawTier === undefined) {
        return { numeric: null, hasPlus: false, display: null };
    }

    const str = String(rawTier).trim();
    if (!str) {
        return { numeric: null, hasPlus: false, display: null };
    }

    const normalizeDigits = (value) => {
        const cleaned = value.replace(/[^0-9]/g, '');
        return cleaned ? parseInt(cleaned, 10) : null;
    };

    const plusMatch = str.match(/(\d[\d.,]*)\s*\+/);
    if (plusMatch) {
        const numeric = normalizeDigits(plusMatch[1]);
        if (numeric !== null && !Number.isNaN(numeric)) {
            return { numeric, hasPlus: true, display: `${numeric}+` };
        }
    }

    const numberMatch = str.match(/(\d[\d.,]*)/);
    if (numberMatch) {
        const numeric = normalizeDigits(numberMatch[1]);
        if (numeric !== null && !Number.isNaN(numeric)) {
            return { numeric, hasPlus: false, display: String(numeric) };
        }
    }

    return { numeric: null, hasPlus: false, display: null };
}

function applyTierMetadata(target, rawTierCandidates = []) {
    if (!target || typeof target !== 'object') return target;

    const candidates = [];
    if (target.tierDisplay) candidates.push(target.tierDisplay);
    if (target.tier !== undefined && target.tier !== null) candidates.push(target.tier);

    const extras = Array.isArray(rawTierCandidates) ? rawTierCandidates : [rawTierCandidates];
    for (const value of extras) {
        if (value !== undefined && value !== null && value !== '') {
            candidates.push(value);
        }
    }

    let bestInfo = null;

    if (target.tierHasPlus && (target.tierDisplay || target.tier !== undefined)) {
        const existingInfo = parseTierString(target.tierDisplay || target.tier);
        if (existingInfo.numeric !== null && !Number.isNaN(existingInfo.numeric)) {
            bestInfo = { ...existingInfo, hasPlus: true };
        }
    }

    for (const candidate of candidates) {
        const info = parseTierString(candidate);
        if (info.numeric === null || Number.isNaN(info.numeric)) {
            continue;
        }

        if (!bestInfo || (info.hasPlus && !bestInfo.hasPlus)) {
            bestInfo = info;
        }
    }

    if (bestInfo && bestInfo.numeric !== null && !Number.isNaN(bestInfo.numeric)) {
        target.tier = bestInfo.numeric;
        target.tierDisplay = bestInfo.display || String(bestInfo.numeric);
        target.tierHasPlus = bestInfo.hasPlus;
    } else {
        if (typeof target.tier === 'number' && !Number.isNaN(target.tier)) {
            target.tierDisplay = target.tierDisplay || String(target.tier);
        }
        target.tierHasPlus = !!target.tierHasPlus;
    }

    return target;
}

function hasPlusTier(target, rawTierCandidates = []) {
    if (!target || typeof target !== 'object') return false;
    applyTierMetadata(target, rawTierCandidates);
    if (target.tierHasPlus) return true;
    const info = parseTierString(target.tierDisplay ?? target.tier);
    return info.hasPlus;
}

module.exports = {
    standardizeNotation,
    formatDuration,
    getNumberSuffix,
    toTitleCase,
    preprocessImage,
    extractDateTimeFromImage,
    extractTextFromImage,
    formatOCRExtraction,
    calculateHourlyRates,
    parseDurationToHours,
    formatDate,
    formatTime,
    findPotentialDuplicateRun,
    getDecimalForLanguage,
    ocrFieldTranslations,
    getTierAndWave,
    applyTierMetadata,
    hasPlusTier,
    formatNumberForDisplay,
    formatRateWithNotation,
    NOTATIONS,
    parseNumberInput,
    avg,
    parseTierString
};