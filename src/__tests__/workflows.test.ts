/**
 * Supply-chain guard for .github/: every third-party action is pinned to a full
 * commit SHA (the tag lives in a trailing comment, kept current by Dependabot),
 * every workflow declares top-level `permissions:`, and Dependabot watches
 * `github-actions`. A tag like `@v6` can be moved to new code without a diff here.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_DIR = fileURLToPath(new URL("../../.github/", import.meta.url));

function unpinnedUses(yaml: string): string[] {
  const bad: string[] = [];
  for (const line of yaml.replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/);
    if (!m) continue;
    const ref = m[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(ref);
  }
  return bad;
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(path));
    else if (/\.ya?ml$/.test(entry.name)) out.push(path);
  }
  return out.sort();
}

const workflows = yamlFiles(join(GITHUB_DIR, "workflows"));
const actionFiles = [...workflows, ...yamlFiles(join(GITHUB_DIR, "actions"))];

describe("unpinnedUses", () => {
  it("flags a tag, a short SHA and a branch ref", () => {
    const yaml = [
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@4993",
      "        uses: 'owner/action@main'",
    ].join("\n");
    expect(unpinnedUses(yaml)).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@4993",
      "owner/action@main",
    ]);
  });

  it("accepts a full SHA pin, a local action and a docker image", () => {
    const yaml = [
      `      - uses: actions/checkout@${"a".repeat(40)} # v4.4.0`,
      "      - uses: ./.github/actions/local",
      "      - uses: docker://alpine:3.20",
    ].join("\n");
    expect(unpinnedUses(yaml)).toEqual([]);
  });
});

describe(".github workflows", () => {
  it("finds the workflow files", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it.each(actionFiles)("pins every action to a full commit SHA: %s", (file) => {
    expect(unpinnedUses(readFileSync(file, "utf8"))).toEqual([]);
  });

  it.each(workflows)("declares top-level permissions: %s", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/^permissions:/m);
  });

  it("has Dependabot watching github-actions", () => {
    const dependabot = readFileSync(join(GITHUB_DIR, "dependabot.yml"), "utf8");
    expect(dependabot).toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
  });
});
