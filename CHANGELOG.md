# Changelog

## 2026-10-02

### Fixed
- Verify complete read-only cloud history before paste/OCR duplicate checks, submission numbering and sharing. Reject partial/error history rather than resetting numbering to #1; refresh cached share counts.
- Serialize submissions per user and recheck duplicates at save time. Count retained history per run type across tiers, including pending local uploads; exclude stale/deleted cloud-backed entries from the counting view without deleting records. Preserve existing lifetime entry behavior.

## 2026-10-01

### Fixed
- Restore corrected Orbs comparisons using compatible counts within rolling windows; keep Last Run tied to the actual prior run. Show unavailable/zero-baseline labels, reuse explicit raw parsed counts without migration, and preserve zero coverage. Shared logic is pinned with a tracked pnpm patch.
- Treat abandoned add-run modals as normal expiry while retaining unexpected errors.
- Add a read-only cloud connectivity probe and one startup/recovery reconciliation receipt for operational verification.

## 2026-09-29

### Fixed
- **Commands needing several tries.** Writing a heavy user's run history to the local RxDB cache blocked the event
  loop for seconds (7.2s measured for 1,359 runs), so interactions arriving meanwhile expired before the bot
  could acknowledge them. Runs are now written 25 at a time with a yield between slices (worst stall 7.2s -> 0.44s).
- **Bot frozen for hours after a cache reset.** A schema mismatch or one user's corrupt read wiped the whole
  local cache key by key on the event loop. The cache directory is now renamed aside and deleted by a detached
  process; concurrent recoveries share one run and repeats are rate limited.
- **"Couldn't open menu" for accounts with no runs yet.** An empty account is now an empty menu.
- SIGINT/SIGTERM now actually exit; `shardDisconnect` no longer releases the instance lock while the bot keeps running.
- Single-instance locks expire when their heartbeat stops, so a recycled pid cannot block startup.
- Buttons and selects from expired menus now get an explanatory reply instead of "This interaction failed".
- Deleting a run no longer loads and stitches the user's whole history first.

### Changed
- The 15 minute background sync only covers users seen in the last 7 days (`TRACKER_BACKGROUND_SYNC_ACTIVE_DAYS`)
  and aborts after 5 consecutive unreachable-cloud results.
- Repeated identical log messages are limited to 20/minute with a "suppressed N repeats" summary
  (`BOT_LOG_THROTTLE_PER_MINUTE`, 0 disables).
- Gateway disconnect/reconnect/resume/error events are logged.
- PM2 config sets `UV_THREADPOOL_SIZE=16`.

### Deploy
- `deploy:activate` now rebuilds `dist/` (in place) and runs `pm2 startOrRestart ecosystem.config.cjs` so new code and ecosystem env
  changes take effect; a plain `pm2 restart --update-env` did neither. `DEPLOY_SKIP_BUILD=true` skips the rebuild.
