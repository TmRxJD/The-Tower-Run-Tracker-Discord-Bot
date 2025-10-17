const { formatDate, formatTime, formatDuration } = require('./trackerHelpers');

const DEFAULT_FIELDS = {
    tier: 'Unknown',
    wave: 'Unknown',
    totalCoins: '0',
    totalCells: '0',
    totalDice: '0',
    killedBy: 'Apathy',
    roundDuration: '0h0m0s'
};

const STANDARD_TO_REMOTE_MAP = {
    tier: ['Tier'],
    wave: ['Wave'],
    totalCoins: ['Coins', 'Coins earned', 'Coins Earned', 'Battle Report Coins earned'],
    totalCells: ['Cells', 'Cells Earned'],
    totalDice: ['Dice', 'Reroll Shards', 'Reroll Shards Earned'],
    killedBy: ['Killed By'],
    roundDuration: ['Real Time', 'Game Time']
};

function findFirstValue(source, keys = []) {
    if (!source) return undefined;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const value = source[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                return value;
            }
        }
    }
    return undefined;
}


const MONTH_ABBREVIATIONS = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

function shouldDiscardKey(key) {
    if (!key) return false;
    if (MONTH_ABBREVIATIONS.has(key)) return true;
    if (/^\d/.test(key) && !key.includes(' ')) return true;
    if (/^\d+[hms]$/i.test(key)) return true;
    if (/^Battle Report\b/i.test(key) && key !== 'Battle Report Coins earned') return true;
    return false;
}

function normalizeParsedRunData(parsedRunData = {}, fallbackData = {}) {
    const normalized = { ...(parsedRunData || {}) };
    const hasParsedRunData = Object.keys(parsedRunData || {}).length > 0;

    for (const [field, defaultValue] of Object.entries(DEFAULT_FIELDS)) {
        const candidate =
            findFirstValue(parsedRunData, [field, ...(STANDARD_TO_REMOTE_MAP[field] || [])]) ??
            findFirstValue(fallbackData, [field, ...(STANDARD_TO_REMOTE_MAP[field] || [])]);
        normalized[field] = candidate !== undefined ? candidate : defaultValue;
    }

    // Normalize duration related fields
    const durationCandidate = findFirstValue(normalized, ['roundDuration', 'duration', 'Real Time', 'Game Time']);
    if (durationCandidate) {
        normalized.roundDuration = formatDuration(String(durationCandidate));
    } else {
        normalized.roundDuration = formatDuration(normalized.roundDuration);
    }

    const battleDate = normalized['Battle Date'] || normalized.battleDate;
    let dateObj = parseBattleDate(battleDate);
    if (!dateObj) {
        dateObj = parseBattleDate(createDateString(normalized.runDate || normalized.date, normalized.runTime || normalized.time));
    }

    if (dateObj) {
        normalized.runDate = formatDate(dateObj);
        normalized.runTime = formatTime(dateObj);
        normalized.date = normalized.date || normalized.runDate;
        normalized.time = normalized.time || normalized.runTime;
    } else {
        normalized.runDate = normalized.runDate || formatDate(new Date());
        normalized.runTime = normalized.runTime || formatTime(new Date());
        normalized.date = normalized.date || normalized.runDate;
        normalized.time = normalized.time || normalized.runTime;
    }

    normalized.notes = normalized.notes || fallbackData.notes || '';
    normalized.type = normalized.type || fallbackData.type || 'Farming';

    if (!hasParsedRunData) {
        for (const [key, value] of Object.entries(fallbackData || {})) {
            if (value === undefined || value === null) continue;
            if (Object.prototype.hasOwnProperty.call(normalized, key)) continue;
            if (shouldDiscardKey(key)) continue;
            normalized[key] = value;
        }
    }

    for (const key of Object.keys(normalized)) {
        if (shouldDiscardKey(key)) {
            delete normalized[key];
        }
    }

    return normalized;
}

function prepareRunDataForSubmission(runData = {}) {
    const prepared = { ...(runData || {}) };

    for (const [field, defaultValue] of Object.entries(DEFAULT_FIELDS)) {
        if (field === 'roundDuration') continue;
        if (!prepared[field] || String(prepared[field]).trim() === '') {
            prepared[field] = defaultValue;
        }
    }

    if (!prepared.roundDuration || String(prepared.roundDuration).trim() === '') {
        const durationCandidate = findFirstValue(prepared, ['duration', 'Real Time', 'Game Time']);
        prepared.roundDuration = formatDuration(String(durationCandidate || DEFAULT_FIELDS.roundDuration));
    } else {
        prepared.roundDuration = formatDuration(String(prepared.roundDuration));
    }

    for (const [field, remoteKeys] of Object.entries(STANDARD_TO_REMOTE_MAP)) {
        const value = prepared[field];
        if (value === undefined || value === null || String(value).trim() === '') continue;
        for (const remoteKey of remoteKeys) {
            if (remoteKey === 'Real Time' || remoteKey === 'Game Time') {
                prepared[remoteKey] = formatDurationForRemote(value);
            } else {
                prepared[remoteKey] = value;
            }
        }
    }

    prepared.notes = prepared.notes || '';
    prepared.Notes = prepared.notes;
    prepared.type = prepared.type || 'Farming';
    prepared.Type = prepared.type;

    const battleDate = buildBattleDateString(prepared);
    if (battleDate) {
        prepared['Battle Date'] = battleDate;
    }

    if (!prepared.runDate || !prepared.runTime) {
        const parsedDate = parseBattleDate(prepared['Battle Date']);
        if (parsedDate) {
            prepared.runDate = formatDate(parsedDate);
            prepared.runTime = formatTime(parsedDate);
        }
    }

    prepared.date = prepared.date || prepared.runDate;
    prepared.time = prepared.time || prepared.runTime;

    return prepared;
}

function formatDurationForRemote(duration) {
    if (!duration) return duration;
    const normalized = duration.toString().replace(/\s+/g, '').toLowerCase();
    const match = normalized.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!match) return duration;
    const [, h, m, s] = match;
    const parts = [];
    if (h) parts.push(`${parseInt(h, 10)}h`);
    if (m) parts.push(`${parseInt(m, 10)}m`);
    if (s) parts.push(`${parseInt(s, 10)}s`);
    if (!parts.length) return duration;
    return parts.join(' ');
}

function buildBattleDateString(runData = {}) {
    const combined = createDateString(runData.runDate || runData.date, runData.runTime || runData.time);
    const parsed = parseBattleDate(combined);
    if (!parsed) return runData['Battle Date'];
    const datePortion = parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const hours = parsed.getHours().toString().padStart(2, '0');
    const minutes = parsed.getMinutes().toString().padStart(2, '0');
    return `${datePortion} ${hours}:${minutes}`;
}

function parseBattleDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function createDateString(dateStr, timeStr) {
    if (!dateStr) return null;
    if (!timeStr) return dateStr;
    return `${dateStr} ${timeStr}`;
}

function sanitizeRunDataForUpload(runData = {}) {
    const disallowedKeys = new Set([
        'runId',
        'id',
        'timestamp',
        'settings',
        'screenshotBuffer',
        'screenshotName',
        'lastUpdated',
        'runCount'
    ]);
    const sanitized = {};
    for (const [key, value] of Object.entries(runData || {})) {
        if (value === undefined) continue;
        if (disallowedKeys.has(key)) continue;
        sanitized[key] = value;
    }
    return sanitized;
}

module.exports = {
    normalizeParsedRunData,
    prepareRunDataForSubmission,
    formatDurationForRemote,
    buildBattleDateString,
    parseBattleDate,
    sanitizeRunDataForUpload
};
