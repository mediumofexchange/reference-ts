// Explicit GET-only runtime acceptance for the reference-testnet header rules.
// Pin an independently selected anchor; never infer its network from its id.
// node experiments/ergo-range/testnet-header-check.mjs --anchor 565888
//   --anchor-id d79b5398f9676c836f8ec133746d7d251e6fc8c756d1fe28d477d8f3fb7f9661
//   --to 567127 [--node http://127.0.0.1:9052] [--out docs/ergo-testnet-header-verification.json]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ANCHOR_CONTEXT, parseErgoHeader, ergoHeaderStore } from "../../dist/ergo-headers.js";
import { parseNodeJson, supplyHeader } from "../../dist/ergo-supplier.js";
import { sourceClosure, sourceHashes } from "../../scripts/pool/v3/provenance.mjs";

const root = resolve(import.meta.dirname, "../.."), args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const base = option("--node", "http://127.0.0.1:9052").replace(/\/$/, "");
const anchor = Number(option("--anchor")), to = Number(option("--to")), pin = option("--anchor-id");
assert(Number.isSafeInteger(anchor) && anchor >= ANCHOR_CONTEXT + 1 && Number.isSafeInteger(to) && to > anchor);
assert(/^[0-9a-f]{64}$/.test(pin ?? ""), "independently pin the anchor id");
const sha = bytes => createHash("sha256").update(bytes).digest("hex"), hex = bytes => Buffer.from(bytes).toString("hex");
const cache = join(root, "scratch/testnet-header-probe", sha(base).slice(0, 16));
mkdirSync(cache, { recursive: true });
const files = sourceHashes(sourceClosure(["experiments/ergo-range/testnet-header-check.mjs", "package-lock.json", "tsconfig.json", "tsconfig.build.json"]));
const get = async path => {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(60_000) });
  assert(response.ok, `HTTP ${response.status}: ${path}`); return response.text();
};
const info = JSON.parse(await get("/info"));
assert.equal(info.network, "testnet"); assert.equal(info.appVersion, "6.0.6"); assert(to <= info.fullHeight);
const all = [], inputSha256 = {};
for (let low = anchor - ANCHOR_CONTEXT - 1; low < to; low += 512) {
  const high = Math.min(low + 512, to), name = `${low}-${high}.json`, path = join(cache, name);
  const text = existsSync(path) ? readFileSync(path, "utf8") : await get(`/blocks/chainSlice?fromHeight=${low}&toHeight=${high}`);
  writeFileSync(path, text); inputSha256[name] = sha(text);
  const statements = parseNodeJson(text);
  assert(Array.isArray(statements)); assert.equal(statements.length, high - low);
  for (const [i, statement] of statements.entries()) {
    const supplied = supplyHeader(statement); assert(supplied !== undefined);
    const header = parseErgoHeader(supplied.bytes); assert(header !== undefined);
    assert.equal(header.height, BigInt(low + i + 1)); assert.equal(hex(header.id), statement.get("id")); all.push(header);
  }
}
const store = ergoHeaderStore(Buffer.from(pin, "hex"), all.slice(0, ANCHOR_CONTEXT + 1).map(h => h.bytes), "testnet");
assert(store !== undefined, "context authenticates the independently held anchor");
const started = performance.now(), recalculations = [];
for (const header of all.slice(ANCHOR_CONTEXT + 1)) {
  assert.equal(store.add(header.bytes), "added", `runtime acceptance at ${header.height}`);
  if ((header.height - 1n) % 128n === 0n) recalculations.push(header.height.toString());
}
const best = store.best(); assert.equal(best.height, BigInt(to));
const currentText = await get(`/blocks/chainSlice?fromHeight=${to - 1}&toHeight=${to}`), current = parseNodeJson(currentText);
assert(Array.isArray(current) && current.length === 1);
const supplied = supplyHeader(current[0]); assert(supplied !== undefined);
assert.equal(hex(parseErgoHeader(supplied.bytes).id), hex(best.tipId), "fresh own-node chain agrees with the checked tip");
inputSha256["current-tip.json"] = sha(currentText); writeFileSync(join(cache, "current-tip.json"), currentText);
const report = { status: "passed", node: process.version, network: info.network, appVersion: info.appVersion, source: base,
  window: { anchorHeight: anchor, anchorId: pin, to, tipId: hex(best.tipId), score: best.score.toString(), headers: best.headers.length },
  recalculations, elapsedMs: Math.round(performance.now() - started), inputSha256, files,
  limits: ["Reference testnet only. Anchor and its prehistory are independently selected trust inputs; no adopted configuration or deployment.",
    "One own node supplies bytes. Runtime checks every child header's difficulty, linkage, timestamp and work; no full block validation or independent network consensus claim.",
    "This real window does not reach the terminal signed-Int prediction or activation reset; hostile unit tests cover those source-equivalence cases."] };
const output = JSON.stringify(report, null, 2) + "\n", out = option("--out");
if (out !== undefined) writeFileSync(resolve(root, out), output);
console.log(output);
