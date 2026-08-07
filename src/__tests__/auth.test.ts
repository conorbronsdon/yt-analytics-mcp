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
