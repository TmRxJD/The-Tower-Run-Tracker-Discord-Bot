const trackerApi = require('./commands/utility/TrackerUtils/trackerHandlers/trackerAPI.js');
const fs = require('fs');

const text = fs.readFileSync('./test_parse', 'utf8');

trackerApi.parseBattleReport(text).then(result => {
    console.log('Parsed result:');
    console.log(JSON.stringify(result, null, 2));
}).catch(err => {
    console.error('Error:', err);
});