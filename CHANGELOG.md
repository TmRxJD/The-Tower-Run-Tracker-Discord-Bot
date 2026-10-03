# Changelog

## 2026-10-03

### Fixed
- Release per-user mutation locks after durable saves, session consumption and coherent history capture; perform chart rendering, Discord replies and automatic log-channel sharing on a separate ordered delivery lane. Slow delivery no longer prevents a second run from saving. Apply the same separation to lifetime submission delivery and observe background-sync rejection immediately.
- Carry the captured run history into submission and automatic-share charts; preserve duplicate checks, selected-run state and repeated-submit protection while delivery is pending.
- Diagnose long-held operation locks and failed waits with salted scope hashes, operation names, safe stages and elapsed times. Keep existing wait deadlines and retain protection around unfinished writes and hydration.

## 2026-10-02

### Fixed
- Await persistent SQLite commits for successful local-only saves/edits/imports/deletes and deferred cloud queue acknowledgements; sync screenshot files before committing references and roll back failed queue/settings/lifetime mutations in memory.
- Preserve offline currency/duration values in shared RxDB serialization and keep local storage identities distinct from cloud identities. Recover unsynced snapshots across cloud re-enable, enqueue using immutable original targets, retire confirmed cloud entries and exclude durable deletion receipts from restoration.
- Validate required values before new direct/review/import writes; retain genuine zero, reject missing/invalid/unsupported numeric notation, and display missing optional metrics as unavailable in submission, share and menu summaries.
- Bound inactive transient UI caches while retaining no-expiry share snapshots on durable storage; preserve unknown targets rather than guessing Main after expiry.
- Publish controlled incident metadata in error channels without raw exceptions, OCR, filenames, URLs or screenshots; sanitize secondary Vision, screenshot verification and deferred submission diagnostics.
- Preserve exhausted cloud queue entries and screenshots; allow explicit retry, retain pending edits in queue counts, restore queued payloads after cache misses, and serialize queue replacement/replay/deletion receipts.
- Capture upload profile once across save/import/retry paths, distinguish explicit Main from unknown legacy targets, preserve verified cloud ownership/profile, and reject non-404 creation assumptions. Preserve and block legacy new-run queue targets needing an explicit choice.
- Reuse the selected document ID after partial cloud pair writes, including duplicate updates and simultaneous retries, to avoid a second main document.
- Remove shared JWT identity inheritance and bound both identity cache layers; verify import cancellation ownership.
- Replace startup locks with immutable owner markers and ownership-safe release; shut down on gateway invalidation, allow ten seconds for PM2 shutdown, and require a fresh Discord-ready receipt during deployment verification.
- Bound delta/share requests and screenshot/import downloads, and remove raw delta-response previews from diagnostics.
- Preserve the delta sync cursor when a menu refresh stops before the final page. Fail incomplete bulk imports without checkpointing skipped pages, so retries can recover missing history and edits.
- Refresh selected run data before sharing and bind new share buttons to a captured data/count version. Keep report headline values aligned with the summary; missing snapshots do not silently select another run. Existing posts and cloud records remain unchanged.
- Add bounded, redacted local paste diagnostics with seven-day default retention, private storage, safe references and failure responses; storage errors cannot interrupt run handling.
- Stop reporting active owner-bound modal collector submissions as dropped interactions. Retain diagnostics for unowned, expired and failed waits; capture ownership before asynchronous dispatch so successful collectors are not falsely flagged.
- Verify complete read-only cloud history before paste/OCR duplicate checks, submission numbering and sharing. Reject partial/error history rather than resetting numbering to #1; refresh cached share counts.
- Serialize submissions per user and recheck duplicates at save time. Count retained history per run type across tiers, including pending local uploads; exclude stale/deleted cloud-backed entries from the counting view without deleting records. Preserve existing lifetime entry behavior.

## 2026-10-01

### Fixed
- Preserve exhausted cloud queue entries and screenshots; allow explicit retry, retain pending edits in queue counts, restore queued payloads after cache misses, and serialize queue replacement/replay/deletion receipts.
- Capture upload profile once across save/import/retry paths, distinguish explicit Main from unknown legacy targets, preserve verified cloud ownership/profile, and reject non-404 creation assumptions. Preserve and block legacy new-run queue targets needing an explicit choice.
- Reuse the selected document ID after partial cloud pair writes, including duplicate updates and simultaneous retries, to avoid a second main document.
- Remove shared JWT identity inheritance and bound both identity cache layers; verify import cancellation ownership.
- Replace startup locks with immutable owner markers and ownership-safe release; shut down on gateway invalidation, allow ten seconds for PM2 shutdown, and require a fresh Discord-ready receipt during deployment verification.
- Bound delta/share requests and screenshot/import downloads, and remove raw delta-response previews from diagnostics.
- Restore corrected Orbs comparisons using compatible counts within rolling windows; keep Last Run tied to the actual prior run. Show unavailable/zero-baseline labels, reuse explicit raw parsed counts without migration, and preserve zero coverage. Shared logic is pinned with a tracked pnpm patch.
- Treat abandoned add-run modals as normal expiry while retaining unexpected errors.
- Add a read-only cloud connectivity probe and one startup/recovery reconciliation receipt for operational verification.

## 2026-09-29

### Fixed
- Preserve exhausted cloud queue entries and screenshots; allow explicit retry, retain pending edits in queue counts, restore queued payloads after cache misses, and serialize queue replacement/replay/deletion receipts.
- Capture upload profile once across save/import/retry paths, distinguish explicit Main from unknown legacy targets, preserve verified cloud ownership/profile, and reject non-404 creation assumptions. Preserve and block legacy new-run queue targets needing an explicit choice.
- Reuse the selected document ID after partial cloud pair writes, including duplicate updates and simultaneous retries, to avoid a second main document.
- Remove shared JWT identity inheritance and bound both identity cache layers; verify import cancellation ownership.
- Replace startup locks with immutable owner markers and ownership-safe release; shut down on gateway invalidation, allow ten seconds for PM2 shutdown, and require a fresh Discord-ready receipt during deployment verification.
- Bound delta/share requests and screenshot/import downloads, and remove raw delta-response previews from diagnostics.
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

## 2026-10-02 — Private-safe share diagnostics
- Preserve original share delivery exception codes; local diagnostics retain allowlisted exception type/code, repository-only stack locations, operation/stage and incident correlation. Public alerts retain category/reference only; share failure replies no longer echo arbitrary exception messages.
- Historical 21:46:59 share root cause remains unknown; no real-share replay or historical data changes.

## 2026-10-02 — Share history latency and retry amplification
- Complete history loads query extended records in validated ID batches instead of one GET per run. Outstanding reads are coalesced across timeouts/retries with a bounded128-user pending map.
- Share Last assembles authoritative complete rows/counts in memory instead of writing every historical run to the local cache. Read-only timeout text no longer claims nothing was saved. Minimal process-scoped failure timing metadata avoids raw user IDs/content.
- Historical reported share failures are consistent with this recent path change; exact affected users and network/rate-limit causes remain unproved.

- Cooperative45-second deadline checks stop further SDK pages after timeout; unresolved SDK calls remain coalesced until settled because the SDK has no per-request abort hook. Extended rows are checked against authoritative main owner/profile; tests cover fresh mutation counts and capacity cleanup.


## 2026-10-03 — Black Hole coverage comparison correction
- Compare only explicit killsWithBlackHole (Killed With Effect Active) measurements; legacy hits/weapon kills/stored percentages cannot masquerade as corrected comparison data. Compatible rolling windows and actual prior-run selection match established Orbs correctness without changing other metrics.
- Recover explicit corrected raw fields, preserve genuine zero and unavailable comparisons, and align submission/share/table/chart numbers. No historical record rewrite; existing Discord images need regeneration.

