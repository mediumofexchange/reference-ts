// Keeps the documents that agents use to resume work small and trustworthy.
//
// AGENTS.md is loaded into every coding-agent session, so its size is a
// per-session tax. CLAUDE.md only imports it.
// WORK.md carries only the current operational handoff.
// DECISIONS.md is an index precisely so that nobody has to read the whole log.
// These boundaries are checked because prose alone did not keep them intact.
//
// If a check here fails, the fix is not to raise the limit. It is to move the
// durable reasoning into decisions/, leave the active rule in AGENTS.md, and
// keep only current state in WORK.md.

import { readFileSync, readdirSync } from "node:fs";

const AGENTS_MD_MAX_LINES = 200;
const WORK_MD_MAX_LINES = 100;

const problems = [];
const fail = (msg) => problems.push(msg);

const lines = (path) => readFileSync(path, "utf8").split("\n");

// Claude Code reads CLAUDE.md and follows this import; other agents read
// AGENTS.md directly. Keep the shim exact so the two never drift.
if (readFileSync("CLAUDE.md", "utf8").trim() !== "@AGENTS.md") {
  fail("CLAUDE.md must contain only @AGENTS.md so every agent shares one source.");
}

// GitHub's heading-anchor rule: lowercase, drop everything but letters,
// digits, spaces and hyphens, then spaces become hyphens.
const anchorOf = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

// 1. AGENTS.md stays a quick reference.
const agentLines = lines("AGENTS.md").length;
if (agentLines > AGENTS_MD_MAX_LINES) {
  fail(
    `AGENTS.md is ${agentLines} lines, over the ${AGENTS_MD_MAX_LINES}-line budget.\n` +
      `      It is read into every session. Move detailed rules to\n` +
      `      docs/PROTOCOL_RULES.md, rationale to decisions/, and leave the\n` +
      `      concise rule. The budget is a ceiling, not a number to raise.`,
  );
}

// 2. WORK.md stays a concise, structured handoff rather than a session log.
const workLines = lines("WORK.md");
if (workLines.length > WORK_MD_MAX_LINES) {
  fail(
    `WORK.md is ${workLines.length} lines, over the ${WORK_MD_MAX_LINES}-line budget.\n` +
      `      Replace stale state and move durable reasoning to decisions/.`,
  );
}

for (const heading of [
  "## Goal",
  "## Status",
  "## Evidence",
  "## Next",
  "## Open questions",
]) {
  if (!workLines.includes(heading)) {
    fail(`WORK.md is missing the required heading: ${heading}`);
  }
}

if (!workLines.some((line) => /^Updated: \d{4}-\d{2}-\d{2}$/.test(line))) {
  fail("WORK.md needs an Updated: YYYY-MM-DD line.");
}

const protocolRuleLines = lines("docs/PROTOCOL_RULES.md");
for (const heading of [
  "## Binding rules",
  "## What the parties must do, that no code here enforces",
  "## Design rules",
]) {
  if (!protocolRuleLines.includes(heading)) {
    fail(`docs/PROTOCOL_RULES.md is missing the required heading: ${heading}`);
  }
}

if (protocolRuleLines.includes("## Workflow")) {
  fail("Workflow rules belong in AGENTS.md, not docs/PROTOCOL_RULES.md.");
}

// 3. DECISIONS.md stays an index — entries live in decisions/.
const indexLines = lines("DECISIONS.md");
const strayEntries = indexLines.filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
if (strayEntries.length) {
  fail(
    `DECISIONS.md holds ${strayEntries.length} entr${strayEntries.length === 1 ? "y" : "ies"} directly.\n` +
      `      Entries belong in decisions/<month>.md; this file is the index.\n` +
      `      First: ${strayEntries[0].slice(0, 70)}`,
  );
}

// 4. Collect every real entry heading, per month file.
const headingsByFile = new Map();
for (const file of readdirSync("decisions").filter((f) => f.endsWith(".md"))) {
  const headings = lines(`decisions/${file}`)
    .filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l))
    .map((l) => l.slice(3).trim());
  headingsByFile.set(`decisions/${file}`, headings);
}

// 5. Every index link points at a heading that exists.
const indexed = new Set();
let indexCount = 0;
for (const line of indexLines) {
  if (!line.startsWith("- `")) continue;
  indexCount++;
  const link = line.match(/\]\((decisions\/[^)#]+)#([a-z0-9-]+)\)/);
  if (!link) {
    fail(`Index line is not a link into decisions/:\n      ${line.slice(0, 80)}`);
    continue;
  }
  const [, file, anchor] = link;
  const headings = headingsByFile.get(file);
  if (!headings) {
    fail(`Index points at ${file}, which does not exist:\n      ${line.slice(0, 80)}`);
    continue;
  }
  const match = headings.find((h) => anchorOf(h) === anchor);
  if (!match) {
    fail(`Index anchor #${anchor} matches no heading in ${file}.`);
    continue;
  }
  indexed.add(`${file}::${match}`);
}

// 6. Every entry is reachable from the index — an unindexed entry is invisible.
for (const [file, headings] of headingsByFile) {
  for (const h of headings) {
    if (!indexed.has(`${file}::${h}`)) {
      fail(
        `Entry is not in the index, so nothing will find it:\n` +
          `      ${file} — ${h.slice(0, 70)}`,
      );
    }
  }
}

const total = [...headingsByFile.values()].reduce((n, h) => n + h.length, 0);

if (problems.length) {
  console.error("Docs check failed:\n");
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(
  `Docs OK — AGENTS.md ${agentLines}/${AGENTS_MD_MAX_LINES} lines, ` +
    `WORK.md ${workLines.length}/${WORK_MD_MAX_LINES} lines, ` +
    `${indexCount} index entries covering ${total} decisions.`,
);
