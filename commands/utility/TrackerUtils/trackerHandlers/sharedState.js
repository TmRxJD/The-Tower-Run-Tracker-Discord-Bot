// Shared state and event emitter for tracker handlers
const EventEmitter = require('events');

const userSessions = new Map();
const userSettings = new Map();
const trackerEmitter = new EventEmitter();

module.exports = {
    userSessions,
    userSettings,
    trackerEmitter // Export the emitter instance
}; 