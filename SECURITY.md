# Security

This server reads a Google OAuth credential from disk (`~/.config/gws/youtube_credentials.json` by default, or wherever `YT_ANALYTICS_CREDENTIALS_PATH` points) and uses it to call the YouTube Analytics API. The credential holds a long-lived refresh token — treat it like a password. It is read from the file system, never logged, and never written to stdout. Access tokens are kept in memory only.

Things worth knowing:

- **Every tool is a read, and that is enforced, not just annotated.** All nine tools declare `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. Underneath, `src/client.ts` has no write path — every request is a GET. The end-to-end test in `src/__tests__/annotations.e2e.test.ts` asserts the exact annotation object on each tool from a real `tools/list`, and carries a control that injects a fake write tool to prove the assertion can go red.
- **The server can only read the channel the credential owns.** `ids=channel==MINE` is written unconditionally in `buildReportUrl`, and `ReportQuery` has no `ids` field, so pointing this server at another channel is not something a tool argument can express. The "cannot be overridden" test in `src/__tests__/client.test.ts` passes a hostile `ids` past the type and asserts the built URL still says `channel==MINE`.
- **Nothing is stored.** No cache, no database, no history file. Responses go to the caller and are gone. A stolen machine yields the credential, not an archive of your analytics.
- **stdout is the MCP transport.** All diagnostics — including the startup warnings about missing credentials or missing scopes — go to stderr. MCP clients persist stderr to log files, so those messages name the credential *path* and the scope required; they never contain the credential's contents or an access token.
- **Least privilege is available.** `yt-analytics.readonly` alone runs every Analytics tool. The optional `youtube.readonly` scope only buys video titles, channel metadata, and publish dates. Mint without it if you do not want the server to see channel metadata; the Analytics tools degrade to bare video IDs rather than failing.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
