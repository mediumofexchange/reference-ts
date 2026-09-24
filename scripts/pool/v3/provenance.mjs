// Report provenance for the conditional v3 experiments. Not runtime.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

/** The companion specification revision the v3 reports implement: pool-v3
 * at 786f962, whose §12.1 serves a checkpoint's trail from the prefix of a
 * longer supplied trail. Its six relations are unchanged since d57ddb0. */
export const V3_SPECIFICATION = "786f962";

const root = resolve(import.meta.dirname, "../../..");
const rel = file => relative(root, file).replaceAll("\\", "/");
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** Every repository file the entries reach through relative static and
 * literal dynamic imports, sorted. A module run from dist/ is recorded with
 * the src/ TypeScript it was built from; TypeScript sources name their
 * imports by the emitted `.js` path. Entries that are not modules (circuits,
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
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(SPECIFIERS)) pending.push(resolve(dirname(file), specifier));
  }
  return [...found].sort();
}

/** SHA-256 of each file's UTF-8 text with CRLF normalized to LF. */
export function sourceHashes(files) {
  return Object.fromEntries(files.map(file => [file,
    createHash("sha256").update(readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n")).digest("hex")]));
}
