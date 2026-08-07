import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DATA_SCOPE } from "./auth.js";
import type { YouTubeClient } from "./client.js";
import { CredentialMissingError, ScopeError } from "./errors.js";
import {
  addDays,
  alignToAge,
  daysBetween,
  isoDate,
  round,
  stripNulls,
  toObjects,
  type DailyPoint,
} from "./shape.js";

export const SERVER_NAME = "yt-analytics-mcp";
export const SERVER_VERSION = "0.1.0";

const json = (data: unknown) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(stripNulls(data), null, 2) },
  ],
});

const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/**
 * Build a complete MCP tool annotation set.
 *
 * Every tool in this server is a read. There is no write path in the client at
 * all, so the annotations are uniform — which is exactly why they are stated
 * explicitly rather than left to defaults. `destructiveHint` defaults to *true*
 * in the MCP schema; a client that sees it unset renders a delete-grade consent
 * prompt for a tool that only reads a view count. `openWorldHint` is true
 * because YouTube's numbers change without this server doing anything.
 *
 * The one hint worth arguing about is `idempotentHint`. The spec ignores it on
 * reads, so setting it true is documentation rather than behaviour; it is set
 * anyway so no hint on any tool reads as "nobody considered it".
 */
export function buildAnnotations(
  title: string,
  overrides: Partial<ToolAnnotations> = {},
): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    ...overrides,
  };
}

/**
 * Characters a video ID may contain.
 *
 * Narrower than "any string" on purpose. Video IDs land in the `filters`
 * parameter, whose grammar separates clauses with `;` and values with `,` — so
 * an unfiltered ID could append a filter clause the caller never asked for and
 * silently change what the report covers. Restricting to the documented ID
 * alphabet closes that off at the tool boundary. Length is bounded loosely
 * rather than pinned to 11 so a future ID format does not break the server.
 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

export function assertVideoId(id: string): string {
  const trimmed = id.trim();
  if (!VIDEO_ID_RE.test(trimmed)) {
    throw new Error(
      `"${id}" is not a valid YouTube video ID. Expected the 11-character ID from ` +
        "a watch URL (the part after v=), containing only letters, digits, '-' and " +
        "'_'. Do not pass a URL, a title, or a comma-separated list here.",
    );
  }
  return trimmed;
}

/**
 * Reject anything but a single video ID for the audience-retention report.
 *
 * Google's docs say the retention report's `video` filter takes one ID only,
 * and the API does *not* enforce it: a live check on 2026-08-07 passing two real
 * owned video IDs returned HTTP 200 with the first video's retention curve and
 * no indication the second was dropped. A caller who assumed they were getting
 * a blended curve would get one episode's numbers labelled as two. The tool
 * boundary is the only place that can catch it, so it does.
 */
export function assertSingleVideoId(id: string): string {
  if (id.includes(",")) {
    throw new Error(
      "yt_audience_retention accepts exactly one video ID. The API silently " +
        "ignores every ID after the first and returns only that video's curve, so " +
        "a list here would produce numbers for one video labelled as several. " +
        "Call this tool once per video.",
    );
  }
  return assertVideoId(id);
}

/** Yesterday in UTC, the newest day YouTube Analytics reliably has data for. */
export function defaultEndDate(now: Date = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(label: string, value: string): string {
  if (!DATE_RE.test(value)) {
    throw new Error(
      `${label} must be a date in YYYY-MM-DD form, got "${value}". The API rejects ` +
        "anything else (confirmed: startDate=07-06-2026 returns HTTP 400).",
    );
  }
  return value;
}

/** The last calendar day of the month containing `date`, as YYYY-MM-DD. */
function lastDayOfMonth(date: string): string {
  const [y, m] = date.split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * A `month`-grouped report must span whole months.
 *
 * Google answers a misaligned range with "Date range (2026-07-06) in field
 * parameters.start-date does not align to chosen dimension" (verified live),
 * which tells the caller what is wrong but not what to pass instead.
 */
export function assertMonthAligned(startDate: string, endDate: string): void {
  if (!startDate.endsWith("-01")) {
    throw new Error(
      `group_by='month' needs start_date to be the first of a month, got "${startDate}". ` +
        `Try "${startDate.slice(0, 7)}-01".`,
    );
  }
  const expected = lastDayOfMonth(endDate);
  if (endDate !== expected) {
    throw new Error(
      `group_by='month' needs end_date to be the last day of a month, got "${endDate}". ` +
        `Try "${expected}".`,
    );
  }
}

/**
 * Metrics valid on the channel-level, geography, and per-video reports.
 *
 * This exact list was accepted with HTTP 200 on all four of those report shapes
 * (no dimension, `day`, `country`, `video`) on 2026-08-07. Enumerated rather
 * than passed through as free text so an invalid combination is a schema error
 * the agent can read, not a 400 from Google saying only "the query is not
 * supported".
 *
 * Notably absent, and absent on purpose: `impressions`, `impressionsCtr`, and
 * `uniqueViewers`. All three exist in YouTube Studio and none exists in this
 * API — each returns `Unknown identifier ... given in field parameters.metrics`
 * (verified live). See the README's Limitations section.
 */
export const CORE_METRICS = [
  "views",
  "engagedViews",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "comments",
  "shares",
] as const;

/** Metrics the traffic-source report supports. Narrower than CORE_METRICS. */
export const TRAFFIC_METRICS = [
  "views",
  "engagedViews",
  "estimatedMinutesWatched",
] as const;

/** Metrics the audience-retention report supports. */
export const RETENTION_METRICS = [
  "audienceWatchRatio",
  "relativeRetentionPerformance",
] as const;

/**
 * Metrics the playlist reports support.
 *
 * `views` and `estimatedMinutesWatched` are accepted alongside the playlist-
 * specific ones; `subscribersGained` is not (HTTP 400, verified live), which is
 * why this is its own list rather than CORE_METRICS plus extras.
 */
export const PLAYLIST_METRICS = [
  "playlistViews",
  "playlistEstimatedMinutesWatched",
  "playlistStarts",
  "viewsPerPlaylistStart",
  "averageTimeInPlaylist",
  "playlistSaves",
  "views",
  "estimatedMinutesWatched",
] as const;

export interface TitleResolution {
  titles: Map<string, string>;
  published: Map<string, string>;
  note?: string;
}

const NO_TITLES: TitleResolution = {
  titles: new Map(),
  published: new Map(),
};

/**
 * Look up titles and publish dates for a set of video IDs, or don't.
 *
 * Three outcomes, and the difference between them is the point:
 *   - `wanted === false` — no Data API call is made at all, so no quota is spent.
 *   - the credential lacks youtube.readonly — no call is made either, and the
 *     caller gets IDs plus a note instead of a 403 that kills the whole report.
 *   - otherwise — exactly one `videos.list` call per 50 IDs, 1 quota unit each.
 *
 * The "no call" legs are the ones worth testing: a title lookup that fires when
 * the caller opted out is a silent quota leak.
 */
export async function resolveTitles(
  client: YouTubeClient,
  ids: string[],
  wanted: boolean,
  hasDataScope: boolean,
): Promise<TitleResolution> {
  if (!wanted || ids.length === 0) return NO_TITLES;
  if (!hasDataScope) {
    return {
      titles: new Map(),
      published: new Map(),
      note:
        `Video titles were not resolved: the saved credential lacks the ${DATA_SCOPE} ` +
        "scope. Re-mint the credential with that scope added, or pass " +
        "resolve_titles=false to stop asking.",
    };
  }
  const res = await client.listVideos(ids);
  const titles = new Map<string, string>();
  const published = new Map<string, string>();
  for (const item of res.items ?? []) {
    if (!item.id) continue;
    if (item.snippet?.title) titles.set(item.id, item.snippet.title);
    if (item.snippet?.publishedAt) published.set(item.id, item.snippet.publishedAt);
  }
  return { titles, published };
}

/** Quota sentence appended to every tool description that can hit the Data API. */
const TITLE_QUOTA_NOTE =
  "Setting resolve_titles=true spends 1 YouTube Data API quota unit per 50 videos " +
  "(default daily budget: 10,000 units); the Analytics query itself does not draw " +
  "on that budget. Pass resolve_titles=false to return bare video IDs and spend none.";

export function createServer(
  client: YouTubeClient | null,
  hasDataScope = false,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /** Resolve the client or raise a per-tool setup error if none is configured. */
  function need(): YouTubeClient {
    if (!client) {
      throw new CredentialMissingError("~/.config/gws/youtube_credentials.json");
    }
    return client;
  }

  /**
   * Wrap a handler so any thrown error — missing credential, auth, scope, quota,
   * bad input — comes back as a readable `isError` result instead of a
   * protocol-level failure the agent cannot inspect.
   */
  function guard<A>(fn: (args: A) => Promise<ReturnType<typeof json>>) {
    return async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
  }

  const startDateArg = z
    .string()
    .describe("Start date, YYYY-MM-DD, inclusive. Interpreted in the channel's timezone.");
  const endDateArg = z
    .string()
    .describe(
      "End date, YYYY-MM-DD, inclusive. YouTube Analytics lags roughly 2-3 days, so " +
        "ending the range at today usually returns zeros for the last few days.",
    );
  const resolveTitlesArg = z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Look up each video's title so the result is readable. " + TITLE_QUOTA_NOTE,
    );

  // --- yt_channel_info ---

  server.registerTool(
    "yt_channel_info",
    {
      title: "Identify the channel behind the credential",
      description:
        "Show which YouTube channel this server's OAuth credential owns, with its " +
        "public subscriber, view, and video counts. This is the entry point: every " +
        "other tool reports on this channel and only this channel, so start here to " +
        "confirm you are looking at the right account. Costs 1 YouTube Data API " +
        "quota unit and needs the youtube.readonly scope; with only the analytics " +
        "scope it reports the scopes it has instead.",
      inputSchema: {},
      annotations: buildAnnotations("Identify the channel behind the credential"),
    },
    guard(async () => {
      const c = need();
      try {
        const data = await c.myChannel();
        const ch = data.items?.[0];
        if (!ch) {
          return json({
            note:
              "The credential authenticated but Google returned no channel for it. " +
              "The Google account may not have a YouTube channel, or may be a " +
              "brand-account manager rather than the channel owner.",
          });
        }
        return json({
          channelId: ch.id,
          title: ch.snippet?.title,
          handle: ch.snippet?.customUrl,
          createdAt: ch.snippet?.publishedAt,
          subscribers: Number(ch.statistics?.subscriberCount ?? 0),
          totalViews: Number(ch.statistics?.viewCount ?? 0),
          videoCount: Number(ch.statistics?.videoCount ?? 0),
          note:
            "Every tool in this server reads channel==MINE — this channel. It cannot " +
            "be pointed at another channel by any tool input.",
        });
      } catch (err) {
        // A missing Data scope is not a failure of the server, only of this one
        // lookup. Report what the credential *can* do rather than a bare 403.
        if (err instanceof ScopeError) {
          return json({
            channelId: null,
            note:
              "Channel identity needs the youtube.readonly scope, which this " +
              "credential does not have. Every Analytics tool still works — they " +
              "read channel==MINE, which is resolved by Google from the credential " +
              "itself. Add the scope if you want titles and channel metadata.",
          });
        }
        throw err;
      }
    }),
  );

  // --- yt_channel_overview ---

  server.registerTool(
    "yt_channel_overview",
    {
      title: "Channel performance over a date range",
      description:
        "Owner-side channel totals for a date range: views, watch time, average view " +
        "duration and percentage, subscribers gained and lost, likes, comments, and " +
        "shares. Pass group_by='day' or 'month' for a time series instead of a single " +
        "total row. This is the 'how is the channel doing' tool — start with it, then " +
        "drill into traffic sources or individual videos.",
      inputSchema: {
        start_date: startDateArg,
        end_date: endDateArg,
        metrics: z
          .array(z.enum(CORE_METRICS))
          .optional()
          .default([
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "subscribersGained",
            "subscribersLost",
          ])
          .describe("Which metrics to return. Fewer metrics, smaller response."),
        group_by: z
          .enum(["none", "day", "month"])
          .optional()
          .default("none")
          .describe(
            "'none' returns one summary row for the whole range. 'day' or 'month' " +
              "returns a time series — a 90-day range at 'day' is 90 rows, so keep " +
              "ranges short or use 'month'. 'month' requires start_date to be the " +
              "1st of a month and end_date to be a month's last day.",
          ),
      },
      annotations: buildAnnotations("Channel performance over a date range"),
    },
    guard(async ({ start_date, end_date, metrics, group_by }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      // Google rejects a month-grouped report whose range does not sit on month
      // boundaries, with "Date range (...) does not align to chosen dimension".
      // Catching it here names the actual fix.
      if (group_by === "month") assertMonthAligned(start_date, end_date);
      const dimensions = group_by === "none" ? undefined : [group_by];
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: [...metrics],
        dimensions,
        sort: dimensions ? group_by : undefined,
      });
      const rows = toObjects(res);
      return json({
        window: { startDate: start_date, endDate: end_date },
        groupBy: group_by,
        rowCount: rows.length,
        rows,
      });
    }),
  );

  // --- yt_traffic_sources ---

  server.registerTool(
    "yt_traffic_sources",
    {
      title: "Where views came from",
      description:
        "Break views and watch time down by how viewers arrived: YouTube search, " +
        "suggested/related video, channel page, playlist, external sites, " +
        "notifications, subscriptions feed, Shorts feed, end screens, and so on. The " +
        "single most useful diagnostic for 'why did this take off' or 'why did it " +
        "flatline'. Optionally scope it to one video. Source names come back as the " +
        "API's own constants (YT_SEARCH, RELATED_VIDEO, EXT_URL, SHORTS, SUBSCRIBER, " +
        "PLAYLIST, NOTIFICATION, END_SCREEN, NO_LINK_OTHER, and others).",
      inputSchema: {
        start_date: startDateArg,
        end_date: endDateArg,
        video_id: z
          .string()
          .optional()
          .describe("Optional: restrict to a single video's traffic instead of the whole channel."),
        metrics: z
          .array(z.enum(TRAFFIC_METRICS))
          .optional()
          .default(["views", "estimatedMinutesWatched"])
          .describe(
            "The traffic-source report supports only views and estimatedMinutesWatched.",
          ),
      },
      annotations: buildAnnotations("Where views came from"),
    },
    guard(async ({ start_date, end_date, video_id, metrics }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      const filters = video_id ? [`video==${assertVideoId(video_id)}`] : undefined;
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: [...metrics],
        dimensions: ["insightTrafficSourceType"],
        filters,
        sort: "-views",
      });
      const rows = toObjects(res);
      const totalViews = rows.reduce((s, r) => s + Number(r.views ?? 0), 0);
      return json({
        window: { startDate: start_date, endDate: end_date },
        scope: video_id ? { videoId: video_id } : { scope: "channel" },
        totalViews,
        rowCount: rows.length,
        // shareOfViews and totalViews are this server's arithmetic over the
        // API's own `views`, which is returned unchanged on every row beside it.
        computedFields: ["shareOfViews", "totalViews"],
        rows: rows.map((r) => ({
          ...r,
          shareOfViews:
            totalViews > 0 ? round(Number(r.views ?? 0) / totalViews, 4) : 0,
        })),
      });
    }),
  );

  // --- yt_top_videos ---

  server.registerTool(
    "yt_top_videos",
    {
      title: "Top videos by a metric",
      description:
        "Rank the channel's videos over a date range by views, watch time, average " +
        "view duration, or subscribers gained. Use this to find which videos to look " +
        "at more closely — the IDs it returns feed yt_audience_retention, " +
        "yt_traffic_sources, and yt_episode_race. max_results is capped at 200 by the " +
        "API. " +
        TITLE_QUOTA_NOTE,
      inputSchema: {
        start_date: startDateArg,
        end_date: endDateArg,
        sort_by: z
          .enum(CORE_METRICS)
          .optional()
          .default("views")
          .describe("Metric to rank by, highest first."),
        metrics: z
          .array(z.enum(CORE_METRICS))
          .optional()
          .default([
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "averageViewPercentage",
          ])
          .describe("Metrics to return per video."),
        max_results: z
          .number()
          .int()
          .optional()
          .default(10)
          .describe("How many videos to return, 1-200. Keep it low; rows cost tokens."),
        resolve_titles: resolveTitlesArg,
      },
      annotations: buildAnnotations("Top videos by a metric"),
    },
    guard(async ({ start_date, end_date, sort_by, metrics, max_results, resolve_titles }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      const capped = Math.min(Math.max(1, max_results), 200);
      // The metric being sorted on has to be requested, or the API rejects the
      // query. Merging here rather than trusting the caller keeps the tool from
      // failing on an easy mistake.
      const requested = [...new Set([...metrics, sort_by])];
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: requested,
        dimensions: ["video"],
        // A video-dimension report without a sort returns HTTP 400 "The query is
        // not supported" (verified live 2026-08-07), so this is never optional.
        sort: `-${sort_by}`,
        maxResults: capped,
      });
      const rows = toObjects(res);
      const ids = rows.map((r) => String(r.video)).filter(Boolean);
      const resolved = await resolveTitles(need(), ids, resolve_titles, hasDataScope);
      return json({
        window: { startDate: start_date, endDate: end_date },
        sortedBy: sort_by,
        rowCount: rows.length,
        note: resolved.note,
        videos: rows.map((r) => ({
          videoId: r.video,
          title: resolved.titles.get(String(r.video)),
          ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "video")),
        })),
      });
    }),
  );

  // --- yt_video_performance ---

  server.registerTool(
    "yt_video_performance",
    {
      title: "Performance of specific videos",
      description:
        "Metrics for one or more named videos over a date range — the counterpart to " +
        "yt_top_videos when you already know which videos you care about. Returns one " +
        "row per video. Note that the window is a reporting window, not the video's " +
        "lifetime: a range of the last 30 days shows the last 30 days of a video " +
        "published two years ago. " +
        TITLE_QUOTA_NOTE,
      inputSchema: {
        video_ids: z
          .array(z.string())
          .min(1)
          .describe("YouTube video IDs (the part after v= in a watch URL), 1 or more."),
        start_date: startDateArg,
        end_date: endDateArg,
        metrics: z
          .array(z.enum(CORE_METRICS))
          .optional()
          .default([
            "views",
            "estimatedMinutesWatched",
            "averageViewDuration",
            "averageViewPercentage",
            "likes",
            "comments",
          ])
          .describe("Metrics to return per video."),
        resolve_titles: resolveTitlesArg,
      },
      annotations: buildAnnotations("Performance of specific videos"),
    },
    guard(async ({ video_ids, start_date, end_date, metrics, resolve_titles }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      const ids = video_ids.map(assertVideoId);
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: [...metrics],
        dimensions: ["video"],
        filters: [`video==${ids.join(",")}`],
        sort: "-views",
      });
      const rows = toObjects(res);
      const resolved = await resolveTitles(need(), ids, resolve_titles, hasDataScope);
      const returned = new Set(rows.map((r) => String(r.video)));
      const missing = ids.filter((id) => !returned.has(id));
      return json({
        window: { startDate: start_date, endDate: end_date },
        requested: ids.length,
        rowCount: rows.length,
        // A video with no activity in the window is simply absent from `rows`.
        // Saying so beats letting the caller conclude the ID was wrong.
        noDataInWindow: missing.length ? missing : undefined,
        note: resolved.note,
        videos: rows.map((r) => ({
          videoId: r.video,
          title: resolved.titles.get(String(r.video)),
          ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "video")),
        })),
      });
    }),
  );

  // --- yt_audience_retention ---

  server.registerTool(
    "yt_audience_retention",
    {
      title: "Audience retention curve for one video",
      description:
        "The retention curve for a single video: at each 1% slice of its runtime, " +
        "what fraction of viewers were still watching (audienceWatchRatio) and how " +
        "that compares with similar YouTube videos of similar length " +
        "(relativeRetentionPerformance, 0-1 where 0.5 is median). This is where you " +
        "find the drop-off — the intro that loses people, the mid-roll dip. Exactly " +
        "one video ID: the API accepts a list but silently reports only the first, so " +
        "this tool rejects lists rather than mislabel the result.",
      inputSchema: {
        video_id: z
          .string()
          .describe("A single YouTube video ID. Lists are rejected — call once per video."),
        start_date: startDateArg,
        end_date: endDateArg,
        metrics: z
          .array(z.enum(RETENTION_METRICS))
          .optional()
          .default(["audienceWatchRatio", "relativeRetentionPerformance"])
          .describe("Retention metrics to return."),
        sample_every: z
          .number()
          .int()
          .optional()
          .default(5)
          .describe(
            "Return every Nth point of the curve to keep the response small. The API " +
              "returns ~100 points (one per 1% of runtime); the default of 5 gives ~20. " +
              "Pass 1 for the full curve.",
          ),
      },
      annotations: buildAnnotations("Audience retention curve for one video"),
    },
    guard(async ({ video_id, start_date, end_date, metrics, sample_every }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      const id = assertSingleVideoId(video_id);
      const step = Math.max(1, sample_every);
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: [...metrics],
        dimensions: ["elapsedVideoTimeRatio"],
        filters: [`video==${id}`],
      });
      const all = toObjects(res);
      const sampled = all.filter((_, i) => i % step === 0);
      return json({
        videoId: id,
        window: { startDate: start_date, endDate: end_date },
        pointsAvailable: all.length,
        sampleEvery: step,
        pointsReturned: sampled.length,
        note:
          all.length === 0
            ? "No retention data. YouTube withholds the retention report for videos " +
              "below a watch-time threshold, and returns nothing for a video with no " +
              "views in the window."
            : "elapsedVideoTimeRatio is the fraction of the video elapsed (0.01 = 1%). " +
              "audienceWatchRatio above 1.0 at the start reflects viewers rewatching " +
              "that segment.",
        curve: sampled,
      });
    }),
  );

  // --- yt_geography ---

  server.registerTool(
    "yt_geography",
    {
      title: "Views by country",
      description:
        "Break views and watch time down by viewer country, ranked. Countries come " +
        "back as ISO 3166-1 alpha-2 codes (US, GB, IN). Optionally scope to a single " +
        "video. Useful for deciding where an audience actually is before making " +
        "scheduling, language, or sponsorship calls.",
      inputSchema: {
        start_date: startDateArg,
        end_date: endDateArg,
        video_id: z
          .string()
          .optional()
          .describe("Optional: restrict to one video instead of the whole channel."),
        metrics: z
          .array(z.enum(CORE_METRICS))
          .optional()
          .default(["views", "estimatedMinutesWatched", "averageViewDuration"])
          .describe("Metrics to return per country."),
        max_results: z
          .number()
          .int()
          .optional()
          .default(15)
          .describe("How many countries to return, ranked by views. 1-200."),
      },
      annotations: buildAnnotations("Views by country"),
    },
    guard(async ({ start_date, end_date, video_id, metrics, max_results }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      const capped = Math.min(Math.max(1, max_results), 200);
      const filters = video_id ? [`video==${assertVideoId(video_id)}`] : undefined;
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: [...new Set([...metrics, "views"])],
        dimensions: ["country"],
        filters,
        sort: "-views",
        maxResults: capped,
      });
      const rows = toObjects(res);
      const totalViews = rows.reduce((s, r) => s + Number(r.views ?? 0), 0);
      return json({
        window: { startDate: start_date, endDate: end_date },
        scope: video_id ? { videoId: video_id } : { scope: "channel" },
        totalViews,
        rowCount: rows.length,
        // shareOfViews and totalViews are this server's arithmetic over the
        // API's own `views`, which is returned unchanged on every row beside it.
        computedFields: ["shareOfViews", "totalViews"],
        rows: rows.map((r) => ({
          ...r,
          shareOfViews:
            totalViews > 0 ? round(Number(r.views ?? 0) / totalViews, 4) : 0,
        })),
      });
    }),
  );

  // --- yt_playlist_performance ---

  server.registerTool(
    "yt_playlist_performance",
    {
      title: "Playlist and podcast-series performance",
      description:
        "How your playlists perform as playlists, not just as bags of videos. A " +
        "YouTube podcast IS a playlist, so this is the series-level view: " +
        "playlistStarts (how often someone began the series), viewsPerPlaylistStart " +
        "(how many episodes they watched before leaving — the binge metric), " +
        "averageTimeInPlaylist in seconds, playlistSaves, and playlist-scoped views " +
        "and watch time. Group by 'playlist' to rank series, 'day' for a trend, or " +
        "'none' for a channel-wide total. Ranking by playlist requires a sort order, " +
        "which this tool always sends.",
      inputSchema: {
        start_date: startDateArg,
        end_date: endDateArg,
        group_by: z
          .enum(["playlist", "day", "none"])
          .optional()
          .default("playlist")
          .describe(
            "'playlist' returns one row per playlist, ranked. 'day' returns a trend " +
              "across all playlists. 'none' returns a single channel-wide total.",
          ),
        metrics: z
          .array(z.enum(PLAYLIST_METRICS))
          .optional()
          .default([
            "playlistViews",
            "playlistEstimatedMinutesWatched",
            "playlistStarts",
            "viewsPerPlaylistStart",
            "averageTimeInPlaylist",
            "playlistSaves",
          ])
          .describe(
            "Playlist metrics to return. subscribersGained and other channel metrics " +
              "are not valid on playlist reports and are not offered here.",
          ),
        sort_by: z
          .enum(PLAYLIST_METRICS)
          .optional()
          .default("playlistViews")
          .describe("Metric to rank playlists by, highest first. Ignored when group_by='day'."),
        max_results: z
          .number()
          .int()
          .optional()
          .default(15)
          .describe("How many playlists to return when group_by='playlist'. 1-200."),
      },
      annotations: buildAnnotations("Playlist and podcast-series performance"),
    },
    guard(async ({ start_date, end_date, group_by, metrics, sort_by, max_results }) => {
      assertDate("start_date", start_date);
      assertDate("end_date", end_date);
      const requested =
        group_by === "playlist" ? [...new Set([...metrics, sort_by])] : [...metrics];
      const res = await need().report({
        startDate: start_date,
        endDate: end_date,
        metrics: requested,
        dimensions: group_by === "none" ? undefined : [group_by],
        // A playlist-dimension report without a sort is HTTP 400 "The query is
        // not supported" (verified live 2026-08-07), same rule as the video
        // dimension. `day` sorts ascending so the trend reads left to right.
        sort:
          group_by === "playlist" ? `-${sort_by}` : group_by === "day" ? "day" : undefined,
        maxResults:
          group_by === "playlist" ? Math.min(Math.max(1, max_results), 200) : undefined,
      });
      const rows = toObjects(res);
      return json({
        window: { startDate: start_date, endDate: end_date },
        groupBy: group_by,
        rowCount: rows.length,
        howToRead:
          "viewsPerPlaylistStart is episodes watched per session started — the " +
          "closest thing YouTube gives you to a podcast retention number. " +
          "averageTimeInPlaylist is in seconds. All values come straight from the " +
          "API; this tool computes nothing.",
        rows,
      });
    }),
  );

  // --- yt_episode_race (derived view) ---

  server.registerTool(
    "yt_episode_race",
    {
      title: "Episode-over-episode race, normalised by age",
      description:
        "The derived view: compare several videos on equal terms by re-indexing each " +
        "one's daily numbers to days since its own publish date, so day 7 of a new " +
        "episode sits next to day 7 of the last five. Raw totals cannot answer 'is " +
        "this episode outperforming?' because an older video has simply had more days " +
        "to accumulate; this removes that. Returns each video's cumulative curve by " +
        "age plus a leaderboard at the oldest day all of them have reached, with each " +
        "video's raw per-day API values returned alongside the running totals. Costs " +
        "1 YouTube Data API quota unit for publish dates (required — the " +
        "normalisation is impossible without them) plus one Analytics query per video.",
      inputSchema: {
        video_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .describe(
            "Two to ten video IDs to compare. Get them from yt_top_videos, or use " +
              "your last N episode IDs.",
          ),
        window_days: z
          .number()
          .int()
          .optional()
          .default(28)
          .describe(
            "How many days after publish to track, 1-90. Each video's curve is " +
              "truncated at its actual age — a 3-day-old video returns 4 points, not " +
              "28 padded ones.",
          ),
        metric: z
          .enum(["views", "estimatedMinutesWatched"])
          .optional()
          .default("views")
          .describe("Which metric to race on."),
        as_of_date: z
          .string()
          .optional()
          .describe(
            "Treat this date as 'today', YYYY-MM-DD. Defaults to yesterday (UTC), " +
              "since YouTube Analytics lags. Pass it explicitly for a reproducible " +
              "comparison.",
          ),
      },
      annotations: buildAnnotations("Episode-over-episode race, normalised by age"),
    },
    guard(async ({ video_ids, window_days, metric, as_of_date }) => {
      const c = need();
      const ids = video_ids.map(assertVideoId);
      const window = Math.min(Math.max(1, window_days), 90);
      const asOf = as_of_date ? assertDate("as_of_date", as_of_date) : defaultEndDate();

      // Publish dates are not optional here, unlike the title lookup elsewhere:
      // without them there is no age axis and the tool has nothing to compute.
      const meta = await resolveTitles(c, ids, true, hasDataScope);
      if (meta.note) {
        throw new ScopeError(
          "/youtube/v3/videos",
          DATA_SCOPE +
            " (yt_episode_race needs publish dates to normalise by age; there is no " +
            "way to compute this view without them)",
        );
      }

      const videos: Record<string, unknown>[] = [];
      for (const id of ids) {
        const publishedAt = meta.published.get(id);
        if (!publishedAt) {
          videos.push({
            videoId: id,
            error: "No publish date returned for this ID — check that it exists and belongs to this channel.",
          });
          continue;
        }
        const publishDate = isoDate(publishedAt);
        const ageDays = daysBetween(publishDate, asOf);
        if (ageDays < 0) {
          videos.push({
            videoId: id,
            title: meta.titles.get(id),
            publishedAt,
            note: `Published after as_of_date (${asOf}); nothing to measure yet.`,
          });
          continue;
        }
        // Ask only for the days that exist. Querying past `asOf` returns rows of
        // zeros that would pad the curve into a fake flatline.
        const endDate = addDays(publishDate, Math.min(window - 1, ageDays));
        const res = await c.report({
          startDate: publishDate,
          endDate,
          metrics: [metric],
          dimensions: ["day"],
          filters: [`video==${id}`],
          sort: "day",
        });
        const points: DailyPoint[] = toObjects(res).map((r) => ({
          day: String(r.day),
          value: Number(r[metric] ?? 0),
        }));
        const length = Math.min(ageDays + 1, window);
        const series = alignToAge(points, publishDate, length);
        videos.push({
          videoId: id,
          title: meta.titles.get(id),
          publishedAt,
          ageDays,
          daysTracked: length,
          total: series.total,
          // `daily` is what the API returned, re-indexed but not transformed.
          // It travels with the running totals so the caller always has the
          // original values next to anything this server computed.
          daily: series.daily,
          cumulative: series.cumulative,
        });
      }

      // The only honest comparison point is the oldest day every video has
      // actually reached. Comparing a 30-day total against a 3-day total is the
      // exact mistake this tool exists to prevent, so the leaderboard is pinned
      // to the minimum.
      const tracked = videos.filter((v) => typeof v.daysTracked === "number");
      const comparableAtDay =
        tracked.length > 0
          ? Math.min(...tracked.map((v) => (v.daysTracked as number) - 1))
          : null;

      const leaderboard =
        comparableAtDay === null
          ? undefined
          : tracked
              .map((v) => ({
                videoId: v.videoId,
                title: v.title,
                value: (v.cumulative as number[])[comparableAtDay] ?? 0,
              }))
              .sort((a, b) => b.value - a.value);

      return json({
        metric,
        windowDays: window,
        asOfDate: asOf,
        comparableAtDay,
        howToRead:
          "daily[n] is the API's own value for the nth day after that video's publish " +
          "date, so index 0 is publish day. cumulative[n] is the running sum of " +
          "daily[0..n]. leaderboard ranks every video at " +
          `day ${comparableAtDay ?? "n/a"} — the oldest age all of them have reached.`,
        // Named explicitly so nothing this server calculated can be mistaken for
        // a figure YouTube reported. Everything else in this response is the
        // API's own value, re-indexed but not transformed.
        computedFields: ["cumulative", "total", "ageDays", "comparableAtDay", "leaderboard"],
        leaderboard,
        videos,
      });
    }),
  );

  return server;
}

export { errorResult };
