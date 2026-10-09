import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CI's real-proof jobs (scripts/pool/v3/real-proof.mjs) and the gate that skips them
// (scripts/real-proof-gate.mjs). A lost script or report, or a skip a source change
// could trigger, would silently weaken CI, so both are pinned here.

interface Entry { mode: string; type: string; object: string }
interface Script { group: string; script: string; args: readonly string[]; reports: readonly string[] }
const load = (path: string) => import(pathToFileURL(resolve(path)).href);
const gate: {
  parseTree(bytes: Uint8Array): Map<string, Entry>;
  compareTrees(recorded: Map<string, Entry>, current: Map<string, Entry>): { changed: { path: string; unread: boolean }[]; skippable: boolean };
} = await load("scripts/real-proof-gate.mjs");
const runner: { SCRIPTS: readonly Script[]; GROUPS: readonly string[]; missingReports(directory: string): string[] } =
  await load("scripts/pool/v3/real-proof.mjs");

const blob = (object: string, mode = "100644"): Entry => ({ mode, type: mode === "160000" ? "commit" : "blob", object });
const tree = (entries: Record<string, Entry>) => new Map(Object.entries(entries));
const A = "a".repeat(40), B = "b".repeat(40);
const base = {
  "src/pool/v3/state.ts": blob(A), "scripts/pool/v3/check.mjs": blob(A), "README.md": blob(A), "LICENSE": blob(A),
  "package.json": blob(A), ".github/workflows/ci.yml": blob(A), "WORK.md": blob(A), "AGENTS.md": blob(A),
  "docs/POOL_V3_WALLET.md": blob(A), "docs/pool-v3-history-store-verification.json": blob(A), "decisions/2026-10.md": blob(A),
};
const after = (changes: Record<string, Entry | undefined>) => {
  const next = tree(base);
  for (const [path, entry] of Object.entries(changes)) {
    if (entry === undefined) next.delete(path); else next.set(path, entry);
  }
  return gate.compareTrees(tree(base), next);
};

describe("real-proof gate", () => {
  it("parses this checkout's tree", () => {
    const parsed = gate.parseTree(execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]));
    expect(parsed.get("package.json")).toMatchObject({ mode: "100644", type: "blob" });
    expect(parsed.size).toBeGreaterThan(100);
  });

  it("refuses an unreadable or repeated tree entry", () => {
    expect(() => gate.parseTree(Buffer.from("100644 blob nothex\tpath\0"))).toThrow(/unreadable tree entry/);
    expect(() => gate.parseTree(Buffer.from([`100644 blob ${A}\tx`, `100644 blob ${B}\tx`, ""].join("\0")))).toThrow(/repeated tree entry x/);
  });

  it("skips an unchanged tree and one changed only in re-recorded reports and unread documentation", () => {
    expect(after({})).toEqual({ changed: [], skippable: true });
    const result = after({
      "docs/pool-v3-history-store-verification.json": blob(B), "WORK.md": blob(B), "AGENTS.md": blob(B), "decisions/2026-10.md": blob(B),
      "docs/POOL_V3_WALLET.md": undefined, "decisions/archive/review.md": blob(B), "DECISIONS.md": blob(B), "CLAUDE.md": blob(B),
    });
    expect(result.skippable).toBe(true);
    expect(result.changed.map(entry => entry.path)).toEqual(["AGENTS.md", "CLAUDE.md", "DECISIONS.md", "WORK.md", "decisions/2026-10.md",
      "decisions/archive/review.md", "docs/POOL_V3_WALLET.md", "docs/pool-v3-history-store-verification.json"]);
  });

  it.each([
    ["source", { "src/pool/v3/state.ts": blob(B) }],
    ["script", { "scripts/pool/v3/check.mjs": blob(B) }],
    ["workflow", { ".github/workflows/ci.yml": blob(B) }],
    ["packed README", { "README.md": blob(B) }],
    ["packed LICENSE", { "LICENSE": blob(B) }],
    ["package manifest", { "package.json": blob(B) }],
    ["new top-level file", { ".gitattributes": blob(B) }],
    ["JSON in docs that is not a report", { "docs/settings.json": blob(B) }],
    ["Markdown under a docs subdirectory", { "docs/sub/notes.md": blob(B) }],
    ["Markdown elsewhere", { "src/notes.md": blob(B) }],
    ["executable documentation", { "WORK.md": blob(A, "100755") }],
    ["symlinked documentation", { "docs/LINK.md": blob(B, "120000") }],
    ["submodule at a documentation path", { "decisions/x.md": blob(B, "160000") }],
    ["source moved to documentation", { "src/pool/v3/state.ts": undefined, "docs/state.md": blob(A) }],
    ["deleted source", { "src/pool/v3/state.ts": undefined }],
    ["report beside a source change", { "docs/pool-v3-history-store-verification.json": blob(B), "src/pool/v3/state.ts": blob(B) }],
  ])("runs on a %s change", (_, changes) => {
    const result = after(changes);
    expect(result.changed.length).toBeGreaterThan(0);
    expect(result.skippable).toBe(false);
  });
});

describe("real-proof groups", () => {
  // The serial check:pool:v3 before CI split it into groups; nothing may drop out (the proof-free offline transfer check
  // moved to check:scripts).
  const serial = [
    "check.mjs", "store-check.mjs --ergo", "history-store-check.mjs",
    "recovery-store-check.mjs", "recovery-store-check.mjs --ergo", "succession-store-check.mjs", "succession-store-check.mjs --ergo",
    "scope-store-check.mjs", "scope-store-check.mjs --ergo", "redemption-store-check.mjs", "redemption-store-check.mjs --ergo",
    "command-drill.mjs", "local-check.mjs",
  ].map(label => `scripts/pool/v3/${label}`);

  it("runs every script of the serial check once, each in one group", () => {
    expect(runner.SCRIPTS.map(entry => [entry.script, ...entry.args].join(" "))).toEqual(serial);
    expect(runner.GROUPS).toEqual(["history", "stores", "redemption", "drill", "replay"]);
    for (const group of runner.GROUPS) expect(runner.SCRIPTS.some(entry => entry.group === group)).toBe(true);
  });

  it("collects the twelve reports CI retained, and the gate counts each re-recorded one as unread", () => {
    const reports = runner.SCRIPTS.flatMap(entry => entry.reports);
    expect(new Set(reports).size).toBe(12);
    for (const report of reports.filter(path => path.startsWith("docs/"))) {
      expect(gate.compareTrees(tree({ [report]: blob(A) }), tree({ [report]: blob(B) })).skippable).toBe(true);
    }
  });

  describe("--expect", () => {
    let directory: string;
    beforeEach(() => {
      mkdirSync(resolve("scratch"), { recursive: true });
      directory = mkdtempSync(join(resolve("scratch"), "real-proof-expect-"));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));
    const expectReports = (...directories: string[]) => spawnSync(process.execPath,
      [resolve("scripts/pool/v3/real-proof.mjs"), "--expect", ...directories], { encoding: "utf8" });

    it("names each report missing from a merged artifact", () => {
      const reports = runner.SCRIPTS.flatMap(entry => entry.reports);
      for (const report of reports.slice(1)) {
        mkdirSync(dirname(join(directory, report)), { recursive: true });
        writeFileSync(join(directory, report), "{}\n");
      }
      expect(runner.missingReports(directory)).toEqual([reports[0]]);
      const refused = expectReports(directory);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(`${directory}: ${reports[0]}`);
      writeFileSync(join(directory, reports[0]!), "{}\n");
      expect(expectReports(directory).status).toBe(0);
    });
  });

  it("refuses an unknown group or option before running anything", () => {
    const refused = spawnSync(process.execPath, [resolve("scripts/pool/v3/real-proof.mjs"), "--group", "nope"], { encoding: "utf8" });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("unknown group nope");
    const repeated = spawnSync(process.execPath, [resolve("scripts/pool/v3/real-proof.mjs"), "--group", "drill", "--group", "replay"], { encoding: "utf8" });
    expect(repeated.status).not.toBe(0);
    expect(repeated.stderr).toContain("repeated or incomplete option --group");
  });
});
