// Keeps the two documents that every session reads from growing back.
//
// CLAUDE.md is loaded into every session, so its size is a per-session tax.
// DECISIONS.md is an index precisely so that nobody has to read the whole log.
// Both drifted once; prose alone did not hold them, so this does.
//
// If a check here fails, the fix is not to raise the limit. It is to move the
// reasoning into decisions/ and leave the rule behind. 500 is the ceiling the
// maintainer set on 2026-08-29, having already moved it once from 420. It is a
// limit rather than a target, and it does not move again without them.

import { readFileSync, readdirSync } from "node:fs";

const CLAUDE_MD_MAX_LINES = 500;

const problems = [];
const fail = (msg) => problems.push(msg);

const lines = (path) => readFileSync(path, "utf8").split("\n");

// GitHub's heading-anchor rule: lowercase, drop everything but letters,
// digits, spaces and hyphens, then spaces become hyphens.
const anchorOf = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

// 1. CLAUDE.md stays a quick reference.
const claudeLines = lines("CLAUDE.md").length;
if (claudeLines > CLAUDE_MD_MAX_LINES) {
  fail(
    `CLAUDE.md is ${claudeLines} lines, over the ${CLAUDE_MD_MAX_LINES}-line budget.\n` +
      `      It is read into every session. Move the reasoning to a decisions/ entry\n` +
      `      and leave the rule. The budget is the maintainer's ceiling, not a\n` +
      `      number to raise.`,
  );
}

// 2. DECISIONS.md stays an index — entries live in decisions/.
const indexLines = lines("DECISIONS.md");
const strayEntries = indexLines.filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
if (strayEntries.length) {
  fail(
    `DECISIONS.md holds ${strayEntries.length} entr${strayEntries.length === 1 ? "y" : "ies"} directly.\n` +
      `      Entries belong in decisions/<month>.md; this file is the index.\n` +
      `      First: ${strayEntries[0].slice(0, 70)}`,
  );
}

// 3. Collect every real entry heading, per month file.
const headingsByFile = new Map();
for (const file of readdirSync("decisions").filter((f) => f.endsWith(".md"))) {
  const headings = lines(`decisions/${file}`)
    .filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l))
    .map((l) => l.slice(3).trim());
  headingsByFile.set(`decisions/${file}`, headings);
}

// 4. Every index link points at a heading that exists.
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

// 5. Every entry is reachable from the index — an unindexed entry is invisible.
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
  `Docs OK — CLAUDE.md ${claudeLines}/${CLAUDE_MD_MAX_LINES} lines, ` +
    `${indexCount} index entries covering ${total} decisions.`,
);
