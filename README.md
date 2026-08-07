<div align="center">

# yt-analytics-mcp

Owner-side YouTube analytics for AI agents: watch time, traffic sources, audience retention, playlist and podcast-series metrics, and episode-over-episode comparison. Read-only, all of it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-20.19+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)

</div>

---

An MCP server for the [YouTube Analytics API v2](https://developers.google.com/youtube/analytics). It gives an AI assistant the numbers only a channel owner can see — the ones behind the public view count. How long people actually watched, where they came from, where in a video they left, which playlist they were working through, and how a new episode is tracking against the last five *at the same age*.

**Why this exists.** Google ships official MCP servers for Workspace, Google Analytics, and BigQuery. It does not ship one for YouTube Analytics, and the community servers that claim to cover it are mostly wrapping the public Data API — which can tell you a video's view count and nothing about watch time, retention, or traffic sources, because that data is owner-only and needs OAuth. This server does the owner-side half properly and stops there.

It was built to run analytics for a podcast, which is why the playlist tooling is unusually complete. Nothing here is specific to that show; point it at any channel you own.

## Tools

Nine tools. Every one is a read.

| Tool | What it returns | API |
|------|-----------------|-----|
| `yt_channel_info` | Which channel the credential owns, with subscriber/view/video counts | `GET youtube/v3/channels?mine=true` |
| `yt_channel_overview` | Views, watch time, avg duration/percentage, subs gained/lost, likes, comments, shares — as a total or a day/month series | `reports.query` |
| `yt_traffic_sources` | Views and watch time by how viewers arrived (search, suggested, external, Shorts feed, subscriptions, playlists…) | `reports.query` `insightTrafficSourceType` |
| `yt_top_videos` | Videos ranked by any core metric, with titles | `reports.query` `video` |
| `yt_video_performance` | Metrics for videos you name, and which of them had no activity | `reports.query` `video` + filter |
| `yt_audience_retention` | The drop-off curve for one video, ~100 points sampled down | `reports.query` `elapsedVideoTimeRatio` |
| `yt_geography` | Views and watch time by country, with each country's share | `reports.query` `country` |
| `yt_playlist_performance` | Playlist starts, views per start, time in playlist, saves — the podcast-series view | `reports.query` `playlist` |
| `yt_episode_race` | **Derived.** Several videos re-indexed to days-since-their-own-publish, plus a leaderboard at the oldest age they all share | `reports.query` + publish dates |

### Side effects: there are none

Every tool is `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. All four hints are stated explicitly on all nine tools rather than left to defaults, because MCP's `destructiveHint` **defaults to true** — an omitted hint tells a client to raise a delete-grade consent prompt for reading a view count.

That is not just a labelling convention. The HTTP client in `src/client.ts` has no write path: every method is a GET, and `ids=channel==MINE` is hardcoded rather than accepted from any tool input, so no argument an agent can pass will point this server at another channel or change anything on yours. The e2e test asserts the exact annotation object on each tool from a real `tools/list`, and includes a control proving that assertion can go red.

### The derived view

`yt_episode_race` is the one tool that computes rather than reports, and it exists because raw totals cannot answer the only question that matters week to week: *is this episode doing better than the last one?* An episode published a month ago has simply had more days to accumulate views. Re-indexing each video to days since its own publish date removes that, so day 7 sits next to day 7.

Two details it gets right that a naive version would not: each curve is **truncated at the video's real age** rather than padded with its last value (padding makes a 3-day-old episode look like it flatlined for 25 days), and the leaderboard is pinned to the **oldest day every video has reached**, never to lifetime totals. Every response labels exactly which fields the server computed (`computedFields`) and returns the API's own per-day values alongside them.

## Authentication

An OAuth **installed-app** credential — a saved refresh token — not a service account and not an API key. There is no API-key path to this data: watch time, retention, and traffic sources are owner-only, and Google will not serve them to anything but an OAuth token for an account that owns the channel.

Default location, shared on purpose with the sibling servers and any Google scripts you already run:

```
~/.config/gws/youtube_credentials.json
```

Set `YT_ANALYTICS_CREDENTIALS_PATH` to use a different file.

### Scopes

| Scope | Needed for |
|---|---|
| `https://www.googleapis.com/auth/yt-analytics.readonly` | **Required.** Every Analytics report. |
| `https://www.googleapis.com/auth/youtube.readonly` | Optional. Video titles, channel metadata, and publish dates — so `yt_channel_info` and `yt_episode_race` need it, and title resolution elsewhere degrades gracefully without it. |

`yt-analytics-monetary.readonly` is accepted in place of the first; `youtube` and `youtube.force-ssl` are accepted in place of the second. Without the optional scope the server still starts and every Analytics tool still works — you get bare video IDs and a note explaining why, not a failure.

### Minting the credential

1. In Google Cloud Console, create an **OAuth client** of type *Desktop app* and download its `client_secret.json`.
2. Enable both the **YouTube Analytics API** and the **YouTube Data API v3** on that project.
3. **Set the OAuth consent screen's publishing status to "In production" — click *Publish app*.** See the warning below; this is the step everyone skips.
4. Run any standard `google-auth-oauthlib` installed-app flow requesting the scopes above and save the result to the path above. About ten lines of Python, one browser consent click.

> ### ⚠️ Publish the app, or your token dies in 7 days
>
> Google's OAuth documentation: *"A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile."*
>
> These scopes are not that subset. Leave the project in **Testing** and this server will work for a week and then start failing with an auth error that looks like a bug in the server. Switch the consent screen to **In production** and refresh tokens stop expiring.
>
> You do **not** need Google to verify your app for this. `yt-analytics.readonly` and `youtube.readonly` are *sensitive*, not *restricted*, and an app using its own OAuth client for its own owner's data does not go through verification review — an unverified-app warning at the consent screen is expected, and you click through it. Do not use a shared or hosted OAuth client to dodge this: those hit a 100-new-user cap that cannot be reset.

### Starting without a credential

The server boots and answers `tools/list` with no credential at all, so MCP inspectors can introspect it. Tool *calls* then return a setup pointer. Diagnostics go to stderr; stdout is the MCP transport and stays clean JSON-RPC.

## Setup

Add to your MCP client config — `.mcp.json` for Claude Code, `claude_desktop_config.json` for Claude Desktop:

```json
{
  "mcpServers": {
    "yt-analytics": {
      "command": "node",
      "args": ["/path/to/yt-analytics-mcp/dist/index.js"]
    }
  }
}
```

No `env` block is needed when the credential is at the default path.

Then ask your assistant: *"Which YouTube channel am I connected to?"*, then *"Show me traffic sources for the last 30 days,"* then *"Race my last three episodes against each other."*

## Limitations

Read these. Several of them are things competing servers claim to do and cannot.

- **No impressions, no impressions CTR, no unique viewers.** These exist in YouTube Studio and **do not exist in the Analytics API**. Each returns `Unknown identifier (...) given in field parameters.metrics` — verified live, not inferred from docs. Any MCP server advertising click-through rate from this API is advertising something it cannot deliver. If you need CTR, the Studio UI is the only source.
- **Data lags 2–3 days.** End your ranges a few days before today or the last days come back as zeros. `yt_episode_race` defaults its as-of date to yesterday for this reason; pass `as_of_date` explicitly if you want a reproducible answer.
- **Owner-side only.** This reads `channel==MINE` and nothing else. You cannot point it at a competitor's channel — not a limitation of this server, a limitation of the API, and the correct one.
- **Retention needs volume.** YouTube withholds the retention report for videos below a watch-time threshold. `yt_audience_retention` says so rather than returning a bare empty array.
- **One video per retention call, enforced here.** The API accepts a comma-separated list on the retention report and then **silently returns only the first video's curve with HTTP 200** — verified live with two real owned video IDs. Google's docs say single-ID-only; the API does not enforce it. This server rejects lists so you never get one episode's numbers labelled as several.
- **Report-specific caps you will hit.** Video-ranked reports cap at 200 rows and *require* a sort order (no sort is an HTTP 400). Month grouping requires the range to sit on whole-month boundaries. The server sends the sort automatically and checks month alignment before the request, so you should not meet these — but they are why some parameter combinations are not offered.
- **`reports.query` only; no Reporting API.** The bulk [YouTube Reporting API](https://developers.google.com/youtube/reporting) is a different shape: *"You can start retrieving the report within 48 hours of the time that the job is created,"* and *"API reports are available for 60 days from the time that they are generated."* A two-day cold start and a rolling 60-day window is a batch-warehouse contract, wrong for an interactive agent. Deliberately out of scope; use the BigQuery path below if you want bulk history.
- **No caching, no stored history.** Every call goes to Google. That is a deliberate simplification, not an oversight — see below.

## API terms and data handling

Worth stating plainly, since an agent reading your analytics is exactly the case these rules were written for.

**Storage.** This server stores nothing. No cache, no database, no history file; responses go to the caller and are gone. YouTube's Developer Policies (§III.E.4.b) do permit storing Analytics API data long-term, so a future caching layer would not be prohibited — but the 30-day cap in §III.E.4.c/d applies to other data classes, and holding nothing keeps the question from arising.

**Derived metrics.** §III.E.4.h prohibits replacing API Data with independently calculated substitutes or using it to create new metrics. This server computes only plain arithmetic over YouTube's own numbers — running sums, a part-of-total share, a day difference — never a score, index, or composite rating. Every response that contains a computed value lists those fields under `computedFields` and returns the API's own values beside them, so nothing this server calculated can be mistaken for something YouTube reported. If you extend it, keep that line.

## Other options

Nothing else fills this slot well, which is why this exists — but be precise about what the alternatives are.

| You want | Use |
|---|---|
| Owner-side YouTube Analytics via MCP | this repo — no official Google server exists for it |
| YouTube *public* data (search, metadata, comments, uploads) | a Data-API server such as [ZubeidHendricks/youtube-mcp-server](https://github.com/ZubeidHendricks/youtube-mcp-server) — popular, but Data-API-centric; an API key can never reach owner-only metrics |
| YouTube analytics in a warehouse, with SQL | [BigQuery Data Transfer's YouTube Channel connector](https://docs.cloud.google.com/bigquery/docs/youtube-channel-transfer) plus Google's own [BigQuery MCP](https://github.com/googleapis/mcp-toolbox) — a genuinely good path if you already run BigQuery, at the cost of warehouse setup and transfer latency |

### The analytics siblings

| Data | Server |
|---|---|
| YouTube Analytics | this repo |
| Google Workspace | [gws-mcp-server](https://github.com/conorbronsdon/gws-mcp-server) |
| Search Console | [gsc-mcp](https://github.com/conorbronsdon/gsc-mcp) — same curated approach, including derived views like `gsc_striking_distance` |
| Google Analytics 4 | [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) — Google's own, read-only |
| BigQuery | [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox) — Google's own |

These are separate credential families, not one login. Workspace authenticates with `gws auth login`, Search Console with a `webmasters` OAuth credential, GA4 with Application Default Credentials scoped `analytics.readonly`, and this one with a `yt-analytics.readonly` OAuth credential. Nothing here shares a token with anything else.

## Development

```bash
npm install
npm run build
npm test
```

Tests mock the HTTP layer and make no network calls. Assertions pin exact values — the request parameters built for each tool, the exact annotation object on each tool from a real `tools/list` — rather than shapes, and carve-outs carry a must-fail leg beside the must-pass one.

A separate live smoke test drives every tool against the real API with your real credential. It is not part of `npm test`:

```bash
node scripts/smoke.mjs
```

## Contributing

Issues and pull requests welcome. If a YouTube Analytics report is worth wrapping, open an issue describing what it should return and the dimension/metric combination it maps to — and please verify that combination against the live API first, because the docs and the API disagree in places (the retention filter being the sharpest example). Keep the contract honest: every tool stays read-only, annotations stay explicit, computed fields stay labelled, and responses stay compact.

## About

Built and maintained by [Conor Bronsdon](https://github.com/conorbronsdon). I host the [Chain of Thought](https://chainofthought.show) podcast, which covers AI infrastructure, developer tools, and how practitioners actually use this stuff. I built this to pull YouTube's owner-side numbers into the agent workflows that run the show.

---

## Disclaimer

*This is an independent personal project, not affiliated with, sponsored by, or endorsed by Google LLC or YouTube. All views expressed are my own.*

## License

MIT
