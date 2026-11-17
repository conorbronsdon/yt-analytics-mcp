import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANALYTICS_SCOPE, DATA_SCOPE, GoogleAuth } from "../auth.js";
import { AuthError } from "../errors.js";

let dir: string;

function credFile(name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

const FULL = {
  client_id: "cid.apps.googleusercontent.com",
  client_secret: "csecret",
  refresh_token: "rtoken",
  token: "stale-access-token",
  token_uri: "https://oauth2.googleapis.com/token",
  scopes: [ANALYTICS_SCOPE, DATA_SCOPE],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GoogleAuth.tryLoad", () => {
  it("loads a complete credential", () => {
    const auth = GoogleAuth.tryLoad(credFile("ok.json", FULL));
    expect(auth).not.toBeNull();
    expect(auth!.scopes).toEqual([ANALYTICS_SCOPE, DATA_SCOPE]);
  });

  it("returns null rather than throwing for every unusable file", () => {
    expect(GoogleAuth.tryLoad(join(dir, "absent.json"))).toBeNull();
    expect(GoogleAuth.tryLoad(credFile("bad.json", "{not json"))).toBeNull();
    // Each of the three required fields, missing one at a time.
    expect(
      GoogleAuth.tryLoad(credFile("no-rt.json", { ...FULL, refresh_token: undefined })),
    ).toBeNull();
    expect(
      GoogleAuth.tryLoad(credFile("no-cid.json", { ...FULL, client_id: undefined })),
    ).toBeNull();
    expect(
      GoogleAuth.tryLoad(credFile("no-cs.json", { ...FULL, client_secret: undefined })),
    ).toBeNull();
  });
});

describe("scope detection", () => {
  const load = (scopes: string[]) =>
    GoogleAuth.tryLoad(credFile(`s${Math.random()}.json`, { ...FULL, scopes }))!;

  it("accepts the exact analytics scope and the monetary superset", () => {
    expect(load([ANALYTICS_SCOPE]).hasAnalyticsScope()).toBe(true);
    expect(
      load(["https://www.googleapis.com/auth/yt-analytics-monetary.readonly"])
        .hasAnalyticsScope(),
    ).toBe(true);
  });

  it("accepts youtube and youtube.force-ssl as Data API supersets", () => {
    expect(load([DATA_SCOPE]).hasDataScope()).toBe(true);
    expect(load(["https://www.googleapis.com/auth/youtube"]).hasDataScope()).toBe(true);
    expect(
      load(["https://www.googleapis.com/auth/youtube.force-ssl"]).hasDataScope(),
    ).toBe(true);
  });

  it("must-fail leg: the wrong scope family grants nothing", () => {
    // The complement of every carve-out above. Without this, a hasDataScope()
    // that simply returned true would pass all the positive cases.
    // youtube.force-ssl is a Data scope and NOT an analytics scope — that exact
    // credential exists on this machine as youtube_token.json and is the reason
    // the two checks are separate.
    const forceSsl = load(["https://www.googleapis.com/auth/youtube.force-ssl"]);
    expect(forceSsl.hasAnalyticsScope()).toBe(false);

    const analyticsOnly = load([ANALYTICS_SCOPE]);
    expect(analyticsOnly.hasDataScope()).toBe(false);

    const unrelated = load(["https://www.googleapis.com/auth/webmasters"]);
    expect(unrelated.hasAnalyticsScope()).toBe(false);
    expect(unrelated.hasDataScope()).toBe(false);

    const none = load([]);
    expect(none.hasAnalyticsScope()).toBe(false);
    expect(none.hasDataScope()).toBe(false);
  });

  it("does not treat a scope that merely contains the name as a match", () => {
    const lookalike = load(["https://evil.example/www.googleapis.com/auth/youtube.readonly"]);
    expect(lookalike.hasDataScope()).toBe(false);
  });
});

describe("access token minting", () => {
  it("posts the refresh grant and returns the new access token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = GoogleAuth.tryLoad(credFile("t.json", FULL))!;
    expect(await auth.getAccessToken()).toBe("fresh");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    // Exact body, not "contains a client_id".
    expect(String(init.body)).toBe(
      "client_id=cid.apps.googleusercontent.com&client_secret=csecret&refresh_token=rtoken&grant_type=refresh_token",
    );
  });

  it("never reuses the stale access token sitting in the file", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const auth = GoogleAuth.tryLoad(credFile("t2.json", FULL))!;
    // FULL.token is "stale-access-token". A cache that trusted the file would
    // return it and make zero network calls.
    expect(await auth.getAccessToken()).not.toBe("stale-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches until near expiry, then refreshes again", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "a", expires_in: 3600 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const auth = GoogleAuth.tryLoad(credFile("t3.json", FULL))!;

    await auth.getAccessToken();
    await auth.getAccessToken();
    await auth.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Push past the 60s pre-expiry margin.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    await auth.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises an AuthError naming the re-mint when the refresh is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    const auth = GoogleAuth.tryLoad(credFile("t4.json", FULL))!;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    await expect(auth.getAccessToken()).rejects.toThrow(/yt-analytics\.readonly/);
  });

  it("raises an AuthError when the endpoint returns no access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ token_type: "Bearer" }))),
    );
    const auth = GoogleAuth.tryLoad(credFile("t5.json", FULL))!;
    await expect(auth.getAccessToken()).rejects.toThrow(/no access_token/);
  });

  it("wraps a network failure rather than leaking the raw error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const auth = GoogleAuth.tryLoad(credFile("t6.json", FULL))!;
    await expect(auth.getAccessToken()).rejects.toThrow(/Network error refreshing/);
  });
});

describe("token_uri allow-list", () => {
  const CRED = {
    client_id: "example-client-not-real.apps.googleusercontent.com",
    client_secret: "example-secret-not-real",
    refresh_token: "test-refresh-token-not-real",
    scopes: [ANALYTICS_SCOPE],
  };
  const okResponse = () =>
    new Response(JSON.stringify({ access_token: "test-token-not-real", expires_in: 3600 }));

  it("must-fire: refuses a non-Google token_uri and sends nothing", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const auth = GoogleAuth.tryLoad(
      credFile("evil.json", { ...CRED, token_uri: "https://collector.example/token" }),
    )!;
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Credential refused at credential token_uri (no request sent): The credential's " +
        "token_uri points at https://collector.example/token, which is not a Google OAuth token " +
        "endpoint, so the refresh token was not sent. Set token_uri to " +
        "https://oauth2.googleapis.com/token or remove it.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("a refused token_uri is not reported as an HTTP status", async () => {
    const auth = GoogleAuth.tryLoad(
      credFile("nostatus.json", { ...CRED, token_uri: "https://collector.example/token" }),
    )!;
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));
    const err = (await auth.getAccessToken().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.name).toBe("TokenUriRefusedError");
    expect(err.message.includes("(401)")).toBe(false);
  });

  it("must-fire: an allowed endpoint plus a query names the refused parts, not their values", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const auth = GoogleAuth.tryLoad(
      credFile("query.json", {
        ...CRED,
        token_uri: "https://oauth2.googleapis.com/token?next=https://collector.example",
      }),
    )!;
    await expect(auth.getAccessToken()).rejects.toThrow(
      "Credential refused at credential token_uri (no request sent): The credential's " +
        "token_uri adds a query, fragment or userinfo to https://oauth2.googleapis.com/token; " +
        "those are refused, so the refresh token was not sent. Set token_uri to " +
        "https://oauth2.googleapis.com/token or remove it.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("refresh failures name the endpoint actually used, not the default", async () => {
    const fetchMock = vi.fn(async () => new Response("bad grant", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const auth = GoogleAuth.tryLoad(
      credFile("legacy-fail.json", { ...CRED, token_uri: "https://accounts.google.com/o/oauth2/token" }),
    )!;
    const err = await auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).endpoint).toBe("https://accounts.google.com/o/oauth2/token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("must-fire: refuses plain http, a lookalike host, an unparseable value, another path, a query, a port, userinfo and a fragment", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    for (const [i, uri] of [
      "http://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com.collector.example/token",
      "not a url",
      "https://accounts.google.com/signin/redirect",
      "https://oauth2.googleapis.com/token?next=https://collector.example",
      "https://oauth2.googleapis.com:8443/token",
      "https://user@oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com/token#x",
    ].entries()) {
      const auth = GoogleAuth.tryLoad(credFile(`bad${i}.json`, { ...CRED, token_uri: uri }))!;
      await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("must-not-fire: Google endpoints and a missing token_uri still refresh", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const cases: Array<[string | undefined, string]> = [
      ["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token"],
      ["https://accounts.google.com/o/oauth2/token", "https://accounts.google.com/o/oauth2/token"],
      [undefined, "https://oauth2.googleapis.com/token"],
      // WHATWG normalization: case and the default port are the same URL.
      ["HTTPS://OAUTH2.GOOGLEAPIS.COM:443/token", "https://oauth2.googleapis.com/token"],
    ];
    for (const [i, [uri, expected]] of cases.entries()) {
      const auth = GoogleAuth.tryLoad(credFile(`good${i}.json`, { ...CRED, token_uri: uri }))!;
      expect(await auth.getAccessToken()).toBe("test-token-not-real");
      const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit];
      expect(url).toBe(expected);
      expect(String(init.body)).toBe(
        "client_id=example-client-not-real.apps.googleusercontent.com" +
          "&client_secret=example-secret-not-real" +
          "&refresh_token=test-refresh-token-not-real&grant_type=refresh_token",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
