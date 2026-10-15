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
