/**
 * End-to-end annotation checks against an assembled server.
 *
 * Every assertion here reads a real `tools/list` payload over a real MCP
 * transport, not the output of `buildAnnotations`. A unit test over the builder
 * proves the builder works; it says nothing about whether a tool was registered
 * with the object the builder produced, and a hand-written annotation literal
 * that drifts is exactly how the sibling gws-mcp-server shipped a draft-creating
 * tool advertising itself as destructive.
 *
 * The lists below are pinned by value. A test that counted tools, or checked
 * that each annotation "is an object", would pass with every hint inverted.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "../server.js";

type ListedTool = {
  name: string;
  description?: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/** The complete, intended tool surface of v0.1. */
const EXPECTED_TOOLS = [
  "yt_audience_retention",
  "yt_channel_info",
  "yt_channel_overview",
  "yt_episode_race",
  "yt_geography",
  "yt_playlist_performance",
  "yt_top_videos",
  "yt_traffic_sources",
  "yt_video_performance",
] as const;

/**
 * The exact annotation object every tool must advertise.
 *
 * Uniform because every tool is a read — and stated in full rather than
 * defaulted because MCP's `destructiveHint` defaults to *true*. An omitted hint
 * on any tool here would tell a client to render a delete-grade consent prompt
 * for reading a view count.
 */
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

let tools: ListedTool[];

async function connect(): Promise<Client> {
  const server = createServer(null, false);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annotations-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeAll(async () => {
  const client = await connect();
  tools = (await client.listTools()).tools as ListedTool[];
});

const byName = (n: string): ListedTool => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`tool not registered: ${n}`);
  return t;
};

describe("advertised tool surface", () => {
  it("lists exactly the nine v0.1 tools, by name", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS]);
  });

  it("registers every tool with a non-empty description", () => {
    const undescribed = tools.filter((t) => !t.description?.trim()).map((t) => t.name);
    expect(undescribed).toEqual([]);
  });

  it("advertises the name and version a client sees", async () => {
    // Compared against package.json rather than against SERVER_VERSION, which
    // would only prove the constant equals itself.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    const advertised = (await connect()).getServerVersion();
    expect(advertised?.name).toBe(SERVER_NAME);
    expect(advertised?.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

describe("advertised annotations", () => {
  it("gives every tool all four hints, with no omissions", () => {
    const missing = tools
      .filter(
        (t) =>
          typeof t.annotations?.readOnlyHint !== "boolean" ||
          typeof t.annotations?.destructiveHint !== "boolean" ||
          typeof t.annotations?.idempotentHint !== "boolean" ||
          typeof t.annotations?.openWorldHint !== "boolean",
      )
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("pins the exact hint values on each tool individually", () => {
    // Named one by one rather than looped over `tools`, so adding a write tool
    // without updating this file fails the suite instead of silently widening
    // the contract.
    for (const name of EXPECTED_TOOLS) {
      const { title, ...hints } = byName(name).annotations ?? {};
      expect(hints, `annotations for ${name}`).toEqual(READ_ONLY_HINTS);
      expect(typeof title, `title for ${name}`).toBe("string");
    }
  });

  it("advertises no write tool at all — the whole contract in one assertion", () => {
    const writes = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual([]);
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(destructive).toEqual([]);
  });

  it("must-fail control: the assertion above can actually go red", () => {
    // A green check that cannot fail is not evidence. This runs the same
    // predicate over a tool list with one write in it and confirms it catches
    // it — so "writes === []" above means the server has no writes, not that the
    // filter never matches anything.
    const withAWrite: ListedTool[] = [
      ...tools,
      { name: "yt_delete_everything", annotations: { readOnlyHint: false, destructiveHint: true } },
    ];
    const writes = withAWrite.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual(["yt_delete_everything"]);
  });

  it("gives every tool a human-readable title distinct from its name", () => {
    for (const t of tools) {
      expect(t.annotations?.title, t.name).toBeTruthy();
      expect(t.annotations?.title).not.toBe(t.name);
    }
  });
});

describe("descriptions carry the claims the README makes", () => {
  it("every tool that can touch the Data API states its quota cost", () => {
    // The three tools that can spend YouTube Data API units. If a tool joins
    // this list it has to say so in its own description, because that is the
    // only place an agent reads before calling it.
    const dataApiTools = ["yt_channel_info", "yt_top_videos", "yt_video_performance", "yt_episode_race"];
    for (const name of dataApiTools) {
      expect(byName(name).description, name).toMatch(/quota unit/i);
    }
  });

  it("must-fail control: the quota-cost check is not vacuous", () => {
    // A pure-Analytics tool must NOT claim a Data API cost. Without this leg the
    // test above would pass if every description happened to contain the phrase.
    expect(byName("yt_channel_overview").description).not.toMatch(/quota unit/i);
    expect(byName("yt_geography").description).not.toMatch(/quota unit/i);
    expect(byName("yt_traffic_sources").description).not.toMatch(/quota unit/i);
    expect(byName("yt_audience_retention").description).not.toMatch(/quota unit/i);
    expect(byName("yt_playlist_performance").description).not.toMatch(/quota unit/i);
  });

  it("the retention tool warns about the single-ID trap in its own description", () => {
    // The trap is invisible from the API (HTTP 200, wrong data), so the warning
    // has to travel with the tool, not only live in the README.
    expect(byName("yt_audience_retention").description).toMatch(
      /accepts a list but silently reports only the first/,
    );
  });
});
