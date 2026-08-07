#!/usr/bin/env node

/**
 * yt-analytics-mcp — MCP server for the YouTube Analytics API v2.
 *
 * Curated, read-only, owner-side channel analytics. Every tool reads
 * `channel==MINE`; nothing here can write to YouTube or read another channel's
 * private data.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ANALYTICS_SCOPE,
  DATA_SCOPE,
  DEFAULT_CREDENTIAL_PATH,
  GoogleAuth,
} from "./auth.js";
import { YouTubeClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  // YT_ANALYTICS_CREDENTIALS_PATH points at a non-default credential file.
  const credPath =
    process.env.YT_ANALYTICS_CREDENTIALS_PATH || DEFAULT_CREDENTIAL_PATH;
  const auth = GoogleAuth.tryLoad(credPath);

  // Start keyless. The server must boot and answer tools/list with no credential
  // so MCP inspectors can introspect it; tool *calls* then fail with a setup
  // pointer. Every diagnostic goes to stderr — stdout is the MCP transport and
  // has to stay clean JSON-RPC.
  if (!auth) {
    console.error(
      `Warning: no YouTube OAuth credential at ${credPath}. Tools will error until one exists.`,
    );
    console.error(
      `Mint one with an installed-app OAuth flow for ${ANALYTICS_SCOPE} ` +
        `(add ${DATA_SCOPE} for video titles) — see the README.`,
    );
  } else {
    if (!auth.hasAnalyticsScope()) {
      console.error(
        `Warning: the credential at ${credPath} does not carry ${ANALYTICS_SCOPE}. ` +
          "Analytics tools will fail. Re-mint with that scope.",
      );
    }
    if (!auth.hasDataScope()) {
      console.error(
        `Note: the credential lacks ${DATA_SCOPE}. Analytics tools work; video ` +
          "titles are not resolved and yt_episode_race cannot run (it needs publish dates).",
      );
    }
  }

  const client = auth ? new YouTubeClient(auth) : null;
  const server = createServer(client, auth?.hasDataScope() ?? false);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("YouTube Analytics MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
