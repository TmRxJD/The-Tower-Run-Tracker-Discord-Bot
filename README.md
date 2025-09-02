# The Tower Run Tracker

A powerful Discord bot for tracking, analyzing, and sharing Tower Run results. Designed for the Tower Run community, this bot supports both automated screenshot uploads and manual entry, with advanced features for data review, editing, sharing, and migration. This bot is paired with a website made for the purpose of visualizing data, both mobile and desktop friendly.

## Features

### 🏆 Core Tracking
- **/track**: Main command to track and analyze your Tower runs.
  - Upload a screenshot of your run results for automatic OCR extraction and data entry.
  - Or, use the manual entry flow to input run details yourself.
  - Supports duplicate detection, confirmation before submission, and customizable settings.
  - Screenshots can be attached directly with command or later in the menu.

### 📈 Data Analysis & Visualization
- **View Runs**: Browse your last X runs, with detailed stats and charts.
- **Edit Last / Edit Current Run**: Modify data from your most recent or current run.
- **Share Run**: Generate a shareable embed of your run results for Discord to show off your earnings.

### 🧮 Utilities
- **/cph**: Calculate coins or cells earned per hour from your run time and rewards.
- **/reload**: Reload a specific command without restarting the bot (for admins/developers).

### ⚙️ Settings & Customization
- **Settings Menu**: Configure your personal preferences, including:
  - OCR scan language
  - Timezone
  - Default tracker type (Web or Google Spreadsheet)
  - Duplicate detection and confirmation options
  - Sharing preferences

### 🔄 Migration & Data Import
- **/migrate_user_tracker**: Migrate tracker data for a specific user from legacy formats or Google Sheets.
- **Automatic Import**: On first use, the bot will import previous runs from user's Google Sheet if they have been using the old tracker bot.

### 📊 Google Sheets Integration
- **Spreadsheet Tracker**: Optionally use a Google Spreadsheet as your data backend.
- **Sheet Data Import/Export**: Import runs from a sheet, or get a link to your personal tracker sheet.

### 🕒 Scheduled Tasks
- **Chart Generation**: Automatically generates and posts comparison charts every Thursday and Sunday at 10:00 AM (configurable).

### 🛠️ Advanced
- **Session Management**: Keeps user sessions for smooth multi-step flows and prevents memory leaks with automatic cleanup.
- **Event-Driven Architecture**: Uses an event emitter for modular, scalable command and UI handling.
- **Error Handling**: Robust error reporting and user feedback for all commands and flows.

## Getting Started

1. **Clone the repository and install dependencies:**
   ```powershell
   git clone https://github.com/TmRxJD/TheTowerRunTrackerBot.git
   cd TheTowerRunTrackerBot
   npm install
   ```

2. **Setup your configuration:**
   - Copy `config.example.json` to `config.json` and fill in your bot token, client ID, and guild IDs.
   - Copy `google_credentials.example.json` to `google_credentials.json` and add your Google API credentials.
   - Create a `.env` file if using the API (see `.env.example`).

3. **Deploy slash commands:**
   ```powershell
   node deploy-commands.js
   ```

3. **Run the bot:**
   ```powershell
   node TrackerBot.js
   ```

## File Structure

- `TrackerBot.js` - Main bot entry point.
- `commands/utility/` - All utility and tracker-related commands.
- `commands/utility/TrackerUtils/` - Core tracker logic, handlers, and UI components.
- `events/` - Discord event handlers (ready, interactionCreate).
- `config.json` (ignored) - Your bot’s secrets and config (use `config.example.json` as a template).
- `google_credentials.json` (ignored) - Google API credentials (use `google_credentials.example.json` as a template).
- `.env` (ignored) - Environment variables for API.

## Security

- **Sensitive files (`config.json`, `.env`, `google_credentials.json`, `bot-token.txt`, `node_modules/`) are ignored by git and never uploaded.**
- Always keep backups of your local config files.

## Special Thanks

A heartfelt thank you to all the beta testers who helped shape The Tower Run Tracker bot. Your feedback, patience, and willingness to deal with bugs and growing pains made all the difference. This project would not be what it is today without your dedication and support. Every suggestion, bug report, and late-night test run helped make the bot better for everyone. Thank you for believing in the vision and for being part of this journey!

## Contributing

Pull requests and suggestions are welcome! Please open an issue or PR for any improvements or bug fixes.