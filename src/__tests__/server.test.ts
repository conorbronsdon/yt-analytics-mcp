import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ReportQuery, YouTubeClient } from "../client.js";
import { ScopeError } from "../errors.js";
import {
  assertDate,
  assertMonthAligned,
  assertSingleVideoId,
  assertVideoId,
  createServer,
  defaultEndDate,
  resolveTitles,
} from "../server.js";
import type {
  ChannelListResponse,
  ReportResponse,
  VideoListResponse,
} from "../types.js";

/**
 * A recording stand-in for YouTubeClient. Every assertion about what the server
 * *asked Google for* reads `reportCalls`, so the tests pin exact request
 * parameters rather than "a report was requested".
 */
class FakeClient {
  reportCalls: ReportQuery[] = [];
  videoCalls: string[][] = [];
  channelCalls = 0;
  reportResponses: ReportResponse[] = [];
  videoResponse: VideoListResponse = { items: [] };
  channelResponse: ChannelListResponse = { items: [] };
  reportError: Error | null = null;
  videoError: Error | null = null;
  channelError: Error | null = null;

  async report(q: ReportQuery): Promise<ReportResponse> {
    this.reportCalls.push(q);
    if (this.reportError) throw this.reportError;
    return this.reportResponses[this.reportCalls.length - 1] ?? { rows: [] };
  }

  async listVideos(ids: string[]): Promise<VideoListResponse> {
    this.videoCalls.push(ids);
    if (this.videoError) throw this.videoError;
    return this.videoResponse;
  }

  async myChannel(): Promise<ChannelListResponse> {
    this.channelCalls += 1;
    if (this.channelError) throw this.channelError;
    return this.channelResponse;
  }

  asClient(): YouTubeClient {
    return this as unknown as YouTubeClient;
  }
}

let fake: FakeClient;

beforeEach(() => {
  fake = new FakeClient();
});

async function connect(client: FakeClient | null, hasDataScope = true): Promise<Client> {
  const server = createServer(client ? client.asClient() : null, hasDataScope);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "server-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

interface ToolCallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  client: FakeClient | null = fake,
  hasDataScope = true,
): Promise<ToolCallResult> {
  const mcp = await connect(client, hasDataScope);
  return (await mcp.callTool({ name, arguments: args })) as unknown as ToolCallResult;
}

const parse = (r: ToolCallResult) => JSON.parse(r.content[0].text);
const text = (r: ToolCallResult) => r.content[0].text;

const WINDOW = { start_date: "2026-07-06", end_date: "2026-08-05" };

// ── Input guards ──────────────────────────────────────────────────────

describe("assertVideoId", () => {
  it("accepts real IDs unchanged and trims surrounding space", () => {
    expect(assertVideoId("9QQA4TZvEKU")).toBe("9QQA4TZvEKU");
    expect(assertVideoId("PJ-3hXAUotI")).toBe("PJ-3hXAUotI");
    expect(assertVideoId("  4-OwCY3RGV0  ")).toBe("4-OwCY3RGV0");
  });

  it("must-fail leg: rejects every character that could inject a filter clause", () => {
    // `filters` uses ';' between clauses and ',' between values, so an
    // unvalidated ID could append a clause the caller never asked for and
    // silently change what the report covers.
    expect(() => assertVideoId("abc;country==US")).toThrow(/not a valid YouTube video ID/);
    expect(() => assertVideoId("abc,def")).toThrow();
    expect(() => assertVideoId("abc==def")).toThrow();
    expect(() => assertVideoId("https://youtu.be/9QQA4TZvEKU")).toThrow();
    expect(() => assertVideoId("")).toThrow();
    expect(() => assertVideoId("a".repeat(25))).toThrow();
  });
});

describe("assertSingleVideoId", () => {
  it("accepts one ID", () => {
    expect(assertSingleVideoId("9QQA4TZvEKU")).toBe("9QQA4TZvEKU");
  });

  it("must-fail leg: rejects a list, because the API would silently drop all but the first", () => {
    // Verified live 2026-08-07: filters=video==A,B on the retention report
    // returned HTTP 200 with A's curve and no error. The API will not catch
    // this, so the boundary has to.
    expect(() => assertSingleVideoId("9QQA4TZvEKU,PJ-3hXAUotI")).toThrow(
      /silently ignores every ID after the first/,
    );
  });
});

describe("assertDate", () => {
  it("accepts YYYY-MM-DD and rejects everything else", () => {
    expect(assertDate("start_date", "2026-07-06")).toBe("2026-07-06");
    // The live 400: "Could not parse content (07-06-2026) of field startDate."
    expect(() => assertDate("start_date", "07-06-2026")).toThrow(/YYYY-MM-DD/);
    expect(() => assertDate("start_date", "2026-7-6")).toThrow();
    expect(() => assertDate("start_date", "last tuesday")).toThrow();
  });
});

describe("defaultEndDate", () => {
  it("is yesterday in UTC, because today's data is not there yet", () => {
    expect(defaultEndDate(new Date("2026-08-07T12:00:00Z"))).toBe("2026-08-06");
    expect(defaultEndDate(new Date("2026-01-01T00:30:00Z"))).toBe("2025-12-31");
  });
});

// ── resolveTitles: the quota carve-out ────────────────────────────────

describe("resolveTitles", () => {
  it("must-still-fire: makes exactly one lookup when asked and allowed", async () => {
    fake.videoResponse = {
      items: [{ id: "abc", snippet: { title: "T", publishedAt: "2026-07-06T16:00:23Z" } }],
    };
    const out = await resolveTitles(fake.asClient(), ["abc"], true, true);
    expect(fake.videoCalls).toEqual([["abc"]]);
    expect(out.titles.get("abc")).toBe("T");
    expect(out.published.get("abc")).toBe("2026-07-06T16:00:23Z");
    expect(out.note).toBeUndefined();
  });

  it("must-not-fire: spends nothing when the caller opted out", async () => {
    const out = await resolveTitles(fake.asClient(), ["abc"], false, true);
    expect(fake.videoCalls).toEqual([]);
    expect(out.titles.size).toBe(0);
  });

  it("must-not-fire: spends nothing when the scope is absent, and says why", async () => {
    const out = await resolveTitles(fake.asClient(), ["abc"], true, false);
    expect(fake.videoCalls).toEqual([]);
    expect(out.note).toMatch(/youtube\.readonly/);
    expect(out.note).toMatch(/resolve_titles=false/);
  });

  it("must-not-fire: an empty ID list makes no call", async () => {
    const out = await resolveTitles(fake.asClient(), [], true, true);
    expect(fake.videoCalls).toEqual([]);
    expect(out.titles.size).toBe(0);
  });
});

// ── Per-tool request construction ─────────────────────────────────────

describe("yt_channel_overview", () => {
  it("sends no dimension for a summary, and a sorted dimension for a series", async () => {
    await call("yt_channel_overview", { ...WINDOW });
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: [
        "views",
        "estimatedMinutesWatched",
        "averageViewDuration",
        "subscribersGained",
        "subscribersLost",
      ],
      dimensions: undefined,
      sort: undefined,
    });

    fake = new FakeClient();
    await call("yt_channel_overview", { ...WINDOW, group_by: "day", metrics: ["views"] });
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
      dimensions: ["day"],
      sort: "day",
    });
  });

  it("returns named rows built from the live payload shape", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [
          { name: "views", columnType: "METRIC" },
          { name: "estimatedMinutesWatched", columnType: "METRIC" },
        ],
        rows: [[1388, 2219]],
      },
    ];
    const out = parse(await call("yt_channel_overview", { ...WINDOW, metrics: ["views"] }));
    expect(out.rowCount).toBe(1);
    expect(out.rows).toEqual([{ views: 1388, estimatedMinutesWatched: 2219 }]);
    expect(out.window).toEqual({ startDate: "2026-07-06", endDate: "2026-08-05" });
  });

  it("rejects a malformed date before any request goes out", async () => {
    const res = await call("yt_channel_overview", { start_date: "07-06-2026", end_date: "2026-08-05" });
    expect(res.isError).toBe(true);
    expect(fake.reportCalls).toEqual([]);
  });
});

describe("yt_traffic_sources", () => {
  it("asks for the traffic-source dimension sorted by views, unscoped by default", async () => {
    await call("yt_traffic_sources", { ...WINDOW });
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views", "estimatedMinutesWatched"],
      dimensions: ["insightTrafficSourceType"],
      filters: undefined,
      sort: "-views",
    });
  });

  it("adds a single video filter clause when scoped", async () => {
    await call("yt_traffic_sources", { ...WINDOW, video_id: "9QQA4TZvEKU" });
    expect(fake.reportCalls[0].filters).toEqual(["video==9QQA4TZvEKU"]);
  });

  it("computes each source's share from the live traffic mix", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [
          { name: "insightTrafficSourceType" },
          { name: "views" },
          { name: "estimatedMinutesWatched" },
        ],
        rows: [
          ["SHORTS", 834, 75],
          ["NO_LINK_OTHER", 116, 327],
          ["YT_SEARCH", 50, 420],
        ],
      },
    ];
    const out = parse(await call("yt_traffic_sources", { ...WINDOW }));
    expect(out.totalViews).toBe(1000);
    expect(out.rows[0]).toEqual({
      insightTrafficSourceType: "SHORTS",
      views: 834,
      estimatedMinutesWatched: 75,
      shareOfViews: 0.834,
    });
    expect(out.rows[2].shareOfViews).toBe(0.05);
  });

  it("does not divide by zero on an empty channel", async () => {
    fake.reportResponses = [
      { columnHeaders: [{ name: "insightTrafficSourceType" }, { name: "views" }], rows: [] },
    ];
    const out = parse(await call("yt_traffic_sources", { ...WINDOW }));
    expect(out.totalViews).toBe(0);
    expect(out.rows).toEqual([]);
  });
});

describe("yt_top_videos", () => {
  it("always sends a sort, because a video-dimension report without one is a 400", async () => {
    await call("yt_top_videos", { ...WINDOW, resolve_titles: false });
    expect(fake.reportCalls[0].sort).toBe("-views");
    expect(fake.reportCalls[0].dimensions).toEqual(["video"]);
  });

  it("adds the sort metric to the requested metrics when it is missing", async () => {
    // Sorting on a metric that was not requested is a 400. Merging it in beats
    // failing on an easy caller mistake.
    await call("yt_top_videos", {
      ...WINDOW,
      sort_by: "subscribersGained",
      metrics: ["views"],
      resolve_titles: false,
    });
    expect(fake.reportCalls[0].metrics).toEqual(["views", "subscribersGained"]);
    expect(fake.reportCalls[0].sort).toBe("-subscribersGained");
  });

  it("does not duplicate the sort metric when it was already requested", async () => {
    await call("yt_top_videos", {
      ...WINDOW,
      sort_by: "views",
      metrics: ["views", "likes"],
      resolve_titles: false,
    });
    expect(fake.reportCalls[0].metrics).toEqual(["views", "likes"]);
  });

  it("clamps max_results to the API's 200 ceiling and to a floor of 1", async () => {
    await call("yt_top_videos", { ...WINDOW, max_results: 500, resolve_titles: false });
    expect(fake.reportCalls[0].maxResults).toBe(200);

    fake = new FakeClient();
    await call("yt_top_videos", { ...WINDOW, max_results: 0, resolve_titles: false });
    expect(fake.reportCalls[0].maxResults).toBe(1);

    fake = new FakeClient();
    await call("yt_top_videos", { ...WINDOW, max_results: 7, resolve_titles: false });
    expect(fake.reportCalls[0].maxResults).toBe(7);
  });

  it("joins titles onto rows and renames the video column", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [{ name: "video" }, { name: "views" }],
        rows: [
          ["9QQA4TZvEKU", 437],
          ["PJ-3hXAUotI", 153],
        ],
      },
    ];
    fake.videoResponse = {
      items: [
        { id: "9QQA4TZvEKU", snippet: { title: "Prove you're 18 without revealing your birthday" } },
        { id: "PJ-3hXAUotI", snippet: { title: "You Can't Secure an AI Agent with Software" } },
      ],
    };
    const out = parse(await call("yt_top_videos", { ...WINDOW, metrics: ["views"] }));
    expect(fake.videoCalls).toEqual([["9QQA4TZvEKU", "PJ-3hXAUotI"]]);
    expect(out.videos).toEqual([
      {
        videoId: "9QQA4TZvEKU",
        title: "Prove you're 18 without revealing your birthday",
        views: 437,
      },
      {
        videoId: "PJ-3hXAUotI",
        title: "You Can't Secure an AI Agent with Software",
        views: 153,
      },
    ]);
  });

  it("must-not-fire: resolve_titles=false spends no Data API quota", async () => {
    fake.reportResponses = [
      { columnHeaders: [{ name: "video" }, { name: "views" }], rows: [["9QQA4TZvEKU", 437]] },
    ];
    const out = parse(await call("yt_top_videos", { ...WINDOW, resolve_titles: false }));
    expect(fake.videoCalls).toEqual([]);
    expect(out.videos[0]).toEqual({ videoId: "9QQA4TZvEKU", views: 437 });
  });

  it("degrades to IDs with a note when the Data scope is absent", async () => {
    fake.reportResponses = [
      { columnHeaders: [{ name: "video" }, { name: "views" }], rows: [["9QQA4TZvEKU", 437]] },
    ];
    const out = parse(await call("yt_top_videos", { ...WINDOW }, fake, false));
    // The analytics report still succeeded — a missing optional scope must not
    // take the whole tool down.
    expect(fake.videoCalls).toEqual([]);
    expect(out.videos[0].videoId).toBe("9QQA4TZvEKU");
    expect(out.note).toMatch(/youtube\.readonly/);
  });
});

describe("yt_video_performance", () => {
  it("filters on a comma-joined ID list inside one clause", async () => {
    await call("yt_video_performance", {
      ...WINDOW,
      video_ids: ["9QQA4TZvEKU", "PJ-3hXAUotI"],
      metrics: ["views"],
      resolve_titles: false,
    });
    expect(fake.reportCalls[0].filters).toEqual(["video==9QQA4TZvEKU,PJ-3hXAUotI"]);
    expect(fake.reportCalls[0].dimensions).toEqual(["video"]);
    expect(fake.reportCalls[0].sort).toBe("-views");
  });

  it("names the IDs that returned no rows instead of leaving them unexplained", async () => {
    fake.reportResponses = [
      { columnHeaders: [{ name: "video" }, { name: "views" }], rows: [["9QQA4TZvEKU", 437]] },
    ];
    const out = parse(
      await call("yt_video_performance", {
        ...WINDOW,
        video_ids: ["9QQA4TZvEKU", "PJ-3hXAUotI"],
        metrics: ["views"],
        resolve_titles: false,
      }),
    );
    expect(out.requested).toBe(2);
    expect(out.rowCount).toBe(1);
    expect(out.noDataInWindow).toEqual(["PJ-3hXAUotI"]);
  });

  it("omits noDataInWindow entirely when every ID came back", async () => {
    fake.reportResponses = [
      { columnHeaders: [{ name: "video" }, { name: "views" }], rows: [["9QQA4TZvEKU", 437]] },
    ];
    const out = parse(
      await call("yt_video_performance", {
        ...WINDOW,
        video_ids: ["9QQA4TZvEKU"],
        metrics: ["views"],
        resolve_titles: false,
      }),
    );
    expect(out.noDataInWindow).toBeUndefined();
  });

  it("rejects an injected filter clause before any request", async () => {
    const res = await call("yt_video_performance", {
      ...WINDOW,
      video_ids: ["9QQA4TZvEKU;country==US"],
      resolve_titles: false,
    });
    expect(res.isError).toBe(true);
    expect(fake.reportCalls).toEqual([]);
  });
});

describe("yt_audience_retention", () => {
  it("uses the retention dimension and a single-video filter", async () => {
    await call("yt_audience_retention", { ...WINDOW, video_id: "9QQA4TZvEKU" });
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["audienceWatchRatio", "relativeRetentionPerformance"],
      dimensions: ["elapsedVideoTimeRatio"],
      filters: ["video==9QQA4TZvEKU"],
    });
  });

  it("refuses a two-video list and issues no request at all", async () => {
    const res = await call("yt_audience_retention", {
      ...WINDOW,
      video_id: "9QQA4TZvEKU,PJ-3hXAUotI",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/silently ignores every ID after the first/);
    // The whole point: the request never reaches Google, because Google would
    // answer it with a 200 and one video's curve.
    expect(fake.reportCalls).toEqual([]);
  });

  it("samples every Nth point and reports both counts", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }],
        rows: Array.from({ length: 10 }, (_, i) => [round2((i + 1) / 100), 1 - i / 100]),
      },
    ];
    const out = parse(
      await call("yt_audience_retention", {
        ...WINDOW,
        video_id: "9QQA4TZvEKU",
        sample_every: 5,
      }),
    );
    expect(out.pointsAvailable).toBe(10);
    expect(out.pointsReturned).toBe(2);
    expect(out.curve.map((p: { elapsedVideoTimeRatio: number }) => p.elapsedVideoTimeRatio))
      .toEqual([0.01, 0.06]);
  });

  it("sample_every=1 returns the whole curve", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }],
        rows: Array.from({ length: 10 }, (_, i) => [round2((i + 1) / 100), 1]),
      },
    ];
    const out = parse(
      await call("yt_audience_retention", { ...WINDOW, video_id: "abc", sample_every: 1 }),
    );
    expect(out.pointsReturned).toBe(10);
  });

  it("explains an empty curve rather than returning a bare empty array", async () => {
    fake.reportResponses = [
      { columnHeaders: [{ name: "elapsedVideoTimeRatio" }], rows: [] },
    ];
    const out = parse(
      await call("yt_audience_retention", { ...WINDOW, video_id: "9QQA4TZvEKU" }),
    );
    expect(out.pointsAvailable).toBe(0);
    expect(out.note).toMatch(/watch-time threshold/);
  });
});

describe("yt_geography", () => {
  it("sorts by views and always requests the views metric it divides by", async () => {
    await call("yt_geography", { ...WINDOW, metrics: ["estimatedMinutesWatched"] });
    expect(fake.reportCalls[0].dimensions).toEqual(["country"]);
    expect(fake.reportCalls[0].sort).toBe("-views");
    // shareOfViews needs `views`; asking for it implicitly avoids dividing by a
    // column the report never returned.
    expect(fake.reportCalls[0].metrics).toEqual(["estimatedMinutesWatched", "views"]);
  });

  it("returns shares from the live geography mix", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [{ name: "country" }, { name: "views" }],
        rows: [
          ["US", 440, ],
          ["GB", 0],
        ],
      },
    ];
    const out = parse(await call("yt_geography", { ...WINDOW, metrics: ["views"] }));
    expect(out.totalViews).toBe(440);
    expect(out.rows[0]).toEqual({ country: "US", views: 440, shareOfViews: 1 });
    expect(out.rows[1]).toEqual({ country: "GB", views: 0, shareOfViews: 0 });
  });
});

describe("yt_playlist_performance", () => {
  it("always sends a sort on the playlist dimension — without one it is a 400", async () => {
    await call("yt_playlist_performance", { ...WINDOW });
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: [
        "playlistViews",
        "playlistEstimatedMinutesWatched",
        "playlistStarts",
        "viewsPerPlaylistStart",
        "averageTimeInPlaylist",
        "playlistSaves",
      ],
      dimensions: ["playlist"],
      sort: "-playlistViews",
      maxResults: 15,
    });
  });

  it("sorts a day-grouped trend ascending and sends no maxResults", async () => {
    await call("yt_playlist_performance", { ...WINDOW, group_by: "day", metrics: ["playlistViews"] });
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["playlistViews"],
      dimensions: ["day"],
      sort: "day",
      maxResults: undefined,
    });
  });

  it("sends neither dimension nor sort for a channel-wide total", async () => {
    await call("yt_playlist_performance", { ...WINDOW, group_by: "none", metrics: ["playlistViews"] });
    expect(fake.reportCalls[0].dimensions).toBeUndefined();
    expect(fake.reportCalls[0].sort).toBeUndefined();
    expect(fake.reportCalls[0].maxResults).toBeUndefined();
  });

  it("merges the sort metric in only when ranking playlists", async () => {
    await call("yt_playlist_performance", {
      ...WINDOW,
      sort_by: "playlistStarts",
      metrics: ["playlistViews"],
    });
    expect(fake.reportCalls[0].metrics).toEqual(["playlistViews", "playlistStarts"]);

    // A day trend has no ranking, so nothing should be merged in.
    fake = new FakeClient();
    await call("yt_playlist_performance", {
      ...WINDOW,
      group_by: "day",
      sort_by: "playlistStarts",
      metrics: ["playlistViews"],
    });
    expect(fake.reportCalls[0].metrics).toEqual(["playlistViews"]);
  });

  it("returns the live playlist row shape unchanged", async () => {
    fake.reportResponses = [
      {
        columnHeaders: [
          { name: "playlist" },
          { name: "playlistViews" },
          { name: "playlistStarts" },
          { name: "viewsPerPlaylistStart" },
          { name: "averageTimeInPlaylist" },
        ],
        rows: [["PLoEzTKs7j7PUpxJzHXlUA5hwh_dNbrps9", 19, 5, 3.8, 782]],
      },
    ];
    const out = parse(await call("yt_playlist_performance", { ...WINDOW }));
    expect(out.rows).toEqual([
      {
        playlist: "PLoEzTKs7j7PUpxJzHXlUA5hwh_dNbrps9",
        playlistViews: 19,
        playlistStarts: 5,
        viewsPerPlaylistStart: 3.8,
        averageTimeInPlaylist: 782,
      },
    ]);
    // This tool computes nothing, so it must not claim to.
    expect(out.computedFields).toBeUndefined();
  });

  it("clamps max_results to 1-200", async () => {
    await call("yt_playlist_performance", { ...WINDOW, max_results: 900 });
    expect(fake.reportCalls[0].maxResults).toBe(200);
  });
});

describe("metrics the API does not have", () => {
  // Verified live 2026-08-07: each of these returns HTTP 400 "Unknown identifier
  // (...) given in field parameters.metrics". They exist in YouTube Studio, and
  // competing servers advertise them, so the schema has to refuse them rather
  // than pass them through to a confusing 400.
  it.each(["impressions", "impressionsCtr", "uniqueViewers", "ctr"])(
    "rejects %s at the schema boundary, before any request",
    async (metric) => {
      const res = await call("yt_channel_overview", { ...WINDOW, metrics: [metric] });
      expect(res.isError).toBe(true);
      expect(fake.reportCalls).toEqual([]);
    },
  );

  it("must-still-fire: the metrics that DO exist are accepted", async () => {
    // The complement. Without this, a schema that rejected every metric would
    // pass the block above.
    const res = await call("yt_channel_overview", {
      ...WINDOW,
      metrics: ["views", "engagedViews", "estimatedMinutesWatched"],
    });
    expect(res.isError).toBeFalsy();
    expect(fake.reportCalls[0].metrics).toEqual([
      "views",
      "engagedViews",
      "estimatedMinutesWatched",
    ]);
  });
});

describe("assertMonthAligned", () => {
  it("accepts a whole-month range", () => {
    expect(() => assertMonthAligned("2026-07-01", "2026-07-31")).not.toThrow();
    expect(() => assertMonthAligned("2026-02-01", "2026-02-28")).not.toThrow();
  });

  it("names the date to use instead of echoing Google's message", () => {
    expect(() => assertMonthAligned("2026-07-06", "2026-07-31")).toThrow(/Try "2026-07-01"/);
    expect(() => assertMonthAligned("2026-07-01", "2026-08-05")).toThrow(/Try "2026-08-31"/);
  });

  it("gets February right in a leap year", () => {
    // 2028 is a leap year; 2026 is not. A hardcoded 28 would pass the first
    // assertion above and fail here.
    expect(() => assertMonthAligned("2028-02-01", "2028-02-29")).not.toThrow();
    expect(() => assertMonthAligned("2028-02-01", "2028-02-28")).toThrow(/Try "2028-02-29"/);
  });

  it("blocks a misaligned month report before the request goes out", async () => {
    const res = await call("yt_channel_overview", {
      start_date: "2026-07-06",
      end_date: "2026-08-05",
      group_by: "month",
    });
    expect(res.isError).toBe(true);
    expect(fake.reportCalls).toEqual([]);
  });

  it("must-not-fire: day and none grouping are never month-checked", async () => {
    // The carve-out's complement. A check applied to every group_by would break
    // the common case.
    const res = await call("yt_channel_overview", { ...WINDOW, group_by: "day" });
    expect(res.isError).toBeFalsy();
    expect(fake.reportCalls).toHaveLength(1);
  });
});

describe("yt_channel_info", () => {
  it("projects the live channels.list payload", async () => {
    fake.channelResponse = {
      items: [
        {
          id: "UCTUYxaxs8bdbf9IhlFv3tTg",
          snippet: {
            title: "The Chain of Thought Podcast",
            customUrl: "@chainofthoughtai",
            publishedAt: "2025-11-26T01:48:58.632952Z",
          },
          statistics: { subscriberCount: "2220", viewCount: "91234", videoCount: "77" },
        },
      ],
    };
    const out = parse(await call("yt_channel_info", {}));
    expect(fake.channelCalls).toBe(1);
    expect(out.channelId).toBe("UCTUYxaxs8bdbf9IhlFv3tTg");
    expect(out.title).toBe("The Chain of Thought Podcast");
    expect(out.handle).toBe("@chainofthoughtai");
    // Strings in the payload, numbers out.
    expect(out.subscribers).toBe(2220);
    expect(out.totalViews).toBe(91234);
    expect(out.videoCount).toBe(77);
  });

  it("reports the gap instead of failing when the Data scope is missing", async () => {
    fake.channelError = new ScopeError("/youtube/v3/channels", "youtube.readonly");
    const res = await call("yt_channel_info", {});
    expect(res.isError).toBeFalsy();
    expect(parse(res).note).toMatch(/youtube\.readonly/);
  });

  it("must-still-fire: a non-scope failure is still reported as an error", async () => {
    // The complement of the carve-out above. Swallowing every error into a
    // friendly note would hide a revoked credential.
    fake.channelError = new Error("boom");
    const res = await call("yt_channel_info", {});
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/boom/);
  });
});

// ── The derived view ──────────────────────────────────────────────────

describe("yt_episode_race", () => {
  const IDS = ["9QQA4TZvEKU", "PJ-3hXAUotI"];

  function withPublishDates() {
    fake.videoResponse = {
      items: [
        { id: "9QQA4TZvEKU", snippet: { title: "New one", publishedAt: "2026-08-01T16:00:23Z" } },
        { id: "PJ-3hXAUotI", snippet: { title: "Older one", publishedAt: "2026-07-01T16:00:00Z" } },
      ],
    };
  }

  const dayRows = (start: string, values: number[]): ReportResponse => ({
    columnHeaders: [{ name: "day" }, { name: "views" }],
    rows: values.map((v, i) => [addDaysLocal(start, i), v]),
  });

  it("queries each video from its own publish date, never a shared window", async () => {
    withPublishDates();
    fake.reportResponses = [
      dayRows("2026-08-01", [10, 5, 2]),
      dayRows("2026-07-01", [100, 50, 20]),
    ];
    await call("yt_episode_race", {
      video_ids: IDS,
      window_days: 7,
      as_of_date: "2026-08-05",
    });

    expect(fake.reportCalls).toHaveLength(2);
    // Video published 08-01, as-of 08-05 => age 4 => end at 08-05 (age < window).
    expect(fake.reportCalls[0]).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-05",
      metrics: ["views"],
      dimensions: ["day"],
      filters: ["video==9QQA4TZvEKU"],
      sort: "day",
    });
    // Video published 07-01, age 35, window 7 => end at 07-07, NOT as-of.
    // Querying to as-of would pull 35 days and pad the curve past the window.
    expect(fake.reportCalls[1].startDate).toBe("2026-07-01");
    expect(fake.reportCalls[1].endDate).toBe("2026-07-07");
  });

  it("truncates each curve at the video's real age instead of padding a flatline", async () => {
    withPublishDates();
    fake.reportResponses = [
      dayRows("2026-08-01", [10, 5, 2, 1, 0]),
      dayRows("2026-07-01", [100, 50, 20, 10, 5, 2, 1]),
    ];
    const out = parse(
      await call("yt_episode_race", {
        video_ids: IDS,
        window_days: 7,
        as_of_date: "2026-08-05",
      }),
    );
    const [newer, older] = out.videos;
    // 4 days old => 5 points (day 0..4), not 7 padded ones.
    expect(newer.ageDays).toBe(4);
    expect(newer.daysTracked).toBe(5);
    expect(newer.cumulative).toEqual([10, 15, 17, 18, 18]);
    // 35 days old but a 7-day window => 7 points.
    expect(older.ageDays).toBe(35);
    expect(older.daysTracked).toBe(7);
    expect(older.cumulative).toEqual([100, 150, 170, 180, 185, 187, 188]);
  });

  it("ranks at the oldest day BOTH videos have reached, not on lifetime totals", async () => {
    withPublishDates();
    fake.reportResponses = [
      // The new episode is ahead at day 4 (18) ...
      dayRows("2026-08-01", [10, 5, 2, 1, 0]),
      // ... while the old one's *total* is far bigger. Ranking on totals would
      // put "Older one" first, which is exactly the comparison this tool exists
      // to refuse.
      dayRows("2026-07-01", [3, 1, 1, 0, 0, 900, 900]),
    ];
    const out = parse(
      await call("yt_episode_race", {
        video_ids: IDS,
        window_days: 7,
        as_of_date: "2026-08-05",
      }),
    );
    expect(out.comparableAtDay).toBe(4);
    expect(out.leaderboard).toEqual([
      { videoId: "9QQA4TZvEKU", title: "New one", value: 18 },
      { videoId: "PJ-3hXAUotI", title: "Older one", value: 5 },
    ]);
    // The totals disagree with the leaderboard, and that is the finding.
    expect(out.videos[1].total).toBe(1805);
  });

  it("clamps window_days to 1-90", async () => {
    withPublishDates();
    const out = parse(
      await call("yt_episode_race", { video_ids: IDS, window_days: 365, as_of_date: "2026-08-05" }),
    );
    expect(out.windowDays).toBe(90);
  });

  it("races on watch time when asked", async () => {
    withPublishDates();
    await call("yt_episode_race", {
      video_ids: IDS,
      metric: "estimatedMinutesWatched",
      as_of_date: "2026-08-05",
    });
    expect(fake.reportCalls[0].metrics).toEqual(["estimatedMinutesWatched"]);
  });

  it("flags a video published after the as-of date rather than charting it", async () => {
    fake.videoResponse = {
      items: [
        { id: "9QQA4TZvEKU", snippet: { title: "Future", publishedAt: "2026-09-01T00:00:00Z" } },
        { id: "PJ-3hXAUotI", snippet: { title: "Older one", publishedAt: "2026-07-01T00:00:00Z" } },
      ],
    };
    fake.reportResponses = [dayRows("2026-07-01", [5, 5])];
    const out = parse(
      await call("yt_episode_race", { video_ids: IDS, window_days: 7, as_of_date: "2026-08-05" }),
    );
    const future = out.videos.find((v: { videoId: string }) => v.videoId === "9QQA4TZvEKU");
    expect(future.note).toMatch(/Published after as_of_date/);
    expect(future.cumulative).toBeUndefined();
    // Only one report went out — the future video was skipped, not queried.
    expect(fake.reportCalls).toHaveLength(1);
  });

  it("flags an ID Google returned no publish date for", async () => {
    fake.videoResponse = {
      items: [
        { id: "PJ-3hXAUotI", snippet: { title: "Older one", publishedAt: "2026-07-01T00:00:00Z" } },
      ],
    };
    fake.reportResponses = [dayRows("2026-07-01", [5])];
    const out = parse(
      await call("yt_episode_race", { video_ids: IDS, window_days: 7, as_of_date: "2026-08-05" }),
    );
    const missing = out.videos.find((v: { videoId: string }) => v.videoId === "9QQA4TZvEKU");
    expect(missing.error).toMatch(/No publish date/);
  });

  it("fails with a scope error rather than a wrong answer when publish dates are unavailable", async () => {
    // Titles are optional elsewhere; here the publish date IS the x-axis, so
    // degrading would mean inventing an alignment.
    const res = await call(
      "yt_episode_race",
      { video_ids: IDS, as_of_date: "2026-08-05" },
      fake,
      false,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/needs publish dates/);
    expect(fake.reportCalls).toEqual([]);
  });

  it("requires at least two videos — one video is not a race", async () => {
    const res = await call("yt_episode_race", {
      video_ids: ["9QQA4TZvEKU"],
      as_of_date: "2026-08-05",
    });
    expect(res.isError).toBe(true);
  });
});

// ── Keyless operation ─────────────────────────────────────────────────

describe("without a credential", () => {
  it("still lists every tool", async () => {
    const mcp = await connect(null);
    const listed = await mcp.listTools();
    expect(listed.tools.length).toBeGreaterThan(0);
  });

  it("answers each call with a setup pointer, not a protocol failure", async () => {
    const res = await call("yt_channel_overview", { ...WINDOW }, null);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/youtube_credentials\.json/);
    expect(text(res)).toMatch(/yt-analytics\.readonly/);
  });
});

// Small helpers kept local to the test file.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function addDaysLocal(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
