// Live smoke test: one real call per tool against the real YouTube Analytics
// API, driven through an assembled MCP server over an in-memory transport.
//
// NOT part of `npm test` — the unit suite makes no network calls. Run this by
// hand when you want to confirm the server works against a real credential:
//
//   node scripts/smoke.mjs
//
// Read-only. It never writes to YouTube and never writes the credential file.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CREDENTIAL_PATH, GoogleAuth } from "../dist/auth.js";
import { YouTubeClient } from "../dist/client.js";
import { createServer } from "../dist/server.js";

const credPath = process.env.YT_ANALYTICS_CREDENTIALS_PATH || DEFAULT_CREDENTIAL_PATH;
const auth = GoogleAuth.tryLoad(credPath);
if (!auth) {
  console.error(`No credential at ${credPath}. See the README.`);
  process.exit(1);
}
console.log("scopes:", auth.scopes.join(", "));
console.log("analytics scope:", auth.hasAnalyticsScope(), "| data scope:", auth.hasDataScope());

const server = createServer(new YouTubeClient(auth), auth.hasDataScope());
const [ct, st] = InMemoryTransport.createLinkedPair();
const mcp = new Client({ name: "smoke", version: "1.0.0" });
await Promise.all([server.connect(st), mcp.connect(ct)]);

const listed = (await mcp.listTools()).tools;
console.log(`\ntools/list -> ${listed.length}: ${listed.map((t) => t.name).sort().join(", ")}\n`);

const END = process.env.SMOKE_END || "2026-08-05";
const START = process.env.SMOKE_START || "2026-07-06";
const W = { start_date: START, end_date: END };

const results = [];
async function run(name, args) {
  const res = await mcp.callTool({ name, arguments: args });
  const body = res.content[0].text;
  const ok = !res.isError;
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(body.slice(0, 480).replace(/^/gm, "      "));
  console.log();
  return ok ? JSON.parse(body) : null;
}

await run("yt_channel_info", {});
await run("yt_channel_overview", { ...W });
await run("yt_channel_overview", { ...W, group_by: "day", metrics: ["views"] });
await run("yt_traffic_sources", { ...W });
const top = await run("yt_top_videos", { ...W, max_results: 3 });
await run("yt_geography", { ...W, max_results: 3 });
await run("yt_playlist_performance", { ...W, max_results: 3 });

const ids = (top?.videos ?? []).map((v) => v.videoId).filter(Boolean);
if (ids.length) {
  await run("yt_video_performance", { ...W, video_ids: ids });
  await run("yt_audience_retention", { ...W, video_id: ids[0], sample_every: 20 });
}
if (ids.length >= 2) {
  await run("yt_episode_race", {
    video_ids: ids.slice(0, 3),
    window_days: 7,
    as_of_date: END,
  });
}

// Negative leg: the trap the tool boundary exists to catch.
const bad = await mcp.callTool({
  name: "yt_audience_retention",
  arguments: { ...W, video_id: ids.slice(0, 2).join(",") },
});
const rejected = bad.isError === true;
results.push({ name: "yt_audience_retention (rejects a 2-ID list)", ok: rejected });
console.log(`${rejected ? "PASS" : "FAIL"}  yt_audience_retention rejects a 2-ID list`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) {
  console.log("failed:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
