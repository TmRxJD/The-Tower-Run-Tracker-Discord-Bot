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
