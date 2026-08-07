import type { GoogleAuth } from "./auth.js";
import { DATA_SCOPE } from "./auth.js";
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
} from "./errors.js";
import type {
  ChannelListResponse,
  ReportResponse,
  VideoListResponse,
} from "./types.js";

const ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_BASE = "https://www.googleapis.com/youtube/v3";
const VERSION = "0.1.0";

/** The API's own cap on a `videos.list` id batch. */
export const DATA_API_BATCH_SIZE = 50;

/**
 * Parameters for a single `reports.query` call.
 *
 * Deliberately mirrors the API's own parameter names rather than inventing
 * friendlier ones, so a failed request can be read straight off the wire and
 * pasted into Google's query explorer.
 */
export interface ReportQuery {
  /** Always "channel==MINE" for this server. See `YouTubeClient.report`. */
  ids?: string;
  startDate: string;
  endDate: string;
  metrics: string[];
  dimensions?: string[];
  /** Filter clauses, e.g. ["video==abc123", "country==US"]. Joined with ";". */
  filters?: string[];
  sort?: string;
  maxResults?: number;
  startIndex?: number;
}

/**
 * Client for the YouTube Analytics API v2 plus the two YouTube Data API v3
 * reads this server needs.
 *
 * Everything here is a GET. There is no write path in this class, and adding
 * one would break the contract the README and every tool annotation advertise.
 */
export class YouTubeClient {
  constructor(private auth: GoogleAuth) {}

  private async request<T>(url: URL): Promise<T> {
    const endpoint = url.pathname;
    const token = await this.auth.getAccessToken();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": `yt-analytics-mcp/${VERSION}`,
        },
      });
    } catch (err) {
      throw new YouTubeAPIError(
        0,
        `Network error reaching Google: ${
          err instanceof Error ? err.message : String(err)
        }`,
        endpoint,
      );
    }

    if (response.ok) {
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    }

    const body = await response.text().catch(() => "");
    const { message, reason } = parseGoogleError(body);

    if (response.status === 401) {
      throw new AuthError(endpoint);
    }
    if (response.status === 429) {
      throw new RateLimitError(endpoint);
    }
    if (response.status === 403) {
      // Three very different problems share this status, and the fix differs for
      // each: a missing scope needs a re-mint, an exhausted quota needs a wait,
      // and a non-owner channel needs a different Google account. `reason` and
      // the message text are the only things that tell them apart.
      if (/quota/i.test(reason) || /quota/i.test(message)) {
        throw new QuotaError(endpoint);
      }
      if (
        /insufficient/i.test(message) ||
        /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body) ||
        /insufficientPermissions/i.test(reason)
      ) {
        throw new ScopeError(endpoint, "yt-analytics.readonly");
      }
      throw new PermissionError(endpoint);
    }
    if (response.status === 400) {
      if (/query is not supported/i.test(message)) {
        throw new UnsupportedQueryError(endpoint, message);
      }
      throw new BadRequestError(endpoint, message || body.slice(0, 300));
    }
    throw new YouTubeAPIError(
      response.status,
      message || body.slice(0, 500),
      endpoint,
    );
  }

  /**
   * Build the exact URL for a `reports.query` call.
   *
   * Split out of `report()` so tests can assert the built query string without
   * a network stub, and so a caller reading a failure can see the request that
   * produced it. Verified live 2026-08-07: `metrics` and `dimensions` are
   * comma-separated, `filters` are joined with `;`, and multiple values for one
   * filter are comma-separated inside a single clause.
   */
  static buildReportUrl(q: ReportQuery): URL {
    const url = new URL(ANALYTICS_BASE);
    const p = url.searchParams;
    // Hardcoded, not caller-supplied. `channel==MINE` is the whole trust story:
    // the server can only ever read the channel the credential owns, so no tool
    // input can redirect it at someone else's data.
    p.set("ids", q.ids ?? "channel==MINE");
    p.set("startDate", q.startDate);
    p.set("endDate", q.endDate);
    p.set("metrics", q.metrics.join(","));
    if (q.dimensions?.length) p.set("dimensions", q.dimensions.join(","));
    if (q.filters?.length) p.set("filters", q.filters.join(";"));
    if (q.sort) p.set("sort", q.sort);
    if (q.maxResults !== undefined) p.set("maxResults", String(q.maxResults));
    if (q.startIndex !== undefined) p.set("startIndex", String(q.startIndex));
    return url;
  }

  /** GET /v2/reports — the one Analytics endpoint this server uses. */
  async report(q: ReportQuery): Promise<ReportResponse> {
    return this.request<ReportResponse>(YouTubeClient.buildReportUrl(q));
  }

  /**
   * GET /youtube/v3/videos?part=snippet — titles and publish dates.
   *
   * Costs 1 YouTube Data API quota unit per call regardless of how many IDs are
   * in the batch, so IDs are chunked at the API's 50-per-call ceiling and the
   * cost is `ceil(ids/50)` units, not `ids` units.
   *
   * Requires the youtube.readonly scope. Checked up front rather than letting
   * Google return a 403, because callers reach this through an *optional*
   * title-resolution flag and a clear scope error beats a failed report.
   */
  async listVideos(ids: string[]): Promise<VideoListResponse> {
    if (!this.auth.hasDataScope()) {
      throw new ScopeError(`${DATA_BASE}/videos`, DATA_SCOPE);
    }
    const items: VideoListResponse["items"] = [];
    for (let i = 0; i < ids.length; i += DATA_API_BATCH_SIZE) {
      const batch = ids.slice(i, i + DATA_API_BATCH_SIZE);
      const url = new URL(`${DATA_BASE}/videos`);
      url.searchParams.set("part", "snippet");
      url.searchParams.set("id", batch.join(","));
      const page = await this.request<VideoListResponse>(url);
      items.push(...(page.items ?? []));
    }
    return { items };
  }

  /**
   * GET /youtube/v3/channels?mine=true — which channel this credential owns.
   * Costs 1 YouTube Data API quota unit.
   */
  async myChannel(): Promise<ChannelListResponse> {
    if (!this.auth.hasDataScope()) {
      throw new ScopeError(`${DATA_BASE}/channels`, DATA_SCOPE);
    }
    const url = new URL(`${DATA_BASE}/channels`);
    url.searchParams.set("part", "snippet,statistics");
    url.searchParams.set("mine", "true");
    return this.request<ChannelListResponse>(url);
  }
}
