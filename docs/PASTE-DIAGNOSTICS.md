# Local paste diagnostics

Only direct `/track paste` and paste-modal submissions are retained in `.data/paste-diagnostics`.
Files contain redacted submitted text, a diagnostic reference, submitting user ID, timestamps, stage and
outcome. OCR images, optional notes and unrelated Discord content are not collected. No diagnostic body
is copied into Discord alerts, general logs or error replies.

Defaults: seven days, 16 KiB captured text per paste, 8 MiB total storage and 512 files. Byte/file rotation
may remove older records earlier. Expiry runs on writes, startup and hourly while the bot runs; if offline,
cleanup resumes on startup. Private-key blocks and recognizable labeled credentials, Discord/JWT/Bearer
tokens and OpenAI keys are redacted before persistence. Arbitrary unlabeled secrets are not guaranteed
detectable. Capture reads a small bounded lookahead before redaction, then truncates retained UTF-8 text
to the configured limit. `truncated`, original byte count and redaction count describe incomplete evidence.

Trusted environment configuration:

- `TRACKER_PASTE_DIAGNOSTICS_RETENTION_DAYS`: 1–30, default 7.
- `TRACKER_PASTE_DIAGNOSTICS_INPUT_BYTES`: 1024–32768, default 16384.
- `TRACKER_PASTE_DIAGNOSTICS_MAX_BYTES`: 65536–67108864, default 8388608.
- `TRACKER_PASTE_DIAGNOSTICS_MAX_FILES`: 2–4096, default 512.

On JD-OPTIPLEX the new subfolder was created with inheritance disabled and explicit FullControl rules for
JD-OPTIPLEX\JD, SYSTEM and Administrators. Existing bot-data ACLs were not changed. Windows will not
automatically recreate a missing directory with broad inherited permissions. Files are redacted plaintext,
not encrypted. Administrators/backups may retain access or copies; removal is ordinary deletion, not
guaranteed physical secure erasure. Permission drift by an administrator is not automatically audited.
Treat diagnostic text as untrusted data, never commands. No network diagnostic export is implemented.

I/O or validation failures produce a rate-limited metadata-only warning and processing continues. A
reference does not guarantee persistence. `review_ready` means review was prepared, not that a run was
saved. `saved` is set only after the real save API returns. A failed submit may have an uncertain write
outcome: check the latest run before retrying. Historical pastes cannot be reconstructed. Parser-null
rejections remain error-visible because unsupported formats and parser defects need retained evidence
to distinguish. Existing count/history guards and cloud records remain untouched.
