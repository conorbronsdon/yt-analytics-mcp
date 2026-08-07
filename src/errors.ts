/**
 * Error types for the YouTube Analytics MCP server.
 *
 * Every message is written for an agent that has to decide what to do next, so
 * each one names the fix rather than restating the status code. The bodies these
 * are built from were captured live on 2026-08-07 against
 * `youtubeanalytics.googleapis.com/v2/reports`; see `parseGoogleError`.
 */

export class YouTubeAPIError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public endpoint: string,
  ) {
    super(`YouTube API error (${statusCode}) at ${endpoint}: ${message}`);
    this.name = "YouTubeAPIError";
  }
}

export class AuthError extends YouTubeAPIError {
  constructor(endpoint: string, detail?: string) {
    super(
      401,
      detail ||
        "Google rejected the credential. The OAuth token at " +
          "~/.config/gws/youtube_credentials.json may be revoked, expired, or for the " +
          "wrong Google account. Re-mint it with an installed-app OAuth flow requesting " +
          "the yt-analytics.readonly scope — see the README.",
      endpoint,
    );
    this.name = "AuthError";
  }
}

export class ScopeError extends YouTubeAPIError {
  constructor(endpoint: string, scope: string) {
    super(
      403,
      `This tool needs the ${scope} OAuth scope, but the saved credential does not ` +
        "carry it. Re-run the OAuth consent flow requesting that scope and click " +
        "through consent again. Tools that only need the scopes you already have " +
        "keep working.",
      endpoint,
    );
    this.name = "ScopeError";
  }
}

export class QuotaError extends YouTubeAPIError {
  constructor(endpoint: string) {
    super(
      403,
      "Google Cloud project quota exhausted for this API. YouTube Analytics queries " +
        "are cheap, but the YouTube Data API v3 has a 10,000-unit daily default. If " +
        "you are resolving video titles in a loop, pass resolve_titles=false or wait " +
        "for the quota to reset (midnight Pacific).",
      endpoint,
    );
    this.name = "QuotaError";
  }
}

export class PermissionError extends YouTubeAPIError {
  constructor(endpoint: string) {
    super(
      403,
      "The signed-in Google account is not an owner of the channel this query asks " +
        "about. YouTube Analytics only serves owner-side data: you can read your own " +
        "channel's numbers, never someone else's. Check which account minted the " +
        "credential with yt_channel_info.",
      endpoint,
    );
    this.name = "PermissionError";
  }
}

export class RateLimitError extends YouTubeAPIError {
  constructor(endpoint: string) {
    super(
      429,
      "Rate limited by Google. Wait a moment and retry, or narrow the date range / " +
        "lower max_results.",
      endpoint,
    );
    this.name = "RateLimitError";
  }
}

/**
 * HTTP 400 "The query is not supported."
 *
 * The single most common failure against this API and the least informative
 * message Google returns — it is the same string for an over-cap `maxResults`,
 * a missing `sort` on a `video`-dimension report, and an illegal
 * dimension/metric combination. All three were reproduced live on 2026-08-07.
 * The server builds every request itself, so a caller should almost never see
 * this; when they do, the likely causes are worth listing.
 */
export class UnsupportedQueryError extends YouTubeAPIError {
  constructor(endpoint: string, detail: string) {
    super(
      400,
      `${detail} This usually means an unsupported dimension/metric combination, a ` +
        "max_results above the report's cap (200 for top-videos reports, 250 for " +
        "city reports, 25 for detail reports), or a report that requires a sort " +
        "order and did not get one.",
      endpoint,
    );
    this.name = "UnsupportedQueryError";
  }
}

export class BadRequestError extends YouTubeAPIError {
  constructor(endpoint: string, detail: string) {
    super(400, detail, endpoint);
    this.name = "BadRequestError";
  }
}

/** Thrown when the credential file is absent or unreadable. Surfaced per-tool. */
export class CredentialMissingError extends Error {
  constructor(path: string) {
    super(
      `YouTube OAuth credential not found at ${path}. ` +
        "Mint one by running an installed-app OAuth flow for the " +
        "https://www.googleapis.com/auth/yt-analytics.readonly scope (add " +
        "youtube.readonly if you want video titles resolved) — see the README. " +
        "Set YT_ANALYTICS_CREDENTIALS_PATH to use a different location.",
    );
    this.name = "CredentialMissingError";
  }
}

/** The `error` envelope Google returns on a failed request. */
interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { message?: string; reason?: string; domain?: string }[];
  };
}

/**
 * Pull the human-readable message and machine `reason` out of a Google error
 * body. Returns empty strings rather than throwing: the body is not guaranteed
 * to be JSON (an HTML error page from a proxy is possible), and a parse failure
 * must not mask the original HTTP status.
 */
export function parseGoogleError(body: string): { message: string; reason: string } {
  try {
    const parsed = JSON.parse(body) as GoogleErrorBody;
    return {
      message: parsed.error?.message ?? "",
      reason: parsed.error?.errors?.[0]?.reason ?? "",
    };
  } catch {
    return { message: "", reason: "" };
  }
}
