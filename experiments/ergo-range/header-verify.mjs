// The reader as its own header source: the model's header store (model/pool-v3-ergo-headers.ts) verifies real
// mainnet headers from the profile's pinned anchor, supplied by several nodes it does not trust, and its best chain
// feeds the range verifier. GET-only reads, cached under scratch/; nothing is submitted, no runtime path reads this
// and no answer selects the profile. Each header's bytes are copied from the node's JSON (supply-header.mjs); the store
// derives the id, linkage, difficulty and proof of work from those bytes alone.
//
// Two parts:
// - window: the 1,024 headers below the anchor as context, then every header above it up to --to, from each source in
//   turn; each source is read until its first refusal. The best chain must be the one every source serves.
// - recalculations (--recalculations): every EIP-37 difficulty recalculation from the activation height up to --to,
//   read from the first source, which here is only the oracle: at each boundary the model's difficulty over the nine
//   headers it reads must equal the node's accepted header's, and every header read must pass proof of work.
// Usage, from the repository root on Node 24 after `npm ci` and the experiment's pinned install:
//   node experiments/ergo-range/header-verify.mjs --anchor 1873360 --to 1880300 [--recalculations]
//     [--sources http://127.0.0.1:9053,https://node.ergo.watch,http://213.239.193.208:9053]
//     [--cache scratch/ergo-headers] [--delay 250] [--offline] [--out <report file>]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseNodeJson } from "./supply.mjs";
import { supplyHeader } from "./supply-header.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const anchorHeight = Number(option("--anchor")), to = Number(option("--to")), depth = 10;
assert(Number.isInteger(anchorHeight) && Number.isInteger(to) && to > anchorHeight + depth, "usage: --anchor <height> --to <height>");
const sources = option("--sources", "http://127.0.0.1:9053,https://node.ergo.watch,http://213.239.193.208:9053").split(",");
const cache = resolve(root, option("--cache", "scratch/ergo-headers"));
const delayMs = Number(option("--delay", "250")), offline = args.includes("--offline"), out = option("--out");
const recalculations = args.includes("--recalculations");
mkdirSync(cache, { recursive: true });

const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
// The sources are hashed now, before any work, so the report names the files that produced it.
const files = Object.fromEntries(["experiments/ergo-range/header-verify.mjs", "experiments/ergo-range/supply.mjs", "experiments/ergo-range/supply-header.mjs", "experiments/ergo-range/package.json",
  "experiments/ergo-range/package-lock.json", "tsconfig.json"].map(file => [file, fileHash(file)]));
const hostOf = url => new URL(url).host.replace(/:/g, "-");
const percentile = (sorted, p) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const round = (value, digits = 3) => Number(value.toFixed(digits));

const sleep = ms => new Promise(done => setTimeout(done, ms));
const digest = createHash("sha256");
async function fetchText(base, path) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt >= 5) throw new Error(`${base}${path}: ${error.cause?.code ?? error.message}`);
      await sleep(2000 * 2 ** attempt);
    }
  }
}
async function cached(name, base, path, pace = true) {
  const file = join(cache, name);
  let text;
  if (existsSync(file)) text = readFileSync(file, "utf8");
  else {
    if (offline) throw new Error(`offline and not cached: ${name}`);
    text = await fetchText(base, path);
    writeFileSync(file, text);
    if (pace) await sleep(delayMs);
  }
  digest.update(`${name}:${hex(sha256(text))}\n`);
  return text;
}
/** Headers (low, high] from one source as statements, each with what is supplied for it. */
async function slice(source, low, high, pace = true) {
  const text = await cached(`headers-${hostOf(source)}-${low}-${high}.json`, source, `/blocks/chainSlice?fromHeight=${low}&toHeight=${high}`, pace);
  const statements = parseNodeJson(text);
  assert(Array.isArray(statements), "a chain slice is a list");
  return statements.map(statement => ({ statement, supplied: supplyHeader(statement) }));
}

// The model is compiled from source into a disposable build, as the profile experiment does.
mkdirSync(join(root, "scratch"), { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "ergo-header-verify-")));
const url = pathToFileURL(build + sep).href;
let report;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert(!config.error, "TypeScript configuration unreadable");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([join(root, "model/pool-v3-ergo-headers.ts"), join(root, "model/pool-v3-ergo-profile.ts")], {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "model compiles");
  assert.equal(program.emit().emitSkipped, false);
  // Every repository source the compilation reads is bound.
  for (const source of program.getSourceFiles()) {
    const path = resolve(source.fileName);
    if (path.startsWith(root + sep) && !path.includes(`${sep}node_modules${sep}`)) files[path.slice(root.length + 1).replace(/\\/g, "/")] = fileHash(path.slice(root.length + 1));
  }
  const headers = await import(new URL("model/pool-v3-ergo-headers.js", url));
  const profile = await import(new URL("model/pool-v3-ergo-profile.js", url));

  const sourceInfo = [];
  for (const source of sources) {
    let info = null;
    if (!offline) {
      try {
        const { name, appVersion, fullHeight, headersHeight, bestHeaderId } = JSON.parse(await fetchText(source, "/info"));
        info = { name, appVersion, fullHeight, headersHeight, bestHeaderId };
      } catch (error) { info = { error: String(error.message) }; }
    }
    sourceInfo.push({ url: source, info });
  }

  // Window: every source's statements over (anchor − 1025, to].
  const contextLow = anchorHeight - headers.ANCHOR_CONTEXT - 1;
  const bySource = new Map();
  for (const source of sources) {
    const rows = [];
    for (let low = contextLow; low < to; low += 1000) rows.push(...await slice(source, low, Math.min(low + 1000, to)));
    rows.sort((a, b) => Number(a.statement.get("height") - b.statement.get("height")));
    bySource.set(source, rows);
    console.error(`  ${source}: ${rows.length} headers`);
  }
  const reference = bySource.get(sources[0]);
  const anchorRow = reference.find(row => Number(row.statement.get("height")) === anchorHeight);
  assert(anchorRow?.supplied !== undefined, "the first source supplies the anchor");
  // The anchor is pinned, never taken from a source: --anchor-id, or the P4 report's where its window starts here.
  const p4 = JSON.parse(readFileSync(join(root, "docs/ergo-chain-cost-verification.json"), "utf8"));
  files["docs/ergo-chain-cost-verification.json"] = fileHash("docs/ergo-chain-cost-verification.json");
  const pinned = option("--anchor-id", p4.window.anchorHeight === anchorHeight ? p4.window.anchorId : undefined);
  assert(typeof pinned === "string" && /^[0-9a-f]{64}$/.test(pinned), "the anchor id is pinned: pass --anchor-id <hex> away from the P4 anchor");
  const anchorId = Buffer.from(pinned, "hex");

  // One store for the reader. Each source's context must link to the pinned anchor; the first that does builds it.
  const contextOf = rows => rows.filter(row => Number(row.statement.get("height")) <= anchorHeight).map(row => row.supplied?.bytes);
  const contextLinks = {};
  let store;
  for (const source of sources) {
    const context = contextOf(bySource.get(source));
    const candidate = context.every(bytes => bytes !== undefined) ? headers.ergoHeaderStore(anchorId, context) : undefined;
    contextLinks[source] = { headers: context.length, links: candidate !== undefined };
    store ??= candidate;
  }
  assert(store !== undefined, "some source's context links to the anchor");

  const perSource = [], addMs = [];
  for (const source of sources) {
    const rows = bySource.get(source).filter(row => Number(row.statement.get("height")) > anchorHeight);
    const counts = { offered: rows.length, unsupplied: 0, added: 0, known: 0, refused: null };
    for (const row of rows) {
      if (row.supplied === undefined) { counts.unsupplied++; counts.refused = { height: Number(row.statement.get("height")), reason: "unsupplied" }; break; }
      const t0 = performance.now();
      const result = store.add(row.supplied.bytes);
      const ms = performance.now() - t0;
      if (result === "added") { counts.added++; addMs.push(ms); } else if (result === "known") counts.known++;
      else { counts.refused = { height: Number(row.statement.get("height")), reason: result }; break; }
    }
    perSource.push({ source, ...counts });
    console.error(`  ${source}: added ${counts.added}, known ${counts.known}`);
  }
  const best = store.best();
  // The best chain must be every source's chain, height by height.
  const bestIds = best.headers.map(view => hex(view.id));
  const agreement = sources.map(source => {
    const ids = bySource.get(source).filter(row => Number(row.statement.get("height")) > anchorHeight).map(row => row.statement.get("id"));
    return { source, heights: ids.length, equal: ids.length === bestIds.length && ids.every((id, i) => id === bestIds[i]) };
  });
  // Where the window covers P4's, its anchor and tip (whose sections P4 bound to their roots) must be on the best chain.
  const p4OnBest = p4.window.anchorHeight !== anchorHeight || to < p4.window.tipHeight ? null :
    bestIds[p4.window.tipHeight - anchorHeight - 1] === p4.window.tipId && hex(anchorId) === p4.window.anchorId;

  // Real-data refusals: each mutation of an accepted header must be refused with its own reason.
  const acceptedRow = reference.find(row => Number(row.statement.get("height")) === anchorHeight + 5);
  const base = acceptedRow.supplied.bytes, parsedBase = headers.parseErgoHeader(base);
  const lengthOfWithoutPow = parsedBase.withoutPow.length;
  const withField = (mutate) => { const copy = new Uint8Array(base); mutate(copy); return copy; };
  const encodeVlq = n => { const outBytes = []; do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; outBytes.push(b); } while (n > 0n); return outBytes; };
  // Field offsets in the canonical form: version 1, parent 32, three roots 32+32+33, then the VLQ timestamp.
  const timestampAt = 1 + 32 + 32 + 32 + 33, timestampLength = encodeVlq(parsedBase.timestamp).length;
  const splice = (at, length, replacement) => new Uint8Array([...base.slice(0, at), ...replacement, ...base.slice(at + length)]);
  const parent = headers.parseErgoHeader(reference.find(row => Number(row.statement.get("height")) === anchorHeight + 4).supplied.bytes);
  const contextHeader = headers.parseErgoHeader(reference.find(row => Number(row.statement.get("height")) === anchorHeight - 1).supplied.bytes);
  const nBitsAt = timestampAt + timestampLength + 32;
  const hostile = {
    nonce: withField(copy => { copy[copy.length - 1] ^= 1; }),
    nBits: withField(copy => { copy[nBitsAt + 3] ^= 1; }),
    timestampEqualParent: splice(timestampAt, timestampLength, encodeVlq(parent.timestamp)),
    unknownParent: withField(copy => { copy[1] ^= 1; }),
    belowAnchor: withField(copy => { copy.set(contextHeader.id, 1); }),
    height: withField(copy => { copy[nBitsAt + 4 + 2] ^= 1; }),
    nonMinimalTimestamp: splice(timestampAt + timestampLength - 1, 1, [base[timestampAt + timestampLength - 1] | 0x80, 0]),
    trailingByte: new Uint8Array([...base, 0]),
    newFieldsLength: withField(copy => { copy[lengthOfWithoutPow - 1] = 1; }),
  };
  const expected = { nonce: "pow", nBits: "difficulty", timestampEqualParent: "timestamp", unknownParent: "unknown-parent", belowAnchor: "below-anchor",
    height: "height", nonMinimalTimestamp: "malformed", trailingByte: "malformed", newFieldsLength: "malformed" };
  const refusals = Object.fromEntries(Object.entries(hostile).map(([name, bytes]) => [name, { expected: expected[name], got: store.add(bytes) }]));
  const refusalsHold = Object.values(refusals).every(r => r.got === r.expected) && store.add(base) === "known";

  // The best chain feeds the unchanged range verifier from the pinned anchor.
  const throwaway = n => Buffer.concat([Buffer.from("0008cd", "hex"), secp256k1.getPublicKey(new Uint8Array(32).fill(n), true)]);
  const candidate = { anchor: anchorId, depth: BigInt(depth), scripts: { 1: throwaway(1), 2: throwaway(2), 3: throwaway(3), 4: throwaway(4) } };
  const verifier = profile.ergoRangeVerifier(candidate, { headers: best.headers, blocks: [] });
  const verifierOk = verifier !== undefined && verifier.witnessedIndex() === best.height - BigInt(depth) - BigInt(anchorHeight + 1);

  // Recalculations: the oracle's accepted chain at every EIP-37 boundary up to --to.
  let recalculation = null;
  if (recalculations) {
    const oracle = sources[0], first = Number(headers.EIP37_ACTIVATION_HEIGHT) - 1, epoch = Number(headers.DIFFICULTY_EPOCH);
    assert.equal(first % epoch, 0, "EIP-37 activates at a boundary");
    const byHeight = new Map();
    const multiples = [];
    for (let m = first - headers.ANCHOR_CONTEXT; m < to; m += epoch) multiples.push(m);
    // One slice per multiple m: the headers at m and m + 1, read from the local oracle without pacing.
    const powMs = [];
    let t0 = performance.now();
    for (const [n, m] of multiples.entries()) {
      for (const row of await slice(oracle, m - 1, m + 1, false)) byHeight.set(Number(row.statement.get("height")), row);
      if (n % 1000 === 999) console.error(`  recalculation reads ${n + 1}/${multiples.length} (${round((performance.now() - t0) / 1000, 1)} s)`);
    }
    const readSeconds = (performance.now() - t0) / 1000;
    // Every multiple must yield its two headers and every boundary its nine; a gap is reported, never skipped.
    const expectedBoundaries = multiples.filter(m => m >= first).length, expectedHeaders = 2 * multiples.length;
    const result = { expectedBoundaries, boundaries: 0, difficultyEqual: 0, difficultyDiffering: [], expectedHeaders, headersRead: 0, unsupplied: 0,
      powValid: 0, powInvalid: [], linked: 0, incomplete: [] };
    t0 = performance.now();
    for (const [height, row] of byHeight) {
      result.headersRead++;
      if (row.supplied === undefined) { result.unsupplied++; continue; }
      const header = headers.parseErgoHeader(row.supplied.bytes);
      if (header === undefined) { result.powInvalid.push(height); continue; }
      const p0 = performance.now();
      const difficulty = headers.decodeCompactBits(header.nBits), valid = headers.autolykosPowValid(header);
      powMs.push(performance.now() - p0);
      if (valid) result.powValid++; else result.powInvalid.push(height);
      if (height >= Number(headers.EIP37_ACTIVATION_HEIGHT) && (height - 1) % epoch === 0) {
        result.boundaries++;
        const previous = [];
        for (let i = 8; i >= 0; i--) {
          const bytes = byHeight.get(height - 1 - i * epoch)?.supplied?.bytes;
          if (bytes !== undefined) previous.push(headers.parseErgoHeader(bytes));
        }
        if (previous.length !== 9) { result.incomplete.push(height); continue; }
        if (hex(header.parentId) === hex(previous[8].id)) result.linked++;
        const want = headers.eip37Difficulty(previous);
        if (want === difficulty) result.difficultyEqual++; else result.difficultyDiffering.push({ height, want: String(want), got: String(difficulty) });
      }
    }
    powMs.sort((a, b) => a - b);
    recalculation = { oracle, fromHeight: first + 1, toHeight: to, ...result, readSeconds: round(readSeconds, 1), checkSeconds: round((performance.now() - t0) / 1000, 1),
      powMsMedian: round(percentile(powMs, 0.5)), tableSizes: [...new Set([...byHeight.keys()].map(h => String(headers.autolykosTableSize(BigInt(h)))))].length };
  }

  addMs.sort((a, b) => a - b);
  const wire = best.headers.length === 0 ? 0 : reference.filter(row => Number(row.statement.get("height")) > anchorHeight).reduce((total, row) => total + row.supplied.bytes.length, 0);
  const aboveCount = best.headers.length;
  const window = { anchorHeight, anchorId: hex(anchorId), contextFrom: contextLow + 1, to, depth, tipHeight: Number(best.height), tipId: hex(best.tipId),
    score: String(best.score), headersAbove: aboveCount };
  const cost = {
    verifiedHeaders: addMs.length, addMsMean: round(addMs.reduce((a, b) => a + b, 0) / Math.max(1, addMs.length)), addMsMedian: round(percentile(addMs, 0.5)),
    addMsP99: round(percentile(addMs, 0.99)), addSeconds: round(addMs.reduce((a, b) => a + b, 0) / 1000, 1),
    wireBytesMean: round(wire / Math.max(1, aboveCount), 2), contextBytes: contextOf(reference).reduce((total, bytes) => total + bytes.length, 0),
    yearOfHeadersMinutes: round(262_800 * (addMs.reduce((a, b) => a + b, 0) / Math.max(1, addMs.length)) / 60000, 1),
  };
  const passed = best.height === BigInt(to) && agreement.every(a => a.equal) && perSource.every(s => s.refused === null) &&
    Object.values(contextLinks).every(c => c.links) && refusalsHold && verifierOk && p4OnBest !== false &&
    (recalculation === null || (recalculation.unsupplied === 0 && recalculation.powInvalid.length === 0 && recalculation.difficultyDiffering.length === 0 &&
      recalculation.incomplete.length === 0 && recalculation.boundaries === recalculation.expectedBoundaries &&
      recalculation.headersRead === recalculation.expectedHeaders && recalculation.linked === recalculation.boundaries &&
      recalculation.difficultyEqual === recalculation.boundaries));
  report = {
    status: passed ? "passed" : "failed",
    node: process.version,
    window, sources: sourceInfo, contextLinks, perSource, agreement, p4OnBest, refusals, verifier: { built: verifier !== undefined, witnessedIndex: verifier === undefined ? null : String(verifier.witnessedIndex()) },
    recalculation, cost,
    cache: { directory: "scratch/ergo-headers", sha256: digest.digest("hex") },
    files,
    limitations: [
      "The store applies the pinned node's header rules for a child header (height, timestamp above the parent's, EIP-37 difficulty, Autolykos v2 proof of work) to mainnet headers of versions 2–4 above an anchor at or after EIP-37 activation. It does not apply the node's local-clock rule, its local bound on fork depth or its marking of headers whose block failed full validation; a header-only reader rests on the work, as any light client does. Without the clock rule a supplier can lower the required difficulty on a side branch with future timestamps (halving each epoch after about 256 blocks of work at the starting difficulty): such a branch cannot outscore the best chain's work, but its headers are accepted and kept, so what a supplier may add must be bounded by the reader's supplier policy. Only canonical header bytes are read.",
      "Sources are untrusted suppliers of bytes, and the reader takes the heaviest valid chain it is shown. A source can withhold a heavier chain: several independent sources reduce, and do not remove, that eclipse risk. No fork was offered here; fork choice is covered by the unit tests only.",
      "The recalculation part reads the first source's accepted headers at each boundary and the eight epochs before it, not a contiguous chain: it compares the model's difficulty rule and proof of work with that node's acceptance on real data; the contiguous window is the store's own verification.",
      "Each header costs one proof-of-work check in pure JavaScript (Blake2b over about 34 Autolykos elements of 8 KiB); a bogus header that passes the cheap checks costs the reader that check before its refusal.",
    ],
  };
  if (!passed) process.exitCode = 2;
} finally {
  rmSync(build, { recursive: true, force: true });
}
const text = JSON.stringify(report, null, 2);
if (out !== undefined) writeFileSync(resolve(root, out), text + "\n");
console.log(text);
