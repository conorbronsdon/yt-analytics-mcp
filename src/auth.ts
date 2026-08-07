import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthError, CredentialMissingError } from "./errors.js";

/**
 * An OAuth user credential for the YouTube Analytics API, in google-auth's
 * saved-token format — an installed-app token with a long-lived `refresh_token`.
 *
 * The default path is shared on purpose. `~/.config/gws/` is where the sibling
 * servers (gws-mcp-server, gsc-mcp) and the Python metrics scripts already keep
 * their Google credentials, so one OAuth mint serves all of them rather than
 * asking you to consent again per tool. This server only ever *reads* the file;
 * refreshed access tokens are held in memory and never written back.
 */
export const DEFAULT_CREDENTIAL_PATH = join(
  homedir(),
  ".config",
  "gws",
  "youtube_credentials.json",
);

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Read-only access to owner-side YouTube Analytics reports. Required. */
export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

/**
 * Read-only access to the YouTube Data API v3. Optional — only needed to turn
 * video IDs into titles and to read publish dates.
 */
export const DATA_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

/**
 * Scopes that also grant Data API reads. `youtube` and `youtube.force-ssl` are
 * supersets of `youtube.readonly`, so a credential carrying either can resolve
 * titles even though it does not list `youtube.readonly` literally.
 */
const DATA_SCOPE_SUPERSETS = [
  DATA_SCOPE,
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

/**
 * Scopes that grant monetary-metric access and also imply analytics reads.
 * A credential with only `yt-analytics-monetary.readonly` can still run every
 * report this server exposes.
 */
const ANALYTICS_SCOPE_SUPERSETS = [
  ANALYTICS_SCOPE,
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

/** The subset of google-auth's `to_json()` output that this server reads. */
interface StoredCredential {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  token?: string; // last access token; may be expired, so it is never trusted
  scopes?: string[];
  token_uri?: string;
}

/**
 * Holds the OAuth refresh token and mints short-lived access tokens against
 * Google's token endpoint with plain `fetch` — no `googleapis` or
 * `google-auth-library` dependency. Access tokens are cached in memory until
 * shortly before expiry.
 */
export class GoogleAuth {
  private cred: StoredCredential;
  private accessToken: string | null = null;
  private expiresAt = 0; // epoch ms

  private constructor(cred: StoredCredential) {
    this.cred = cred;
  }

  /**
   * Load the credential from disk. Returns null (does not throw) when the file
   * is absent or unusable, so the server can start keyless and report the gap
   * per tool call instead of dying before it can answer `tools/list`.
   */
  static tryLoad(path: string = DEFAULT_CREDENTIAL_PATH): GoogleAuth | null {
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    let parsed: StoredCredential;
    try {
      parsed = JSON.parse(raw) as StoredCredential;
    } catch {
      return null;
    }
    if (!parsed.refresh_token || !parsed.client_id || !parsed.client_secret) {
      return null;
    }
    return new GoogleAuth(parsed);
  }

  /** Scopes recorded in the credential file (best-effort; may be absent). */
  get scopes(): string[] {
    return this.cred.scopes ?? [];
  }

  /** True when the credential can read YouTube Analytics reports. */
  hasAnalyticsScope(): boolean {
    return this.scopes.some((s) => ANALYTICS_SCOPE_SUPERSETS.includes(s));
  }

  /**
   * True when the credential can also read the YouTube Data API — which is what
   * turns video IDs into titles and supplies publish dates.
   *
   * Checked before the call, not after, so a credential that only has the
   * analytics scope degrades to IDs-only with a note instead of failing the
   * whole tool on a 403.
   */
  hasDataScope(): boolean {
    return this.scopes.some((s) => DATA_SCOPE_SUPERSETS.includes(s));
  }

  /** Return a valid access token, refreshing via the token endpoint if needed. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.expiresAt - 60_000) {
      return this.accessToken;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.cred.client_id!,
      client_secret: this.cred.client_secret!,
      refresh_token: this.cred.refresh_token!,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await fetch(this.cred.token_uri || TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      throw new AuthError(
        TOKEN_ENDPOINT,
        `Network error refreshing the access token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new AuthError(
        TOKEN_ENDPOINT,
        "Token refresh failed (HTTP " +
          response.status +
          "). The refresh token may be revoked or expired — re-mint it with an " +
          "installed-app OAuth flow for the yt-analytics.readonly scope. " +
          text.slice(0, 200),
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new AuthError(TOKEN_ENDPOINT, "Token endpoint returned no access_token.");
    }
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

export { CredentialMissingError };
