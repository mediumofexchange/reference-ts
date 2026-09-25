// The runtime venue (src/ergo.ts) on the real mainnet: a view anchored a few hundred blocks below the tip syncs
// from untrusted node suppliers, verifying every header's work from the anchor's context and every section by its
// header's root, and answers pool-v3 §13 ranges by exhaustion. GET-only, nothing cached or submitted.
//
// Checks:
// - the view reaches the index its best chain makes final at the default depth, standing on the block the own node
//   has at that height;
// - a second view synced only from a public node reaches the same block and answers every probe with the same bytes;
// - a supplier that substitutes one block's section, alone, stops the clock before that block; with the own node
//   beside it the clock passes it;
// - a supplier that serves a header with a changed difficulty is stopped there while the others continue.
// The locations are pay-to-public-key trees of throwaway keys, so every answer is empty: absence proven by reading
// every output of every transaction from the anchor's child to the clock.
// Usage, from the repository root on Node 24 with the own mainnet node running:
//   node experiments/ergo-range/runtime-sync.mjs [--blocks 300] [--own http://127.0.0.1:9053]
//     [--public http://213.239.193.208:9053] [--out docs/ergo-runtime-venue-verification.json]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const blocks = BigInt(option("--blocks", "300")), ownUrl = option("--own", "http://127.0.0.1:9053");
const publicUrl = option("--public", "http://213.239.193.208:9053"), out = option("--out");
assert(blocks > 20n && blocks < 5000n, "--blocks between 21 and 4999");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
// The sources are hashed now, before any work, so the report names the files that produced it.
const files = Object.fromEntries(["experiments/ergo-range/runtime-sync.mjs", "experiments/ergo-range/package.json",
  "experiments/ergo-range/package-lock.json", "tsconfig.json"].map(file => [file, fileHash(file)]));
const round = (value, digits = 1) => Number(value.toFixed(digits));

mkdirSync(join(root, "scratch"), { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "ergo-runtime-sync-")));
const url = pathToFileURL(build + sep).href;
let report;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert(!config.error, "TypeScript configuration unreadable");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([join(root, "src/ergo.ts")], {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "the runtime compiles");
  assert.equal(program.emit().emitSkipped, false);
  // Every repository source the compilation reads is bound.
  for (const source of program.getSourceFiles()) {
    const path = resolve(source.fileName);
    if (path.startsWith(root + sep) && !path.includes(`${sep}node_modules${sep}`)) files[path.slice(root.length + 1).replace(/\\/g, "/")] = fileHash(path.slice(root.length + 1));
  }
  const { ErgoVenue, ergoAnchorContext, ergoProfile, DEFAULT_ERGO_DEPTH } = await import(new URL("src/ergo.js", url));
  const { ergoNodeSupplier } = await import(new URL("src/ergo-supplier.js", url));
  const { ergoProfileIdentity } = await import(new URL("src/ergo-profile.js", url));
  const { decodeRangeAnswer } = await import(new URL("src/record-range.js", url));
  const { blake2b } = await import("@noble/hashes/blake2b.js");

  const own = ergoNodeSupplier(ownUrl, { name: "own node" }), other = ergoNodeSupplier(publicUrl, { name: "public node" });
  const info = async base => {
    const { name, appVersion, headersHeight, fullHeight } = await (await fetch(`${base}/info`, { signal: AbortSignal.timeout(30000) })).json();
    return { url: base, name, appVersion, headersHeight, fullHeight };
  };
  const nodes = [await info(ownUrl), await info(publicUrl)];
  // The anchor: the own node's block `blocks` below its tip. Its id names the chain; the context authenticates by linkage.
  const tip = await own.tipHeight(), anchorHeight = tip - blocks;
  const [anchorBytes] = await own.headers(anchorHeight, anchorHeight);
  const anchorId = blake2b(anchorBytes, { dkLen: 32 });
  const context = await ergoAnchorContext(own, anchorId, anchorHeight);
  const key = n => Uint8Array.from([0x00, 0x08, 0xcd, ...secp256k1.getPublicKey(new Uint8Array(32).fill(n), true)]);
  const profile = ergoProfile(anchorId, { 1: key(1), 2: key(2), 3: key(3), 4: key(4) });
  assert.equal(profile.depth, DEFAULT_ERGO_DEPTH);
  const identity = ergoProfileIdentity(profile);
  const wide = { maxBytes: 1n << 30n, maxEntries: 1n << 20n };
  const subjects = [new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22)];
  const answers = (view, toIndex) => subjects.flatMap(subject => [1, 2, 3, 4].map(kind => {
    const request = { venue: identity, kind, subject, fromIndex: 0n, toIndex };
    const bytes = view.range(request, wide);
    return { kind, subject: hex(subject), entries: bytes === undefined ? null : decodeRangeAnswer(bytes, request, wide).entries.length,
      sha256: bytes === undefined ? null : hex(sha256(bytes)) };
  }));
  /** Syncs until the clock reaches what the best chain makes final and no supplier stopped early; at most 20 rounds. */
  async function syncUntilFinal(view, suppliers) {
    const rounds = [];
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const started = performance.now(), result = await view.sync(suppliers);
      rounds.push({ ms: round(performance.now() - started), witnessedIndex: result.witnessedIndex?.toString() ?? null,
        chainWitnessedIndex: result.chainWitnessedIndex?.toString() ?? null, tipHeight: result.tipHeight.toString(), sectionsRead: result.sectionsRead,
        unresolvedIndex: result.unresolvedIndex?.toString() ?? null, suppliers: result.suppliers.map(s => ({ ...s })) });
      if (result.witnessedIndex !== undefined && result.witnessedIndex === result.chainWitnessedIndex &&
        result.suppliers.every(s => s.stopped === undefined)) return { rounds, ms: round(performance.now() - t0), final: result };
    }
    return { rounds, ms: round(performance.now() - t0), final: undefined };
  }

  // View A: the own node first, the public node beside it.
  const a = new ErgoVenue(profile, context);
  const syncA = await syncUntilFinal(a, [own, other]);
  assert(syncA.final !== undefined, "view A reaches its final clock");
  const clockHeight = anchorHeight + 1n + syncA.final.witnessedIndex;
  const [ownAtClock] = await own.headers(clockHeight, clockHeight);
  const standsOnOwn = hex(blake2b(ownAtClock, { dkLen: 32 })) === hex(syncA.final.witnessedHeaderId);

  // View B: the public node alone.
  const b = new ErgoVenue(profile, context);
  const syncB = await syncUntilFinal(b, [other]);
  const common = syncB.final === undefined ? undefined
    : (syncA.final.witnessedIndex < syncB.final.witnessedIndex ? syncA.final.witnessedIndex : syncB.final.witnessedIndex);
  const answersA = common === undefined ? [] : answers(a, common), answersB = common === undefined ? [] : answers(b, common);
  const agree = common !== undefined && JSON.stringify(answersA) === JSON.stringify(answersB);

  // Hostile suppliers over the own node: one substitutes a section, one changes a header's difficulty.
  const target = anchorHeight + 1n + 5n;
  const [targetBytes] = await own.headers(target, target), targetId = hex(blake2b(targetBytes, { dkLen: 32 }));
  const [otherBytes] = await own.headers(target + 1n, target + 1n), otherId = blake2b(otherBytes, { dkLen: 32 });
  const substituting = { name: "substituting", tipHeight: () => own.tipHeight(), headers: (f, t) => own.headers(f, t),
    section: async id => own.section(hex(id) === targetId ? otherId : id) };
  const c = new ErgoVenue(profile, context);
  const alone = await c.sync([substituting]);
  const withOwn = await syncUntilFinal(c, [substituting, own]);
  const forging = { name: "forging", tipHeight: () => own.tipHeight(), section: id => own.section(id),
    headers: async (f, t) => (await own.headers(f, t)).map((bytes, i) => {
      if (f + BigInt(i) !== target) return bytes;
      // nBits' first mantissa byte is 51 bytes from the end: nonce 8, key 33, new-fields length 1, votes 3, height 3.
      const copy = new Uint8Array(bytes), at = copy.length - 41 - 1 - 3 - 3 - 3;
      copy[at] ^= 0x01;
      return copy;
    }) };
  const d = new ErgoVenue(profile, context);
  const forged = await d.sync([forging, own]);

  const hostile = {
    substitutedIndex: "5",
    aloneWitnessedIndex: alone.witnessedIndex?.toString() ?? null, aloneUnresolvedIndex: alone.unresolvedIndex?.toString() ?? null,
    withOwnWitnessedIndex: withOwn.final?.witnessedIndex.toString() ?? null,
    forgedHeaderHeight: target.toString(), forgingReport: forged.suppliers.map(s => ({ ...s })), forgedWitnessedIndex: forged.witnessedIndex?.toString() ?? null,
  };
  const headersVerified = syncA.rounds.reduce((n, r) => n + r.suppliers.reduce((m, s) => m + s.headersAdded, 0), 0);
  const sectionsRead = syncA.rounds.reduce((n, r) => n + r.sectionsRead, 0);
  const passed = standsOnOwn && agree && syncA.final.witnessedIndex === blocks - 1n - DEFAULT_ERGO_DEPTH + (syncA.final.tipHeight - tip) &&
    answersA.every(x => x.entries === 0) && alone.unresolvedIndex === 5n && alone.witnessedIndex === 4n &&
    withOwn.final?.witnessedIndex === syncA.final.witnessedIndex &&
    forged.suppliers[0].stopped === "refused header: difficulty" && forged.suppliers[0].headersAdded === 5 &&
    forged.witnessedIndex !== undefined && forged.witnessedIndex >= syncA.final.witnessedIndex;
  report = {
    status: passed ? "passed" : "failed",
    node: process.version,
    nodes,
    profile: { anchorHeight: anchorHeight.toString(), anchorId: hex(anchorId), depth: profile.depth.toString(), identity: hex(identity),
      locations: "pay-to-public-key trees of the throwaway keys 0x01..01 to 0x04..04" },
    viewA: { suppliers: ["own node", "public node"], ms: syncA.ms, rounds: syncA.rounds, witnessedIndex: syncA.final.witnessedIndex.toString(),
      witnessedHeight: clockHeight.toString(), witnessedHeaderId: hex(syncA.final.witnessedHeaderId), standsOnOwnNodeBlock: standsOnOwn,
      headersVerified, sectionsRead, msPerBlock: round(syncA.ms / Number(syncA.final.witnessedIndex + 1n), 2) },
    viewB: { suppliers: ["public node"], ms: syncB.ms, rounds: syncB.rounds, witnessedIndex: syncB.final?.witnessedIndex.toString() ?? null },
    answers: { toIndex: common?.toString() ?? null, agree, viewA: answersA },
    hostile,
    files,
    limitations: [
      "One pass over a few hundred recent mainnet blocks from two node suppliers; no fork arose, so fork choice and a reorganization past the depth are exercised by the unit tests only.",
      "The locations are throwaway keys, so every answer is empty: attribution of real records on a node is the P2 publication experiment's, through the same framer.",
      "The hostile suppliers wrap the own node: one serves another block's section for one index, one raises one header's difficulty bits. Withholding by every supplier leaves the clock stopped, which only the unit tests exercise.",
    ],
  };
  if (!passed) process.exitCode = 2;
} finally {
  rmSync(build, { recursive: true, force: true });
}
const text = JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
if (out !== undefined) writeFileSync(resolve(root, out), text + "\n");
console.log(text);
