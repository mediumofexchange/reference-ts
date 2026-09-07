// Verifies every intra-repository markdown link and heading anchor, so a moved
// document or renamed rule fails here rather than in a reader's browser.
// Each argument is a repository root. Relative links must stay inside their
// own repository even when companion checkouts are present on this machine.
// Usage: node check-links.mjs <repo> [<repo>...]
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, sep } from "node:path";

const anchorOf = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
const files = [];
function walk(d, root) {
  for (const n of readdirSync(d)) {
    if (["node_modules", ".git", "dist", "scratch"].includes(n)) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, root); else if (p.endsWith(".md")) files.push({ file: p, root });
  }
}
for (const d of process.argv.slice(2)) walk(resolve(d), resolve(d));
const headings = new Map();
for (const { file: f } of files) {
  const set = new Map();
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    let a = anchorOf(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, ""));
    let n = 0, base = a;
    while (set.has(a)) a = `${base}-${++n}`;
    set.set(a, true);
  }
  headings.set(f, set);
}
let bad = 0;
for (const { file: f, root } of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, anchor] = target.split("#");
    const file = path ? resolve(dirname(f), path) : f;
    const local = relative(root, file);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      console.log(`${f}: link leaves repository ${target}; use an HTTPS link`);
      bad++;
      continue;
    }
    if (!existsSync(file)) { console.log(`${f}: missing file ${target}`); bad++; continue; }
    if (anchor && file.endsWith(".md")) {
      const set = headings.get(file);
      if (set && !set.has(anchor)) { console.log(`${f}: missing anchor ${target}`); bad++; }
    }
  }
}
console.log(bad ? `${bad} broken link(s)` : `links OK across ${files.length} files`);
process.exit(bad ? 1 : 0);
