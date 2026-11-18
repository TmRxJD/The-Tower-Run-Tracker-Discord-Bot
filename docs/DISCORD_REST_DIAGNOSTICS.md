# Discord REST latency diagnostics

`[diag] discord.rest.request` complements the existing share/run timing and rate-limit events. It reports REST.request calls taking at least 1.5 seconds, failures, multiple HTTP attempts or emitted rate-limit waits. Calls through the standard Discord.js REST methods are covered; direct low-level queueRequest calls are not.

Correlate `operationId` and `diagnosticStage` with `[perf] share.operation` / `[diag] operation.finish`. `requestRef` is a random diagnostic reference, not a Discord ID. Background REST calls may have no operation ID.

- `initialWaitMs`: time before the first HTTP attempt, including preparation and bucket/global queue waits. This is not a pure queue measurement.
- `attemptMs`: sum of HTTP-attempt durations until response headers (or a thrown network error).
- `unaccountedMs`: remaining time, including retry backoff and response-body handling/parsing. It does not identify those causes individually.
- `attemptCount`, `attempts`: up to eight status/error/duration samples. Multiple attempts demonstrate retries; a 429 status demonstrates a rate limit even if no rate-limit event was emitted. Errors use a fixed network-error allowlist; other errors are labeled `other`.
- `rateLimitEventCount`, `globalRateLimitEventCount`, `retryAfterMs`, `sublimitTimeoutMs`: observed wait events and maximum advertised waits. Zero events do not rule out a 429 or sublimit.
- `routeFamily`: a fixed category (channel-message, interaction-callback, webhook, other), never a route, channel ID, token or URL.

New request reports are capped at 30 per minute per REST client. The next emitted report includes `suppressedReports`. Attempt samples are capped at eight, with an overflow flag. Normal fast requests do not emit a report. Instrumentation preserves existing timeout/retry settings and response/error identity; it does not send additional requests. Existing rate-limit logging remains unchanged.

No raw REST debug output, headers, payloads, user IDs, route parameters or error messages are logged. Do not enable raw restDebug logging to investigate a delay.

## November 18 investigation

The 13:56:52.780Z share completed in 24,334ms, including 23,057ms in send; process CPU was 266ms and event-loop utilization 0.012. Of 18 share-operation records that day, the next slowest send was 3,537ms. No existing REST rate-limit events appeared that day. This localizes the large delay to the awaited Discord send, but does not establish whether it was queueing, a transport retry, server latency or response processing. A gateway reconnect at 14:52 was not simultaneous.

Nearby work had separate cloud waits: upload-history 2,047ms, submission cloud-history 2,785ms, presentation reply 775ms. These do not explain the 23-second send.

Offline verification: synthetic HTTP responses only, no Discord posts. Focused tests cover concurrency, error/response identity, bounds, redaction and the installed REST class including successful response-body latency.
