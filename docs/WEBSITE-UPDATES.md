# Website Updates mirror

The deployed site header's Updates button fetches `/changelog.md` with cache disabled. On 2026-10-15 the public App bundle confirmed that behavior. This is the publication boundary: repository commits, bot CHANGELOG.md and draft content are not announcement sources.

Production TrackerBot polls `https://the-tower-run-tracker.com/changelog.md` after Discord ClientReady, then every 60 seconds after each completed pass. Development bots never start the mirror. There is no inbound endpoint, webhook, additional credential, OAuth scope, intent or Appwrite schema.

## Content and identity

Top-level Markdown headings delimit releases. The first nonblank line after each heading must contain a supported bold English date, optionally preceded by a list marker. H2/H3 sections and fenced example headings remain part of the body. Explicit draft, planned and unreleased headings are skipped. An invalid published section, HTML error page, incomplete fence, oversized source or source HTTP/transport failure aborts the pass without advancing announcement state.

Identity uses the version plus date, or title plus date for unversioned announcements. The first copy wins for duplicate legacy releases in the deployed file. Content hashes detect body and title changes. Changing a release's version/date, or the title of an unversioned announcement, changes identity; the Markdown source has no immutable entry IDs.

The first valid complete read durably baselines all existing identities and sends nothing. Historical baseline entries remain silent even if edited. New identities publish oldest-first in source order. Removing an entry does not delete its delivered messages or dedupe record; reintroducing it does not replay it.

Full body text is split into embeds with descriptions at most 3,800 UTF-16 code units. Each embed carries the release title, date, part number and direct public source link. Relative Markdown links become absolute site links. All allowed mentions are disabled on both sends and edits. Corrections edit the stored message IDs and remove only surplus bot-authored continuation parts when the body shrinks. A deleted mirrored message causes edits to fail closed; it is not automatically announced again.

## Persistence and retries

The existing `.data/indexeddb/tracker-bot-idb.sqlite` KV stores `website-updates-mirror:v1`. It includes the baseline time, source/channel binding, release fingerprints, message IDs and any pending intent/payload/nonce. Writes require persistent storage. Never delete this key as a repair: deleting it loses message mapping and silently rebaselines the current source.

Before each Discord send the intent is committed. A confirmed response commits the message ID. A restart, uncertain response or failed ID checkpoint leaves the intent available for recovery. Recovery reads target-channel history back to one minute before the intent, matching only this bot's exact embed payload or nonce. A complete negative search retries with the same enforced nonce; Discord's short nonce retention alone is not relied on for long outages. Failed, nonadvancing or over-10,000-message history searches refuse a resend. Permission/source/storage failures retain state for the next poll. Known IDs are edited idempotently. Polls are serialized and state is reloaded from SQLite each time.

The target `1373110039669379082` was verified as `#dev-updates` in guild `1343406545920196608`, with Run Tracker (`1345944489340043286`) already able to view, send, embed and read history. No permissions were changed. Recovery uses only bot-authored embeds, readable without Message Content intent.

## Operations and validation

`website-updates-status:v1` records the process ID, check time, source/channel, result counts, latest source hash/title, and either success or an allowlisted failure stage/code. This is process-bound poll/checkpoint evidence, not proof that a real future release has been delivered. Compare its PID to PM2 and the fresh `.data/gateway-readiness.json` receipt.

Run tests from an isolated checkout with linked dependencies, never from the production working directory: unrelated tests resolve their databases relative to cwd. The new suites are under `src/features/website-updates/`. They use public/synthetic fixtures, temporary SQLite and mocked Discord; no synthetic public posts are needed.

The initial read-only playground compared 1,000 release-boundary scans: regex 52.2 ms versus split-line scanning 57.8 ms for the live 47,184-byte document, with roughly 4.6-5.0 MB heap. The selected parser uses regex line boundaries with fence tracking. An isolated FULL-synchronous SQLite checkpoint took 12.5 ms. No site rendering or user request paths change.

## Verified deployment: 2026-10-15

- Implementation commit: `c41da2e`. Activated using `node scripts/deploy.mjs activate` on JD-OPTIPLEX. No push.
- Full isolated regression run with process isolation: 90 files / 573 tests passed in 74.24 seconds. The initial thread-pool runs stalled; the first also lacked the compiled `dist` needed by an existing restart test. Compiling the isolated snapshot and using `--pool=forks --maxWorkers=2` completed successfully. Final focused run: five files / 34 tests passed, including separate Node processes with real temporary SQLite and the actual-feed chunk-boundary regression. Final type-check, production build and changed TypeScript lint passed.
- Existing PM2 service restarted once to PID `15192`, restart count `25`. The repository verifier confirmed ClientReady and no further restart over its 30-second window (52 seconds online at completion).
- At `2026-10-15T18:18:51.676Z`, the process-bound gateway heartbeat reported ready for PID `15192`. The successful mirror poll at `18:18:55.509Z` was also bound to PID `15192`. Both readiness predicates in `scripts/probe-website-updates.mjs --source` passed.
- The first poll baselined 10 distinct published releases at `18:17:54.318Z`, with zero sends. The next poll retained the same baseline with zero sends/edits/recoveries/removals. SQLite contained 10 baseline entries, zero mirrored messages and zero pending intents.
- A fresh public-source read matched the poll hash `86bbad15be9986d20411f1da5432b6d07b1e3cd2dd96dfccf5c6a4f0d38f1505`; latest release was Minor Update v2.3.1, dated September 15, 2026. Read-only channel history still ended at the existing September 15 post, with no new bot message.
- Live future-release delivery remains unobserved. Send/edit/retry assertions are mocked tests; the deployed bot's readiness, permissions, source reads, baseline and later poll are real observations. No synthetic public post or private run share was sent.
- User changes to `.npmrc` and untracked `config.json` / `package-lock.json` remained byte-for-byte unchanged.

The reusable read-only probe is `node scripts/probe-website-updates.mjs --source`, run from the production repository. It exits nonzero for stale/mismatched process readiness or missing/currently failed poll state, and never initializes storage or sends messages.
