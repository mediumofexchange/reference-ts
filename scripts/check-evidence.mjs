// Lists retained evidence reports whose recorded source hashes no longer match
// the working tree.
//
// A report in docs/*.json is evidence only for the exact sources it binds. Code
// keeps moving after a report is retained, so a document that cites the report
// as current evidence can silently describe older code. This check makes that
// drift visible; it does not fail, because an older report can remain correct
// history. Re-record a report, or cite it with its revision, when its drift
// touches what the citing document claims.
//
// Usage: node scripts/check-evidence.mjs [--all] [docs/report.json ...]

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const all = args.includes("--all");
const named = args.filter((arg) => arg !== "--all");
const reports = named.length > 0 ? named : readdirSync("docs").filter((name) => name.endsWith(".json")).map((name) => `docs/${name}`);

// Reports name sources relative to the repository root or, for older Ergo
// reports, to the experiment directory. A bound repository path (under one of
// the source roots below) that no longer exists was moved or deleted, so its
// report no longer describes the tree. Other names are relative to a directory
// the report does not state (a bare file name, `vendor/…` beside circuits)
// and are skipped.
const sourceRoots = ["src/", "test/", "model/", "scripts/", "experiments/", "dist/"];
const bases = ["", "experiments/ergo-range/"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const lf = (bytes) => Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

function bindings(value, found = []) {
  if (value === null || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    const digest = typeof entry === "string" ? entry : entry?.sha256;
    if (/^[0-9a-f]{64}$/.test(digest ?? "") && /\.[a-z]{1,5}$/.test(key)) found.push([key, digest]);
    else bindings(entry, found);
  }
  return found;
}

let drifted = 0;
for (const report of reports) {
  const pairs = bindings(JSON.parse(readFileSync(report, "utf8")));
  const changed = [];
  let matched = 0;
  for (const [key, digest] of pairs) {
    // A bare name such as package.json can exist under several bases; it
    // matches if any candidate still has the recorded bytes.
    const files = bases.map((base) => join(base, key)).filter((path) => existsSync(path) && statSync(path).isFile());
    if (files.length === 0) {
      if (sourceRoots.some((prefix) => key.startsWith(prefix))) changed.push(`${key} (missing)`);
      continue;
    }
    const same = (path) => { const bytes = readFileSync(path); return sha256(bytes) === digest || sha256(lf(bytes)) === digest; };
    if (files.some(same)) matched += 1;
    else changed.push(files[0].replace(/\\/g, "/"));
  }
  if (changed.length === 0) {
    if (all && matched > 0) console.log(`current  ${report}: ${matched} bound sources match`);
    continue;
  }
  drifted += 1;
  console.log(`drifted  ${report}: ${changed.length} of ${matched + changed.length} bound sources changed`);
  for (const file of changed) console.log(`         ${file}`);
}
console.log(`${drifted} of ${reports.length} reports bind sources that have since changed.`);
