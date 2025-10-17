const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
require('dotenv').config();

const API_URL = process.env.TRACKER_API_URL;
const API_KEY = process.env.TRACKER_API_KEY;
const TEST_USER_ID = process.env.TEST_TRACKER_USER_ID || '999999999999999999';
const TEST_USERNAME = process.env.TEST_TRACKER_USERNAME || 'ApiTestUser';
const NOTE_PREFIX = process.env.TEST_TRACKER_NOTE || 'Automated endpoint test';

if (!API_URL || !API_KEY) {
    console.error('Missing TRACKER_API_URL or TRACKER_API_KEY in environment.');
    process.exit(1);
}

const headers = {
    Authorization: API_KEY,
    'Content-Type': 'application/json'
};

function buildStatsFromReport(reportText) {
    const cleaned = String(reportText || '').replace(/\r/g, '').trim();
    if (!cleaned) {
        return { rawBattleReport: '', sectionStats: {}, flatStats: {} };
    }
    const sanitizedLines = cleaned.replace(/,/g, '.').split(/\n+/);
    const originalLines = cleaned.split(/\n+/);
    const knownSections = new Set([
        'Battle Report',
        'Combat',
        'Utility',
        'Enemies Destroyed',
        'Bots',
        'Guardian'
    ]);
    const sectionStats = {};
    const flatStats = {};
    let currentSection = 'Battle Report';

    const ensureSection = (sectionName) => {
        if (!sectionStats[sectionName]) {
            sectionStats[sectionName] = {};
        }
    };

    for (let idx = 0; idx < sanitizedLines.length; idx += 1) {
        const sanitizedLine = sanitizedLines[idx]?.trim();
        const originalLine = originalLines[idx]?.trim();
        if (!sanitizedLine) continue;

        if (knownSections.has(sanitizedLine)) {
            currentSection = sanitizedLine;
            ensureSection(currentSection);
            continue;
        }

        const spacingMatch = sanitizedLine.match(/^(.+?)\s{2,}(.+)$/);
        const colonMatch = sanitizedLine.match(/^(.+?)\s*[:|-]\s*(.+)$/);
        let label = '';
        let value = '';

        if (spacingMatch) {
            label = spacingMatch[1].trim();
            const originalSpacing = originalLine?.match(/^(.+?)\s{2,}(.+)$/);
            value = (originalSpacing && originalSpacing[2]) || spacingMatch[2];
        } else if (colonMatch) {
            label = colonMatch[1].trim();
            const originalColon = originalLine?.match(/^(.+?)\s*[:|-]\s*(.+)$/);
            value = (originalColon && originalColon[2]) || colonMatch[2];
        }

        if (!label || !value) continue;

        ensureSection(currentSection);
        const storedValue = value.trim();
        sectionStats[currentSection][label] = storedValue;
        const flatKey = currentSection === 'Battle Report' ? label : `${currentSection} ${label}`;
        flatStats[flatKey] = storedValue;
    }

    return { rawBattleReport: cleaned, sectionStats, flatStats };
}

async function parseBattleReport(battleReport) {
    console.log('Parsing battle report...');
    const response = await axios.post(
        `${API_URL}/parse-battle-report`,
        { battleReport },
        { headers }
    );
    console.log('Parse response keys:', Object.keys(response.data));
    let runData = response.data?.runData || response.data?.data?.runData || response.data;
    if (runData && typeof runData === 'object') {
        if (runData.summary && typeof runData.summary === 'object') {
            runData = runData.summary;
        } else if (runData.parsedRun && typeof runData.parsedRun === 'object') {
            runData = runData.parsedRun;
        }
    }
    if (!runData || typeof runData !== 'object') {
        throw new Error('Parse endpoint did not return runData.');
    }
    console.log('Parsed run data preview:', {
        tier: runData.tier,
        wave: runData.wave,
        totalCoins: runData.totalCoins,
        runDate: runData.runDate || runData.date,
        runTime: runData.runTime || runData.time
    });
    console.dir(runData, { depth: 2 });
    return runData;
}

async function submitRun(runData) {
    console.log('Submitting run summary...');
    const note = `${NOTE_PREFIX} ${new Date().toISOString()}`;
    console.log('runData keys being submitted:', Object.keys(runData));
    const payload = {
        userId: TEST_USER_ID,
        username: TEST_USERNAME,
        note,
        runData
    };
    console.log('Submitting payload preview:', {
        runDataKeys: Object.keys(runData).length
    });
    const response = await axios.post(
        `${API_URL}/run-summary`,
        payload,
        { headers }
    );
    console.log('Run summary response keys:', Object.keys(response.data));
    return { response: response.data, note };
}

function selectMostRecentRun(runs = []) {
    if (!Array.isArray(runs) || runs.length === 0) {
        return null;
    }
    const sorted = runs.slice().sort((a, b) => {
        const dateA = new Date(`${a.runDate || a.date}T${a.runTime || a.time || '00:00:00'}`);
        const dateB = new Date(`${b.runDate || b.date}T${b.runTime || b.time || '00:00:00'}`);
        return dateB - dateA;
    });
    return sorted[0];
}

async function fetchRuns() {
    console.log('Fetching runs to verify...');
    const response = await axios.get(
        `${API_URL}/runs`,
        {
            params: { userId: TEST_USER_ID },
            headers
        }
    );
    const runs = response.data?.runs || (Array.isArray(response.data) ? response.data : []);
    console.log(`Retrieved ${runs.length} run(s) for user ${TEST_USER_ID}.`);
    return runs;
}

(async function main() {
    try {
        const battleReportPath = path.join(__dirname, '..', 'test_paste');
        const battleReport = fs.readFileSync(battleReportPath, 'utf8');
        const runData = await parseBattleReport(battleReport);
        const { note } = await submitRun(runData);
        const runs = await fetchRuns();
        const lastRun = selectMostRecentRun(runs);
        if (!lastRun) {
            throw new Error('No runs returned when verifying.');
        }
        console.log('Last run summary:', {
            tier: lastRun.tier,
            wave: lastRun.wave,
            totalCoins: lastRun.totalCoins || lastRun.coins,
            rerollShards: lastRun.rerollShards || lastRun.totalDice,
            killedBy: lastRun.killedBy,
            note: lastRun.note,
            runDate: lastRun.runDate || lastRun.date,
            runTime: lastRun.runTime || lastRun.time
        });
        if (lastRun.note !== note) {
            console.warn('Warning: returned note does not match submitted note');
        }
        if (lastRun.wave !== runData.wave) {
            console.warn('Warning: wave mismatch between parsed data and stored run');
        }
        if (String(lastRun.tier) !== String(runData.tier)) {
            console.warn('Warning: tier mismatch between parsed data and stored run');
        }
        const matchingRun = runs.find(r => r.note === note);
        if (matchingRun) {
            console.log('Matched stored run by note:', {
                tier: matchingRun.tier,
                wave: matchingRun.wave,
                totalCoins: matchingRun.totalCoins || matchingRun.coins,
                rerollShards: matchingRun.rerollShards || matchingRun.totalDice,
                runDate: matchingRun.runDate || matchingRun.date,
                runTime: matchingRun.runTime || matchingRun.time,
                note: matchingRun.note
            });
            console.dir(matchingRun, { depth: 1 });
        } else {
            console.warn('Warning: newly submitted run with matching note was not found.');
        }
        console.log('Endpoint test completed successfully.');
    } catch (error) {
        console.error('Endpoint test failed:', error.response?.data || error.message || error);
        process.exit(1);
    }
})();
