import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "../auth.js";
import { CredentialMissingError } from "../errors.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-credmsg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CredentialMissingError message", () => {
  it("must-fire: a file that exists but cannot be loaded is called unusable, not missing", () => {
    // gcloud-style file without a refresh token: tryLoad rejects it.
    const p = join(dir, "partial.json");
    writeFileSync(p, JSON.stringify({ type: "authorized_user", client_id: "example-client" }));
    expect(GoogleAuth.tryLoad(p)).toBeNull();
    expect(new CredentialMissingError(p).message).toBe(
      `YouTube OAuth credential at ${p} is not usable. It must be a JSON file with ` +
        "client_id, client_secret and refresh_token, such as google-auth's " +
        "Credentials.to_json() output. Mint one by running an installed-app OAuth flow " +
        "for the https://www.googleapis.com/auth/yt-analytics.readonly scope (add " +
        "youtube.readonly if you want video titles resolved) — see the README. " +
        "Set YT_ANALYTICS_CREDENTIALS_PATH to use a different location.",
    );
  });

  it("must-not-fire: an absent file is still reported as not found", () => {
    const p = join(dir, "absent.json");
    expect(new CredentialMissingError(p).message).toMatch(
      new RegExp(`^YouTube OAuth credential not found at ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Mint one`),
    );
    expect(new CredentialMissingError(p).message).not.toContain("not usable");
  });
});
