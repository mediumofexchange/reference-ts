// Report provenance for the conditional v3 experiments. Not runtime.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

/** The companion specification revision the v3 reports implement, the
 * runtime pin: pool-v3 at e7f7f24, adopted with §11.4's configuration, whose §12 frames package items with u64
 * lengths, whose §7.1 decides non-extension by the evidence recurrence and
 * names a checkpoint's segment by its directory's first entry, and
 * whose §14 states replay, retention, streamed input and kept classes, and for
 * Ergo reports venue-ergo.md in the same tree (§2's witnessed clock, §8's
 * one-transaction condition). The six relations are unchanged since d57ddb0. */
export const V3_SPECIFICATION = "e7f7f24";

const root = resolve(import.meta.dirname, "../../..");
const rel = file => relative(root, file).replaceAll("\\", "/");
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
const DATA = /\bnew URL\(\s*["'](\.{1,2}\/[^"']+\.[a-z]+)["']\s*,\s*import\.meta\.url\s*\)/g;

/** Every repository file the entries reach through relative static and
 * literal dynamic imports, sorted. A module run from dist/ is recorded with
 * the src/ TypeScript it was built from; TypeScript sources name their
 * imports by the emitted `.js` path, and a src/ module also reaches the data
 * files it reads beside it by URL. Entries that are not modules (circuits,
 * manifests, lockfiles) are recorded as given. */
export function sourceClosure(entries) {
  const found = new Set(), pending = entries.map(file => resolve(root, file));
  while (pending.length) {
    let file = pending.pop();
    if (!existsSync(file) && extname(file) === ".js") file = file.replace(/\.js$/, ".ts");
    const path = rel(file);
    if (found.has(path)) continue;
    if (!existsSync(file)) throw new Error(`source ${path} is missing`);
    found.add(path);
    if (path.startsWith("dist/")) {
      const source = join(root, "src", path.slice("dist/".length).replace(/\.js$/, ".ts"));
      if (existsSync(source)) pending.push(source);
    }
    if (![".mjs", ".js", ".ts"].includes(extname(file))) continue;
    const text = readFileSync(file, "utf8");
    for (const [, specifier] of text.matchAll(SPECIFIERS)) pending.push(resolve(dirname(file), specifier));
    // A runtime module reads package data beside it by URL (the shipped relations, `programs.json`).
    if (path.startsWith("src/")) for (const [, specifier] of text.matchAll(DATA)) pending.push(resolve(dirname(file), specifier));
  }
  return [...found].sort();
}

/** SHA-256 of each file's UTF-8 text with CRLF normalized to LF. */
export function sourceHashes(files) {
  return Object.fromEntries(files.map(file => [file,
    createHash("sha256").update(readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n")).digest("hex")]));
}
