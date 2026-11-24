# Track Feature Architecture

This folder contains the run-tracking feature implemented as an interaction-first, modular domain.

## Core Principles

- Single source of custom IDs: `track-custom-ids.ts`
- Interaction-only UX (no message listeners)
- Local-first persistence with cloud sync fallback
- Handler domains split by responsibility

## Folder Overview

- `handlers/`
  - `data-review-handlers.ts`: review/edit/submit interactions
  - `upload-handlers.ts`: OCR/paste/add-run orchestration and stable facade exports
  - `view-runs-handlers.ts`: filters, paging, and runs sharing
  - `settings-handlers.ts`: settings menus, toggles, import/stats/share settings
  - `remove-handlers.ts`: remove-last prompt + confirm actions
  - `manual-handlers.ts`: manual entry flow (factory-based to avoid circular coupling)
  - `share-handlers.ts`: share-last-run interaction
- `track-custom-ids.ts`: centralized component/modal IDs and token helpers
- `track-workflow.ts`: slash-command entry orchestration
- `tracker-api-client.ts`: local/cloud data orchestration
- `local-run-store.ts`: local persistence + cloud queue
- `pending-run-store.ts`: pending interaction/session storage
- `view-runs-store.ts`: in-memory view state
- `interaction-types.ts`: lightweight shared interaction interfaces
- `ui/`: embed/button/select builders
- `share/`: share-specific composition state/embeds

## Dependency Direction

- `track-workflow.ts` -> `handlers/*`
- `interactions/index.ts` -> `handlers/index.ts`
- Domain handlers -> stores/api/helpers/ui
- Stores/helpers/ui do not depend on handlers

## Maintenance Rules

- Add new tracker custom IDs only in `track-custom-ids.ts`
- Place new component handlers in the closest domain file under `handlers/`
- Re-export externally consumed handlers from `handlers/index.ts`
- Keep heavy orchestration in workflow/handlers, keep stores side-effect-focused

## Deprecated input fallback

Use /track to paste the in-game Battle Report export, or choose **Import Save File** for a supported desktop save or Android tool export. A screenshot attached alongside a pasted report is optional evidence; it is not OCR input while the fallback is off. With the fallback off, /lifetime still opens saved entries; use the structured save import to add new Lifetime Stats.

Manual entry and screenshot OCR stay in the code for rollback. Both are off unless `TRACKER_BOT_ENABLE_LEGACY_INPUT=true`. On the self-hosted production runner, set that value in the existing local `.env.prod.local` (not in Git), then use the next authorized, deployment-eligible push to `main`. The runner loads the same production env for command registration and activation. Applying only an env change does not update the registered slash options or the running bot. Remove the variable or set it to `false` and use the same runner process to disable both again. Do not deploy or restart the bot manually.
