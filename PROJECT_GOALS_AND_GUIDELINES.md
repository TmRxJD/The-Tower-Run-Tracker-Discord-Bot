# Project Goals & Guidelines

This document captures the objectives, architecture, and data map for the Tracker Bot TypeScript rewrite so any contributor can resume work after interruption.

## High-Level Goals
- Rewrite the legacy JS tracker bot in TypeScript using the Tower Mod Bot architecture (central router, registries, typed config/env, dev/prod modes).
- Preserve full feature parity with the legacy bot (commands, flows, behaviors) while removing message-content listeners and using slash commands + components/modals only.
- Centralize wording/layout into a single dashboard-editable config (ui_config in Appwrite), including unused/optional fields (left null/empty) and role thresholds.
- Use Appwrite for persistence where the legacy bot stored data locally (guilds, users/settings, analytics, config), keeping cooldowns/transient state in-memory. Runs stay in the existing external tracker API (no Appwrite runs collection).
- Prepare for a future web dashboard: stable config schemas, repos, and versioned configs to allow runtime reloads without code changes.

## Target Architecture (mirrors mod bot)
- `src/bot.ts`: bootstrap with env-aware config; registers commands, events, interaction router, components, logging.
- `config/`: env loader, typed app config, config validation.
- `core/`: client wrapper, logger, interaction router (global), command registry, component registry.
- `commands/`: slash commands (`track`, `analytics`, `cph`, others for parity like reload/migrate if needed).
- `interactions/`: button/select/modal handlers registered via the router (no per-command ad-hoc listeners).
- `features/tracker/`: domain logic modules (upload, manual entry, edit, settings, share, view runs, import/migrate, menu/navigation, error handling, helpers, tracker API client wrapper, UI builders consuming ui_config).
- `persistence/`: Appwrite client; repos for guilds, users (with settings/share prefs + cached username), analytics; config loaders (ui_config, bot_config) with version caching.
- `events/`: ready, interaction create, guild create/delete.
- `utils/`: formatting, OCR helpers, shared utilities.
- `scripts/`: command registration, seeds, migrations as needed.

## Commands (parity list)
- `/track`: Full tracker workflow (add/upload/paste/manual/settings/edit/share/view runs/import; navigation via router; no message listeners; uses modals/selects).
- `/analytics`: Reports usage stats from Appwrite analytics collection.
- `/cph`: Compute rates; pure logic (no intents).
- `/update-roles`: Removed (roles now update automatically on upload).
- Other legacy utility commands (e.g., reload, migrateToNewTracker) to be ported for parity as needed.

## Interaction & State Handling
- Intents trimmed: no message-content listeners. All input via slash commands, buttons, selects, modals.
- Global interaction router with namespaced, versioned custom IDs. Stale interactions respond with a fresh entry point using current config/API data.
- Transient interaction state in-memory with TTL; critical data re-derived from tracker API and Appwrite. No sessions collection.

## Appwrite Data Map (minimal, indexed)
- Collection `guilds`
  - Fields: guildId (unique), firstSeen, guildPrefs? (optional)
  - Indexes: unique on guildId

- Collection `users`
  - Fields: userId (unique), username (cached), lastSeen, defaultTracker, defaultRunType, scanLanguage, decimalPreference, share settings, other prefs
  - Indexes: unique on userId

- Collection `ui_config`
  - Doc key: `tracker_ui`
  - Fields: env, version/etag, updatedAt, wording/layout for all embeds/buttons/views, role thresholds, optional fields present as null/empty
  - Purpose: single source of truth for all user-facing text and layouts; dashboard-editable

- Collection `bot_config`
  - Doc keys: `tracker_bot_dev`, `tracker_bot_prod` (or similar per env)
  - Fields: non-wording settings/feature flags/URLs

- Collection `analytics`
  - Fields: ts/day, event type (command/run), userId, guildId?, commandName, runId?, meta
  - Indexes: date/event/userId for reporting

- **Not stored in Appwrite**: Runs/logged data remain in the external tracker API (unchanged endpoints/auth).

## Config Strategy
- `.env.dev` uses `DEV_DISCORD_TOKEN`, `DEV_CLIENT_ID`, `DEV_GUILD_ID`; `.env.prod` uses `DISCORD_TOKEN`, `CLIENT_ID`, and no guild ID by default, alongside DEPLOYMENT_MODE and the required Appwrite/tracker secrets.
- ui_config in Appwrite contains a document with a single json containing: main menu copy, button/row layouts, upload/paste/manual prompts, data review/edit wording, settings options, share/view texts, success/error texts, role thresholds, tracker links, stale-interaction behavior, placeholders for unused fields.
- bot_config in Appwrite holds non-wording toggles/URLs.

## External Integrations
- Tracker API: keep existing endpoints/auth (`Authorization: API_KEY`), used for run CRUD and user settings retrieval.
- Discord: slash commands + components/modals only; no message listeners due to intents constraints.

## Style & Testing Guidelines
- TypeScript-first, follow mod bot patterns; typed configs and repos.
- Centralized logging/error handling; graceful fallbacks for stale interactions.
- Keep cooldowns in-memory unless later scaled horizontally.
- Preserve behavior parity; when replacing text collectors, use modals with equivalent validations.
- Plan to add unit coverage for pure helpers where feasible; manual QA for interaction flows.

## Recovery Notes
- If interrupted: reload ui_config/bot_config from Appwrite, verify env files, ensure router/registries are wired, and re-run command registration script.
- Use this document to realign scope and data shapes before resuming implementation.
