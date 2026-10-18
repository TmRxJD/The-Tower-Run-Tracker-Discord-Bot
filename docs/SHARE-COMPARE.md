# Private run comparison

Snapshot-backed single-run shares include **Compare**. Clicking it opens a private run picker. The shared side is the immutable saved share version, with its owner/reference and version hash verified. Missing or changed snapshots require a fresh share. The original public message is never edited by a comparison.

## Expanded details and battle reports

- If the source share has its matching public Expand control, comparison uses the same enabled share settings as Expand. This includes primary and hourly metrics, notes and individual coverage metrics when enabled. Sources without Expand retain only their displayed fields. Screenshots and sharer history/charts are not fetched.
- **Compare battle reports** is a separate control and requires the source share's matching public Battle Report control. It compares only known captured battle-report fields using the existing report sections, labels and game ordering. Unrelated save properties are never enumerated. Older captures explicitly mark missing report data as Unavailable.
- Both values for each metric share one Markdown row: `S **1T** | Y **2T** · Δ (+100.00%)`. S is the shared run and Y is the selected private run. There are no inline embed fields that collapse into stacked columns on mobile. Metric labels and section headings remain readable above each paired value row.
- Expanded values reuse `buildShareEmbed`, platform delta baselines and canonical coverage calculations. Reports reuse `resolveBattleReportSource` and `buildBattleReportSections`. Scalar differences use platform numeric parsing and delta formatting on the displayed values, avoiding contradictions from stale saved hourly rates; missing/invalid or zero baselines have no percentage. Genuine current zero values remain zero, including a -100% change from a positive baseline. Missing hourly amounts remain Unavailable rather than becoming artificial zeroes.
- Details and reports paginate at nine rows and at most 2,800 body characters per page, retaining long text through continued paired rows. Next/Previous use the selected model already in memory, with no history lookup, run read or report rebuild. Back to details and Choose another run preserve a clear private workflow. Values are relative comparisons, not a ranking of which run is better; tiers and run types affect interpretation.

The public label is exactly **Compare** on new, reshared or normally refreshed messages. Existing message labels are not bulk rewritten; their original Compare controls use the richer handlers immediately.

## Privacy and lifecycle

- Each session has a random token, authenticated owner, bound ephemeral message ID, revision and fixed five-minute deadline. Controls verify owner, message and ephemeral status before acknowledgement. Sessions are isolated between users, bounded to 256 entries and intentionally expire on restart.
- The picker shows 25 runs per page. Scoped local choices avoid cloud history reads. If needed, cloud choices query at most 100 main records per verified current/legacy owner and are labelled recent saved runs. Pagination never reloads history.
- Selection uses a server-held choice index. Local-only runs are re-read within the owner's scope; cloud-backed choices fetch only their selected stitched pair and revalidate run identity, account ownership, profile and deletion state. Report entry revalidates that same selected run before rendering. Disabled cloud sync remains local.
- Foreign, malformed, out-of-page, expired and stale controls cannot edit someone else's reply. Busy/revision guards coalesce repeated selections and report clicks. Cancellation invalidates an in-flight read before acknowledging, blocking late results. Failed acknowledgement starts no selected-run read.
- All comparison payloads disable mentions. Read/render failures remain private and omit raw errors. Comparison does not save runs, change settings/profiles, enqueue a share, fetch unrelated private runs or send channel messages.

View Runs' explicit single-run Share action captures the same durable snapshot contract as other run-share paths. Lifetime entries and average summaries without a single-run snapshot do not gain comparison controls.

## Observation

`[share-compare] interaction` records only PID, allowlisted action/outcome/stage, duration and an optional numeric Discord error code. Detail/report delivery is recorded only after the private edit resolves. Rejections, acknowledgement failures, unavailable data and cancellation/expiry remain distinct. No run/user/message/session identifiers, names, contents, URLs or raw errors are recorded. Existing logger throttling means samples are observed events rather than complete usage counts.

## Isolated verification and deployment

Tests cover access boundaries, immutable source validation, owner/message/profile isolation, selected-only reads, fresh report validation, repeated controls, cancellation during pending reads, paging/back navigation, missing and zero metrics, percentage units, full report ordering, long text and Discord payload limits. Discord/cloud calls use fixtures; no synthetic production posts or real private run replay are used.

The report playground compared rebuilding canonical sections on 100 page changes with caching one selected report model: 27.226 ms versus 0.277 ms for a 143-field fixture. The completed paired-row fixture compared 100 full report rebuilds plus payload construction against cached page payloads: 267.03 ms versus 8.41 ms (about 0.084 ms per cached navigation), with approximately 170 KB versus 7 KB retained heap after GC. This fixture spans three detail and sixteen report pages. Cached navigation adds no database transactions. Local fixture previews at 360 and 720 pixels supplement assertions that every value line contains both S and Y and that embeds have no inline fields. These previews represent layout, not an actual Discord client screenshot; production latency is not inferred from the local benchmark.

The original private Compare rollout and content-free telemetry were deployed on 2026-10-15. Telemetry verification passed 95 files / 608 tests, full typecheck, build and changed-file lint. Tracker PID 25108 was Discord-ready after that rollout. The changelog mirror retained its 10 historical baseline identities with no replay, sends or pending intents. These are earlier observations; see the final refinement deployment evidence below for the current process.

No staging, commits or pushes are authorized for the Compare work. Existing unrelated `.npmrc`, `config.json` and `package-lock.json` must remain byte-identical. Deployment uses the existing activation/verifier scripts, and checks a fresh process-bound gateway heartbeat and website mirror checkpoint. Live delivery observations must remain separate from mocked tests.

### Expanded/report refinement validation: 2026-10-15

The final isolated suite passed 97 files / 621 tests in 82.37 seconds. Full TypeScript checking, the isolated production build and changed-file lint passed. The first rendered fixture exposed a contradiction between displayed hourly rates and stale stored delta fields; scalar differences now follow displayed values, with a regression test for that case. Both 360-pixel and 720-pixel fixture layouts were reviewed. Public delivery and actual Discord client rendering were not exercised with synthetic posts.

### Refinement deployment evidence

Guarded copying updated 18 feature/test/documentation files, retaining backups of existing files. The existing activation script rebuilt production in place and restarted only TrackerBot at `2026-10-15T23:04:59.646Z`: PID `11348`, restart count `28`. Its verifier confirmed ClientReady and no additional restart over 30 seconds (54 seconds online at completion). The stronger gateway receipt subsequently reported ready for that same PID at `23:06:03.039Z`; initial pre-heartbeat receipts were false and were not treated as verified readiness.

Read-only compiled integration inspection confirmed the exact Compare label and eight registered controls, including report and detail navigation. No handlers were invoked. At `23:06:22.138Z`, all deployed file hashes matched, unrelated `.npmrc`, `config.json` and `package-lock.json` hashes were unchanged, nothing was staged, and no startup errors or natural Compare outcomes had been observed. Tests and compiled inspection therefore do not establish a real user's report delivery.

The restarted process successfully polled the published website changelog at `23:06:07.353Z`. Its live source hash matched the poll; the latest release remained Minor Update v2.3.1 (2026-09-15). Baseline timestamp `1792088274318` and all ten historical release identities survived, with zero sends, edits, recoveries, messages and pending intents. The refinement does not replay historical announcements. No commit or push was performed for this rollout.
