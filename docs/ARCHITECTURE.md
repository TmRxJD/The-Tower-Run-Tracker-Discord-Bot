# Tower Run Tracker Bot Architecture

## Project Goals

- Keep slash commands, persistent components, and modal flows on a single interaction-routing model.
- Centralize custom-id creation and parsing for the tracker feature so new flows do not regress into ad hoc string handling.
- Use shared ownership helpers for modal waits so collector-owned interactions do not require fake global handlers.
- Keep the bot aligned with the same interaction framework rules used in ModBot and ToolsBot.

## Core Interaction Files

```text
src/
  bot.ts                          # startup wiring and client bootstrap
  core/
    interaction-router.ts         # global interactionCreate listener
    component-registry.ts         # kind-aware persistent component registry
    interaction-session.ts        # shared owned modal submit helpers
  interactions/
    index.ts                      # persistent component registration
  features/
    track/
      track-custom-ids.ts         # shared tracker custom-id construction and parsing
      handlers/                   # track interaction handlers and flows
```

## Interaction Flow

1. `bot.ts` registers the startup router and persistent interaction handlers.
2. `interaction-router` handles Discord interactions in this order:
   - chat input commands
   - registered message components and modals through `component-registry`
3. Persistent interaction families are registered in `src/interactions/index.ts`.
4. Command-local or flow-local modal waits stay local to the initiating interaction through `awaitOwnedModalSubmit(...)`.

## Interaction Rules

- Persistent components go through `component-registry`; local modal waits should not add placeholder global registrations.
- Modal waits must use `awaitOwnedModalSubmit(...)` from `src/core/interaction-session.ts` so ownership is filtered by both custom id and initiating user id.
- Shared custom-id builders and parsers belong in `src/features/track/track-custom-ids.ts` or another feature-local helper module, not inside individual handlers.
- Persistent handler lookup should rely on exact or longest-prefix matching rather than local `split(':')` or `slice(prefix.length)` parsing in each caller.
- Router support must remain compatible with buttons, all select-menu variants, and modals even if a given feature currently uses only a subset.
- Unregistered modal submissions should return quietly when they belong to command-local ownership flows.

## Tracker Feature Conventions

- `TRACKER_IDS` is the source of truth for persistent custom-id prefixes and exact ids.
- `withToken(...)`, `withTokenAndField(...)`, and related parser helpers should be reused whenever a tracker interaction carries a session token.
- Remove-token packing, view-runs orientation targets, and other tracker-specific id formats should stay in `track-custom-ids.ts` so handlers only consume parsed values.
- When a handler depends on a parsed token, it must guard expired or missing tokens before touching session state.

## Parity Notes

- TrackerBot now matches ModBot and ToolsBot at the core framework layer: one router, one kind-aware component registry, shared ownership helpers, and centralized interaction-id contracts.
- Future TrackerBot interaction work should extend that shared contract instead of introducing feature-local parsing shortcuts.
