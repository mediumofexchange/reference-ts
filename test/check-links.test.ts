import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("repository documentation links", () => {
  let fixture: string;
  let repo: string;
  let sibling: string;

  beforeEach(() => {
    const scratch = resolve("scratch");
    mkdirSync(scratch, { recursive: true });
    fixture = mkdtempSync(join(scratch, "check-links-"));
    repo = join(fixture, "repo");
    // The sibling deliberately shares a prefix with the repository name.
    sibling = join(fixture, "repo-spec");
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(sibling);
    writeFileSync(join(sibling, "spec.md"), "# Specification\n");
  });

  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  const check = (...roots: string[]) => spawnSync(
    process.execPath, [resolve("scripts/check-links.mjs"), ...roots],
    { encoding: "utf8" },
  );

  it.each([false, true])("rejects a sibling checkout even when present (also scanned: %s)", (scanSibling) => {
    writeFileSync(join(repo, "docs", "guide.md"),
      "[spec](../../repo-spec/spec.md#specification)\n");
    const result = check(...(scanSibling ? [repo, sibling] : [repo]));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("link leaves repository");
  });

  it("accepts internal parent links and HTTPS specification links, and checks internal anchors", () => {
    writeFileSync(join(repo, "README.md"), "# Overview\n");
    const guide = join(repo, "docs", "guide.md");
    writeFileSync(guide,
      "[home](../README.md#overview)\n[spec](https://example.com/spec.md#specification)\n");
    expect(check(repo).status).toBe(0);
    writeFileSync(guide, "[home](../README.md#missing)\n");
    const result = check(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing anchor");
  });
});
