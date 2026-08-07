import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { GoogleAuth } from "../auth.js";
import { YouTubeClient } from "../client.js";
import {
  AuthError,
  BadRequestError,
  PermissionError,
  QuotaError,
  RateLimitError,
  ScopeError,
  UnsupportedQueryError,
  YouTubeAPIError,
  parseGoogleError,
} from "../errors.js";

/** A GoogleAuth stand-in. Scope answers are the only behaviour that matters. */
function fakeAuth(opts: { data?: boolean } = {}): GoogleAuth {
  return {
    getAccessToken: async () => "tok",
    hasAnalyticsScope: () => true,
    hasDataScope: () => opts.data ?? true,
    scopes: [],
  } as unknown as GoogleAuth;
}

// A Response body can only be read once, so every stub has to mint a fresh
// Response per call. Handing the same object to `mockResolvedValue` makes the
// second call fail with "Body is unusable" — which looks like a client bug and
// is not one.
const ok = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200 });

function googleError(code: number, message: string, reason = "badRequest") {
  return () =>
    new Response(
      JSON.stringify({
        error: { code, message, errors: [{ message, domain: "global", reason }] },
      }),
      { status: code },
    );
}

const raw = (body: string, status: number) => () => new Response(body, { status });

let fetchMock: ReturnType<typeof vi.fn>;

/** Point the stub at a response factory for every subsequent call. */
function respondWith(factory: () => Response) {
  fetchMock.mockImplementation(async () => factory());
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ok({ rows: [] })());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.restoreAllMocks());

const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);

describe("buildReportUrl", () => {
  it("builds the exact query string for a plain summary query", () => {
    const url = YouTubeClient.buildReportUrl({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views", "estimatedMinutesWatched"],
    });
    expect(url.origin + url.pathname).toBe(
      "https://youtubeanalytics.googleapis.com/v2/reports",
    );
    // Decoded, exact, and in order — the same request the live probe sent.
    expect(decodeURIComponent(url.search)).toBe(
      "?ids=channel==MINE&startDate=2026-07-06&endDate=2026-08-05" +
        "&metrics=views,estimatedMinutesWatched",
    );
  });

  it("joins metrics and dimensions with commas and filters with semicolons", () => {
    // The separator rule, verified live 2026-08-07: two filter clauses joined by
    // ';' AND together; multiple values inside one clause use ','.
    const url = YouTubeClient.buildReportUrl({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
      dimensions: ["day"],
      filters: ["video==9QQA4TZvEKU", "country==US"],
      sort: "day",
    });
    expect(url.searchParams.get("filters")).toBe("video==9QQA4TZvEKU;country==US");
    expect(url.searchParams.get("dimensions")).toBe("day");
    expect(url.searchParams.get("sort")).toBe("day");
  });

  it("sets channel==MINE on every report URL", () => {
    const url = YouTubeClient.buildReportUrl({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
    });
    expect(url.searchParams.get("ids")).toBe("channel==MINE");
  });

  it("cannot be overridden: a caller-supplied ids is discarded, not defaulted away", () => {
    // The README's central trust claim rests on this: no tool input can point
    // the server at another channel. Asserting only the no-argument case would
    // pass just as happily against `q.ids ?? "channel==MINE"`, which is a
    // default an argument defeats — not an invariant. So the assertion that
    // carries the claim is this one: hand it a hostile `ids` and it must still
    // come back MINE. The cast is the point — `ReportQuery` has no `ids` field,
    // so this reaches past the type to prove the runtime does not read one.
    const hostile = {
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
      ids: "channel==UC_someone_elses_channel",
    } as unknown as Parameters<typeof YouTubeClient.buildReportUrl>[0];

    const url = YouTubeClient.buildReportUrl(hostile);
    expect(url.searchParams.get("ids")).toBe("channel==MINE");
    expect(url.searchParams.getAll("ids")).toEqual(["channel==MINE"]);
    expect(url.toString()).not.toContain("someone_elses_channel");
  });

  it("omits optional parameters entirely rather than sending empties", () => {
    // A stray `dimensions=` or `sort=` is a 400 from this API, so absence has to
    // mean absence.
    const url = YouTubeClient.buildReportUrl({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
      dimensions: [],
      filters: [],
    });
    expect(url.searchParams.has("dimensions")).toBe(false);
    expect(url.searchParams.has("filters")).toBe(false);
    expect(url.searchParams.has("sort")).toBe(false);
    expect(url.searchParams.has("maxResults")).toBe(false);
    expect(url.searchParams.has("startIndex")).toBe(false);
  });

  it("sends maxResults and startIndex as plain numbers when given", () => {
    const url = YouTubeClient.buildReportUrl({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
      dimensions: ["video"],
      sort: "-views",
      maxResults: 10,
      startIndex: 11,
    });
    expect(url.searchParams.get("maxResults")).toBe("10");
    expect(url.searchParams.get("startIndex")).toBe("11");
  });

  it("sends maxResults=0 rather than dropping it", () => {
    // `if (q.maxResults)` would silently drop a 0. The API rejects 0, and a
    // clear 400 beats an unbounded report the caller did not ask for.
    const url = YouTubeClient.buildReportUrl({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
      maxResults: 0,
    });
    expect(url.searchParams.get("maxResults")).toBe("0");
  });
});

describe("request headers", () => {
  it("sends the bearer token and identifies itself", async () => {
    await new YouTubeClient(fakeAuth()).report({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["User-Agent"]).toBe("yt-analytics-mcp/0.1.0");
    // No method means GET. There is no write path in this client at all.
    expect(init.method).toBeUndefined();
  });
});

describe("error mapping", () => {
  const run = () =>
    new YouTubeClient(fakeAuth()).report({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
    });

  it("401 becomes an AuthError naming the credential path", async () => {
    respondWith(
      googleError(401, "Request had invalid authentication credentials.", "authError"),
    );
    await expect(run()).rejects.toBeInstanceOf(AuthError);
    await expect(run()).rejects.toThrow(/youtube_credentials\.json/);
  });

  it("429 becomes a RateLimitError", async () => {
    respondWith(googleError(429, "Too many requests", "rateLimitExceeded"));
    await expect(run()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("403 splits three ways on reason, not on status alone", async () => {
    // Quota, scope, and permission all arrive as 403 with different fixes.
    // Collapsing them would send the user to re-mint a credential when they
    // actually just need to wait for midnight Pacific.
    respondWith(
      googleError(403, "Quota exceeded for quota metric", "quotaExceeded"),
    );
    await expect(run()).rejects.toBeInstanceOf(QuotaError);

    respondWith(
      googleError(403, "Request had insufficient authentication scopes.", "insufficientPermissions"),
    );
    await expect(run()).rejects.toBeInstanceOf(ScopeError);

    respondWith(googleError(403, "Forbidden", "forbidden"));
    await expect(run()).rejects.toBeInstanceOf(PermissionError);
  });

  it("must-fail leg: a plain 403 is NOT reported as a quota or scope problem", async () => {
    // The complement of the carve-outs above. A mapper that returned QuotaError
    // for every 403 would pass the first assertion in the previous test.
    respondWith(googleError(403, "Forbidden", "forbidden"));
    await expect(run()).rejects.not.toBeInstanceOf(QuotaError);
    await expect(run()).rejects.not.toBeInstanceOf(ScopeError);
  });

  it("400 'query is not supported' gets the diagnostic, other 400s do not", async () => {
    // The live 400 for maxResults=500 and for a missing sort. Both return this
    // exact sentence, so the extra guidance is warranted here...
    respondWith(
      googleError(400, "The query is not supported. Check the documentation at https://example"),
    );
    await expect(run()).rejects.toBeInstanceOf(UnsupportedQueryError);
    await expect(run()).rejects.toThrow(/max_results above the report's cap/);

    // ...and not here, where Google already said exactly what was wrong.
    respondWith(
      googleError(400, "Could not parse content (07-06-2026) of field startDate."),
    );
    await expect(run()).rejects.toBeInstanceOf(BadRequestError);
    await expect(run()).rejects.not.toBeInstanceOf(UnsupportedQueryError);
    await expect(run()).rejects.toThrow(/Could not parse content/);
  });

  it("an unexpected status still surfaces as a YouTubeAPIError with the code", async () => {
    respondWith(raw("upstream exploded", 503));
    await expect(run()).rejects.toBeInstanceOf(YouTubeAPIError);
    await expect(run()).rejects.toThrow(/\(503\)/);
  });

  it("a non-JSON error body does not mask the status", async () => {
    respondWith(raw("<html>502 Bad Gateway</html>", 502));
    await expect(run()).rejects.toThrow(/\(502\)/);
  });

  it("a network throw becomes status 0, not a crash", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("ETIMEDOUT");
    });
    await expect(run()).rejects.toThrow(/Network error reaching Google.*ETIMEDOUT/);
  });
});

describe("parseGoogleError", () => {
  it("pulls message and reason out of the live envelope", () => {
    expect(
      parseGoogleError(
        JSON.stringify({
          error: {
            code: 400,
            message: "Unknown identifier (notAMetric) given in field parameters.metrics.",
            errors: [{ message: "x", domain: "global", reason: "invalid" }],
          },
        }),
      ),
    ).toEqual({
      message: "Unknown identifier (notAMetric) given in field parameters.metrics.",
      reason: "invalid",
    });
  });

  it("returns empty strings for anything unparseable", () => {
    expect(parseGoogleError("<html>")).toEqual({ message: "", reason: "" });
    expect(parseGoogleError("{}")).toEqual({ message: "", reason: "" });
  });
});

describe("Data API reads", () => {
  it("listVideos requests part=snippet with a comma-joined id list", async () => {
    respondWith(ok({ items: [{ id: "a", snippet: { title: "A" } }] }));
    await new YouTubeClient(fakeAuth()).listVideos(["aaa", "bbb"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(urlOf(0))).toBe(
      "https://www.googleapis.com/youtube/v3/videos?part=snippet&id=aaa,bbb",
    );
  });

  it("chunks at 50 IDs per call — 1 quota unit each, not 1 per video", async () => {
    respondWith(ok({ items: [] }));
    const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
    await new YouTubeClient(fakeAuth()).listVideos(ids);
    // 120 IDs => 3 calls => 3 units. One call per video would be 120 units.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(urlOf(0)).searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(new URL(urlOf(1)).searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(new URL(urlOf(2)).searchParams.get("id")!.split(",")).toHaveLength(20);
  });

  it("merges items across chunks", async () => {
    fetchMock
      .mockImplementationOnce(async () => ok({ items: [{ id: "x" }] })())
      .mockImplementationOnce(async () => ok({ items: [{ id: "y" }] })());
    const ids = Array.from({ length: 60 }, (_, i) => `id${i}`);
    const res = await new YouTubeClient(fakeAuth()).listVideos(ids);
    expect(res.items?.map((i) => i.id)).toEqual(["x", "y"]);
  });

  it("myChannel asks for the signed-in channel only", async () => {
    respondWith(ok({ items: [] }));
    await new YouTubeClient(fakeAuth()).myChannel();
    expect(decodeURIComponent(urlOf(0))).toBe(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
    );
  });

  it("refuses both Data API calls without the scope, and spends no quota doing it", async () => {
    const client = new YouTubeClient(fakeAuth({ data: false }));
    await expect(client.listVideos(["a"])).rejects.toBeInstanceOf(ScopeError);
    await expect(client.myChannel()).rejects.toBeInstanceOf(ScopeError);
    // The point of checking up front: no request is made, so no quota is burned
    // learning what the credential already said.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("must-still-fire: with the scope, both calls go out", async () => {
    respondWith(ok({ items: [] }));
    const client = new YouTubeClient(fakeAuth({ data: true }));
    await client.listVideos(["a"]);
    await client.myChannel();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not gate the Analytics report on the Data scope", async () => {
    // Analytics-only credentials must keep working. Gating everything on
    // hasDataScope would make the scope check look correct while breaking the
    // server's main job.
    respondWith(ok({ rows: [] }));
    await new YouTubeClient(fakeAuth({ data: false })).report({
      startDate: "2026-07-06",
      endDate: "2026-08-05",
      metrics: ["views"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
