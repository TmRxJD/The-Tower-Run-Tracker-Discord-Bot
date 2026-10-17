## 2026-10-17 - Reduce verified history and sharing waits

- Overlap at most two independent linked/legacy owner histories while preserving fresh count/schema/ownership checks, deterministic order and failed-wave draining. A 1,361-run history measured 8.98-9.44 s before versus 7.50-7.63 s after; main-only review 5.68-5.79 s versus 4.36-4.46 s, with all fields equal.
- Overlap fresh shared display settings with share history. Retain separate current-history verification across actions and website edit/deletion correctness.
- Add content-free Discord REST wait/import-operation diagnostics and a reusable read-only stage probe. See docs/LATENCY-2026-10-17.md for validation and limits.

## 2026-10-15 - Mirror published website Updates to Discord

- Poll the exact public Markdown used by the website header Updates button every minute in production and mirror new releases to dev-updates (`1373110039669379082`). Baseline existing releases without replaying history.
- Keep full release content across Discord-sized embeds, resolve site-relative links, link the published source, and disable mentions on sends and edits. Update existing bot messages when a mirrored release changes.
- Persist release identities, message IDs and pending send intents in the existing SQLite KV. Recover uncertain sends from bot-authored channel history before retrying with the original enforced nonce; fail closed on unreadable recovery history or corrupt checkpoints.
- Add isolated parsing, baseline, retry, restart/durable-KV, edited-entry, message-limit, permission and lifecycle coverage. No credentials, scopes, schema changes, ports or synthetic public test posts.

## 2026-10-15 - Official Android save exports

- Resolve TheTowerSDK 0.11.3 for the existing byte-decoding path, alongside legacy binary, gzip and encrypted saves.
- Accept Android tool_export.json snapshots in the save upload flow and explain refreshing exports. Preserve omitted lab queues, favorites, partial level maps and module slots; retain explicit zero values.
- Cover sanitized exports, malformed input, legacy formats and persistence without live saves or Discord messages.

## 2026-10-14 - Narrow duplicate-review reads and remove timer waits

- Fetch only validated main run records for review duplicate detection; skip review cloud history entirely when duplicate detection is disabled or an explicit run reference already makes the check unnecessary. Keep complete paging/count/ownership checks, separate full/main in-flight reads, and prohibit local hydration from main-only snapshots.
- Replace repeated zero-delay hydration timers with the existing setImmediate I/O-yield helper. On this Windows host, 54 timer yields cost about 798 ms versus under 1 ms for the helper; batched writes still yield to gateway I/O.
- Add a local parse/review/submit/share integration fixture with simulated network and in-memory saves. Verify accurate counts, repeated-submit protection, fresh remote edits and deleted-selection refusal without production submissions or messages.

## 2026-10-14 - Consistent coverage comparisons and review reads

- Exclude the selected run from every comparison metric, fixing self-comparisons that displayed +0.00%. Use the same rolling-window fallback for BH/orbs as other metrics, retaining only compatible effect-active counts. Omit an unavailable relative-change annotation consistently, including zero baselines; explicit current zero coverage remains 0%.
- Build upload reviews from the verified read-only history view instead of rewriting every historical local record. Submission still revalidates fresh history inside its existing mutation lock; no completed cloud snapshot is reused across interactions.

## 2026-10-14 - Reduce verified history latency

- Increase complete-history main pages to 500 and fetch extended pages in bounded waves of four. Preserve complete pagination, final-count, schema, ownership, profile, deadline and retry checks; drain a failed wave before releasing the read. Read-only playground measurement on 1,360 runs fell from 24.4s to 9.6s, with identical run count.
- Log bounded, content-free operation stage durations and lock wait time so cloud reads, hydration, saves and presentation can be distinguished on natural traffic.

## 2026-10-08 - Gateway readiness monitoring

- Publish atomic, process-bound gateway readiness every 30 seconds and on lifecycle events. Require all shards ready with recent heartbeat acknowledgements; fresh sessions, resumptions, disconnects and invalidation remain distinguishable without exposing credentials or user data.

# Changelog

## 2026-10-06

### Fixed
- Retry changing valid main-history totals once from a completely fresh, fully validated read within the original shared 45-second budget. Keep schema, ownership, pagination, profile and final-count guards; never combine partial attempts or retry a write.
- Retain unchanged reviewed input after known transient pre-dispatch history failures for explicit, versioned owner Retry. Preserve the five-minute inactivity deadline, recheck owner/session/version/profile/flow/cancellation immediately before dispatch, and consume ambiguous write failures instead of offering resubmission.
- Record each new draft's original flow; preserve unknown-flow drafts until normal expiry and ask for a fresh paste or upload instead of guessing. Stop review mutation after failed acknowledgement, and require owner/session matching for cancellation. No historical replay or analytics retry change.
- Preserve registered, allowlisted history cause, stage and correlation through privacy-safe submission failure wrappers and local operation diagnostics. Classify pre-save history verification failures as history unavailable; retain post-save presentation failures and generic internal failures separately. Do not change history guards, retry behavior, run writes or draft consumption.

## 2026-10-05

### Fixed
- Stop Share Last before history reads, snapshots and public delivery when Discord acknowledgement fails. Preserve successful acknowledgement fallback and reuse an existing acknowledgement; report the original failure at the acknowledgement stage without retrying responses on an unusable token.
- Route Add Run modal pastes through the shared private paste diagnostic, validation, history and review pipeline. Carry modal source and diagnostic reference into pending review; retain bounded redacted local captures and expose no report content through alerts.
- Emit allowlisted paste operation, parse/history/review stage and failure code in sanitized diagnostics. Preserve error visibility for unrecognized reports and unexpected parser defects; give consistent full-report guidance for validation rejection and separate guidance for internal processing/history failures.

## 2026-10-03

### Fixed
- Preserve allowlisted history-verification cause, request stage, bounded HTTP/transport code and opaque correlation in local logs and paste diagnostics. Distinguish timeout, malformed records, pagination/count consistency, ownership and unknown failures without exception messages, stacks, response bodies or raw reports; retain sanitized external errors and existing history behavior. The recovered 20:00 incident's historical cause remains unknown.
- Release per-user mutation locks after durable saves, session consumption and coherent history capture; perform chart rendering, Discord replies and automatic log-channel sharing on a separate ordered delivery lane. Slow delivery no longer prevents a second run from saving. Apply the same separation to lifetime submission delivery and observe background-sync rejection immediately.
- Carry the captured run history into submission and automatic-share charts; preserve duplicate checks, selected-run state and repeated-submit protection while delivery is pending.
- Diagnose long-held operation locks and failed waits with salted scope hashes, operation names, safe stages and elapsed times. Keep existing wait deadlines and retain protection around unfinished writes and hydration.
- Recheck consumed review sessions after delayed Discord acknowledgements so repeated Submit cannot replace an already saved response with a loading message.

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

