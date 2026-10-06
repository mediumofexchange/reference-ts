// Decides whether CI's real-proof jobs (scripts/pool/v3/real-proof.mjs) run on the tree under test.
//
// A run whose real-proof jobs all passed records the tree it tested (`--record`: `git ls-tree -r -z` of the checkout,
// for a pull request GitHub's merge commit) as its `real-proof-tree` artifact. On a push or pull request, the gate
// takes the nearest ancestors of the pushed commit (a pull request's head) that have such a record from a run of this
// repository, and skips the real-proof jobs only when the tree under test differs from one recorded tree solely in
// files no real-proof check reads: re-recorded reports (`docs/*-verification.json`) and documentation outside the
// package (`docs/*.md`, `decisions/**/*.md`, AGENTS.md, CLAUDE.md, DECISIONS.md, WORK.md), each a regular file on
// both sides. README.md and LICENSE ship in the packed install the command drill runs, so they count as sources.
// Anything else (a workflow, a script, a mode change, a symlink, a manual dispatch, an error reaching GitHub)
// runs every real-proof job. The other checks run on every push regardless.
//
// Usage: node scripts/real-proof-gate.mjs            (in CI: writes run=true|false and groups=[...] to GITHUB_OUTPUT)
//        node scripts/real-proof-gate.mjs --record <file>
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS } from "./pool/v3/real-proof.mjs";

export const ARTIFACT = "real-proof-tree";
/** How many recorded ancestors the gate compares, nearest first. */
const CANDIDATES = 10;

/** Paths no real-proof check reads, if they are regular files. */
const UNREAD = [
  /^docs\/[^/]+-verification\.json$/,
  /^docs\/[^/]+\.md$/,
  /^decisions\/(?:[^/]+\/)*[^/]+\.md$/,
  /^(?:AGENTS|CLAUDE|DECISIONS|WORK)\.md$/,
];

/** `git ls-tree -r -z --full-tree` output as a map from path to its mode, type and object. */
export function parseTree(bytes) {
  const entries = new Map();
  for (const record of Buffer.from(bytes).toString("utf8").split("\0")) {
    if (record === "") continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(record);
    if (!match) throw new Error(`unreadable tree entry ${JSON.stringify(record)}`);
    if (entries.has(match[4])) throw new Error(`repeated tree entry ${match[4]}`);
    entries.set(match[4], { mode: match[1], type: match[2], object: match[3] });
  }
  return entries;
}

const unread = (path, ...sides) => UNREAD.some(pattern => pattern.test(path)) &&
  sides.every(entry => entry === undefined || (entry.mode === "100644" && entry.type === "blob"));

/** The paths whose entries differ between two parsed trees, and whether every one of them is unread. */
export function compareTrees(recorded, current) {
  const changed = [];
  for (const path of new Set([...recorded.keys(), ...current.keys()])) {
    const before = recorded.get(path), after = current.get(path);
    if (before?.mode === after?.mode && before?.type === after?.type && before?.object === after?.object) continue;
    changed.push({ path, unread: unread(path, before, after) });
  }
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { changed, skippable: changed.every(entry => entry.unread) };
}

const git = (...args) => execFileSync("git", args, { maxBuffer: 1 << 28 });
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });

/** The decision for this CI run, with the lines explaining it. */
function decide() {
  const event = process.env.GITHUB_EVENT_NAME, repository = process.env.GITHUB_REPOSITORY;
  const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  if (event !== "push" && event !== "pull_request") return { run: true, why: [`event ${event}: every real-proof job runs`] };
  if (!repository || !Number.isSafeInteger(repositoryId)) throw new Error("GITHUB_REPOSITORY or GITHUB_REPOSITORY_ID missing");
  const head = event === "pull_request"
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request.head.sha
    : process.env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) throw new Error(`no head commit (${head})`);
  const ancestors = git("rev-list", "--topo-order", "--max-count=1000", head).toString("utf8").split("\n").filter(Boolean);
  const listed = JSON.parse(gh("api", "-X", "GET", `repos/${repository}/actions/artifacts`, "-f", `name=${ARTIFACT}`, "-f", "per_page=100"));
  // Only records a run of this repository made; a fork's pull request runs its own workflow file.
  const recorded = new Map();
  for (const artifact of [...listed.artifacts].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    const run = artifact.workflow_run;
    if (artifact.name !== ARTIFACT || artifact.expired || run?.repository_id !== repositoryId || run?.head_repository_id !== repositoryId) continue;
    if (!recorded.has(run.head_sha)) recorded.set(run.head_sha, run.id);
  }
  const candidates = ancestors.filter(sha => recorded.has(sha)).slice(0, CANDIDATES);
  if (candidates.length === 0) return { run: true, why: [`no recorded real-proof pass among ${ancestors.length} ancestors of ${head}: every real-proof job runs`] };
  const current = parseTree(git("ls-tree", "-r", "-z", "--full-tree", "HEAD"));
  const why = [];
  for (const sha of candidates) {
    const directory = mkdtempSync(join(tmpdir(), "real-proof-tree-"));
    try {
      gh("run", "download", String(recorded.get(sha)), "-R", repository, "-n", ARTIFACT, "-D", directory);
      const files = readdirSync(directory);
      if (files.length !== 1) throw new Error(`artifact of run ${recorded.get(sha)} holds ${files.length} files`);
      const { changed, skippable } = compareTrees(parseTree(readFileSync(join(directory, files[0]))), current);
      const read = changed.filter(entry => !entry.unread).map(entry => entry.path);
      if (skippable) {
        return { run: false, why: [`run ${recorded.get(sha)} passed every real-proof job at ${sha}; since then ${changed.length} files changed, none read by a real-proof check:`,
          ...changed.map(entry => `  ${entry.path}`)] };
      }
      why.push(`run ${recorded.get(sha)} at ${sha}: ${read.length} changed files are read by real-proof checks (${read.slice(0, 5).join(", ")}${read.length > 5 ? ", ..." : ""})`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  return { run: true, why: [...why, "every real-proof job runs"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--record") {
    writeFileSync(args[1], git("ls-tree", "-r", "-z", "--full-tree", "HEAD"));
  } else if (args.length === 0) {
    let decision;
    try { decision = decide(); } catch (error) {
      // Fail safe: whatever went wrong, the real-proof jobs run.
      decision = { run: true, why: [`gate error, every real-proof job runs: ${error instanceof Error ? error.message : String(error)}`] };
    }
    for (const line of decision.why) console.log(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${decision.run}\ngroups=${JSON.stringify(GROUPS)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Real-proof jobs: ${decision.run ? "run" : "skipped"}\n\n\`\`\`\n${decision.why.join("\n")}\n\`\`\`\n`);
    }
  } else {
    console.error("usage: node scripts/real-proof-gate.mjs [--record <file>]");
    process.exit(2);
  }
}
