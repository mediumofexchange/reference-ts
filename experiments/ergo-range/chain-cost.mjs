// P4: the cost of the candidate profile's exhaustion on the real chain from a
// real anchor. GET-only reads of public Ergo nodes, cached under scratch/;
// nothing is submitted, no runtime path reads this, and no answer selects the
// profile. The public nodes are a trust input: header agreement between them
// is recorded, proof of work and chain selection are not checked. Each block's
// transactions are supplied by copying the node's JSON (src/ergo-supplier.ts); no
// decoder runs.
// Usage, from the repository root on Node 24 after `npm ci` and the
// experiment's pinned install:
//   node experiments/ergo-range/chain-cost.mjs --from 1873361 --count 5040
//     [--depth 10] [--sources https://node.ergo.watch,http://213.239.193.208:9053]
//     [--cache scratch/ergo-chain] [--delay 250] [--offline] [--out <report file>]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const from = Number(option("--from")), count = Number(option("--count")), depth = Number(option("--depth", "10"));
assert(Number.isInteger(from) && from > 1 && Number.isInteger(count) && count > 0 && Number.isInteger(depth) && depth >= 0, "usage: --from <height> --count <blocks> [--depth d]");
const sources = option("--sources", "https://node.ergo.watch,http://213.239.193.208:9053").split(",");
const cache = resolve(root, option("--cache", "scratch/ergo-chain"));
const delayMs = Number(option("--delay", "250")), offline = args.includes("--offline"), out = option("--out");
const DAY = 720, HEADER_VIEW_BYTES = 32 + 32 + 8 + 1 + 32, EMPTY_ANSWER_BYTES = 102;
mkdirSync(cache, { recursive: true });

const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
// The sources are hashed now, before any work, so the report names the files that produced it.
const files = Object.fromEntries(["experiments/ergo-range/chain-cost.mjs", "experiments/ergo-range/package.json",
  "experiments/ergo-range/package-lock.json", "experiments/ergo-range/fixtures/manifest.json", "tsconfig.json"].map(file => [file, fileHash(file)]));
const REQUEST_SAMPLES = 5;
// A cache name must not carry ":", which NTFS reads as an alternate data stream.
const hostOf = url => new URL(url).host.replace(/:/g, "-");
const treeVersion = tree => parseInt(tree.slice(0, 2), 16) & 7;
const percentile = (sorted, p) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
// A pay-to-public-key tree: header 0x00, then the SigmaProp constant of a compressed point.
const p2pk = point => Buffer.concat([Buffer.from("0008cd", "hex"), point]);

// Paced GET reads with rotation over the sources; every response is cached by name and digested.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = createHash("sha256");
let rotation = 0, liveFetches = 0, liveFetchMs = 0;
async function fetchText(path, pool) {
  for (let attempt = 0; ; attempt++) {
    const base = pool[(rotation + attempt) % pool.length];
    try {
      const t0 = performance.now();
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      liveFetches++; liveFetchMs += performance.now() - t0;
      return text;
    } catch (error) {
      if (attempt >= 7) throw new Error(`${base}${path}: ${error.cause?.code ?? error.message}`);
      rotation++;
      await sleep(2000 * 2 ** Math.min(attempt, 5));
    }
  }
}
async function cached(name, path, pool = sources) {
  const file = join(cache, name);
  let text;
  if (existsSync(file)) text = readFileSync(file, "utf8");
  else {
    if (offline) throw new Error(`offline and not cached: ${name}`);
    text = await fetchText(path, pool);
    writeFileSync(file, text);
    await sleep(delayMs);
  }
  digest.update(`${name}:${hex(sha256(text))}\n`);
  return text;
}

// The model is compiled from source into a disposable build, as the profile experiment does.
mkdirSync(join(root, "scratch"), { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "ergo-chain-cost-")));
const url = pathToFileURL(build + sep).href;
let report;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert(!config.error, "TypeScript configuration unreadable");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([join(root, "src/ergo-profile.ts"), join(root, "src/ergo-supplier.ts")], {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "model compiles");
  assert.equal(program.emit().emitSkipped, false);
  // Every repository source the compilation reads is bound.
  for (const source of program.getSourceFiles()) {
    const path = resolve(source.fileName);
    if (path.startsWith(root + sep) && !path.includes(`${sep}node_modules${sep}`)) files[path.slice(root.length + 1).replace(/\\/g, "/")] = fileHash(path.slice(root.length + 1));
  }
  const profile = await import(new URL("src/ergo-profile.js", url));
  const { supplyBlock } = await import(new URL("src/ergo-supplier.js", url));

  // Live source state, for the record only; an offline run records none.
  const sourceInfo = [];
  for (const source of sources) {
    let info = null;
    if (!offline) {
      try {
        const { name, appVersion, fullHeight, headersHeight, bestFullHeaderId } = JSON.parse(await fetchText("/info", [source]));
        info = { name, appVersion, fullHeight, headersHeight, bestFullHeaderId };
      } catch (error) { info = { error: String(error.message) }; }
    }
    sourceInfo.push({ url: source, info });
  }

  // Headers from every source over (anchor, tip], where the tip witnesses the last index under the depth.
  const anchorHeight = from - 1, tipHeight = from + count - 1 + depth;
  const headersBySource = new Map(), anchorBySource = new Map();
  for (const source of sources) {
    const host = hostOf(source), headers = [];
    for (let low = anchorHeight; low < tipHeight; low += 1000) {
      const high = Math.min(low + 1000, tipHeight);
      const text = await cached(`headers-${host}-${low}-${high}.json`, `/blocks/chainSlice?fromHeight=${low}&toHeight=${high}`, [source]);
      for (const header of JSON.parse(text)) headers.push(header);
    }
    headers.sort((a, b) => a.height - b.height);
    headersBySource.set(source, headers);
    anchorBySource.set(source, JSON.parse(await cached(`at-${host}-${anchorHeight}.json`, `/blocks/at/${anchorHeight}`, [source])));
  }
  const chain = headersBySource.get(sources[0]);
  const expectedHeights = tipHeight - anchorHeight;
  const fields = ["id", "parentId", "height", "version", "transactionsRoot"];
  const same = (a, b) => fields.every(field => a[field] === b[field]);
  let agree = 0, disagree = 0, linked = 0;
  for (let i = 0; i < chain.length; i++) {
    if (i > 0 && chain[i].parentId === chain[i - 1].id && chain[i].height === chain[i - 1].height + 1) linked++;
    const others = sources.slice(1).map(source => headersBySource.get(source)[i]);
    if (others.every(other => other !== undefined && same(chain[i], other))) agree++; else disagree++;
  }
  const anchorIds = sources.map(source => anchorBySource.get(source));
  const anchorAgreed = anchorIds.every(ids => ids.length === 1 && ids[0] === chain[0]?.parentId);
  const anchorId = chain[0]?.parentId;
  const headerAgreement = { sources: sources.length, fields, heights: chain.length, expectedHeights, agree, disagree, linked, linkedExpected: chain.length - 1,
    anchorAgreed, sameLength: sources.every(source => headersBySource.get(source).length === chain.length) };
  const headersResolved = chain.length === expectedHeights && disagree === 0 && linked === chain.length - 1 && anchorAgreed && headerAgreement.sameLength;
  const window = { anchorHeight, anchorId, fromHeight: from, toHeight: from + count - 1, count, depth, lag: depth + 1, tipHeight, tipId: chain.at(-1)?.id,
    headerVersions: [...new Set(chain.map(header => header.version))] };
  if (!headersResolved) {
    report = { status: "unresolved-header-disagreement", node: process.version, window, sources: sourceInfo, headerAgreement };
    process.exitCode = 2;
  } else {
    // Sections: every block of the window from its cached response, one transaction section per index. The reader's
    // evidence is each transaction's unsigned bytes and witness id as a supplier copies them from the node's JSON
    // (src/ergo-supplier.ts); a block counts only where every transaction is supplied and the header's root holds over them.
    const rows = [], suppliedBlocks = [];
    const framing = { transactions: 0, framed: 0, differing: 0, differingSample: [], unsupplied: 0, unsuppliedSample: [], suppliedBytes: 0 };
    let supplyMs = 0, rootCheckMs = 0, frameMs = 0;
    for (let i = 0; i < count; i++) {
      const header = chain[i];
      assert.equal(header.height, from + i);
      const text = await cached(`tx-${header.height}-${header.id}.json`, `/blocks/${header.id}/transactions`);
      if (i % 500 === 499) console.error(`  ${i + 1}/${count} sections at ${header.height}`);
      const t0 = performance.now();
      const { headerId, statements, supplied } = supplyBlock(text);
      supplyMs += performance.now() - t0;
      assert.equal(headerId, header.id, "the response names the requested block");
      let sectionBytes = 0, maxTx = 0, treeV3Outputs = 0, outputs = 0;
      for (const [position, statement] of statements.entries()) {
        const stated = statement.get("outputs");
        outputs += stated.length;
        treeV3Outputs += stated.filter(output => treeVersion(output.get("ergoTree")) === 3).length;
        const supply = supplied[position];
        if (supply === undefined) {
          framing.unsupplied++;
          if (framing.unsuppliedSample.length < 20) framing.unsuppliedSample.push({ height: header.height, position, id: statement.get("id") });
          continue;
        }
        sectionBytes += supply.signedBytes;
        maxTx = Math.max(maxTx, supply.signedBytes);
        framing.suppliedBytes += supply.unsigned.length + supply.witnessId.length;
        // Where the framer reads a transaction, its outputs must be the node's own statement of them.
        const t1 = performance.now();
        const framed = profile.frameTransaction(supply.unsigned);
        frameMs += performance.now() - t1;
        framing.transactions++;
        if (framed !== undefined) {
          framing.framed++;
          const same = framed.length === stated.length && framed.every((output, o) => hex(output.ergoTree) === stated[o].get("ergoTree") &&
            JSON.stringify(Object.entries(output.registers).map(([k, v]) => [k, hex(v)])) === JSON.stringify([...stated[o].get("additionalRegisters")]));
          if (!same) { framing.differing++; if (framing.differingSample.length < 20) framing.differingSample.push({ height: header.height, position, id: statement.get("id") }); }
        }
      }
      const complete = supplied.every(supply => supply !== undefined);
      const t2 = performance.now();
      const rootOk = complete && statements.length > 0 && profile.sectionMatchesRoot(supplied, Buffer.from(header.transactionsRoot, "hex"));
      rootCheckMs += performance.now() - t2;
      if (rootOk) suppliedBlocks.push({ headerId: Buffer.from(header.id, "hex"), transactions: supplied.map(({ unsigned, witnessId }) => ({ unsigned, witnessId })) });
      rows.push({ height: header.height, version: header.version, timestamp: Number(header.timestamp), headerSize: header.size, transactions: statements.length,
        supplied: supplied.filter(supply => supply !== undefined).length, outputs, jsonBytes: Buffer.byteLength(text), sectionBytes, maxTx, treeV3Outputs, rootOk });
    }

    // Section sizes and contents are summed over the blocks whose root held; a block that did not is counted, and its
    // header and fetched JSON are still charged, but its contents are not measured.
    const aggregate = slice => {
      const held = slice.filter(row => row.rootOk), sum = key => held.reduce((total, row) => total + row[key], 0), all = key => slice.reduce((total, row) => total + row[key], 0);
      const sections = held.map(row => row.sectionBytes).sort((a, b) => a - b);
      const first = slice[0].timestamp, last = slice.at(-1).timestamp, spanHours = (last - first) / 3.6e6;
      const result = { fromHeight: slice[0].height, toHeight: slice.at(-1).height, blocks: slice.length, rootOk: held.length, transactions: sum("transactions"), outputs: sum("outputs"),
        sectionBytes: sum("sectionBytes"), meanSectionBytes: held.length === 0 ? 0 : Math.round(sum("sectionBytes") / held.length), medianSectionBytes: percentile(sections, 0.5),
        p90SectionBytes: percentile(sections, 0.9), p99SectionBytes: percentile(sections, 0.99), maxSectionBytes: sections.at(-1) ?? 0,
        maxTransactionBytes: held.length === 0 ? 0 : Math.max(...held.map(row => row.maxTx)),
        headerWireBytes: all("headerSize"), headerWireBytesMin: Math.min(...slice.map(row => row.headerSize)), headerWireBytesMax: Math.max(...slice.map(row => row.headerSize)),
        headerViewBytesPerBlock: HEADER_VIEW_BYTES, headerViewBytes: slice.length * HEADER_VIEW_BYTES,
        jsonBytes: all("jsonBytes"), treeV3Outputs: sum("treeV3Outputs"), blocksWithTreeV3: held.filter(row => row.treeV3Outputs > 0).length,
        firstTimestamp: first, lastTimestamp: last, spanHours: Number(spanHours.toFixed(2)),
        blocksPerDay: slice.length > 1 && spanHours > 0 ? Number(((slice.length - 1) / (spanHours / 24)).toFixed(1)) : null,
        suppliedTransactions: all("supplied") };
      return result;
    };
    const totals = aggregate(rows);
    const days = [];
    for (let start = 0; start < rows.length; start += DAY) days.push(aggregate(rows.slice(start, start + DAY)));

    // The model verifier from the real anchor, with four throwaway locations no real output uses.
    const throwaway = n => p2pk(secp256k1.getPublicKey(new Uint8Array(32).fill(n), true));
    const scripts = { 1: throwaway(1), 2: throwaway(2), 3: throwaway(3), 4: throwaway(4) };
    const candidate = { anchor: Buffer.from(anchorId, "hex"), depth: BigInt(depth), scripts };
    const identity = profile.ergoProfileIdentity(candidate);
    const headerViews = chain.map(header => ({ id: Buffer.from(header.id, "hex"), parentId: Buffer.from(header.parentId, "hex"), height: BigInt(header.height),
      version: BigInt(header.version), transactionsRoot: Buffer.from(header.transactionsRoot, "hex") }));
    const wide = { maxBytes: 1n << 40n, maxEntries: 1n << 20n }, subject = Buffer.alloc(32, 17);
    const verifierResults = {};
    for (const name of ["reader"]) {
      // Construction is where every section's root is rechecked from the hashes of the unsigned bytes and every output is framed, scanned and attributed.
      const t0 = performance.now();
      const verifier = profile.ergoRangeVerifier(candidate, { headers: headerViews, blocks: suppliedBlocks });
      const constructMs = Math.round(performance.now() - t0);
      assert(verifier !== undefined, "the real headers anchor a chain through the anchor's child");
      assert.equal(verifier.witnessedIndex(), BigInt(count - 1), "the tip witnesses the last index under the depth");
      // A request's time is the least of a few repetitions; one sample varies by an order of magnitude on this host.
      const ask = (kind, fromIndex, toIndex, samples = REQUEST_SAMPLES) => {
        let bytes, least = Infinity;
        for (let i = 0; i < samples; i++) {
          const t1 = performance.now();
          bytes = verifier.range({ venue: identity, kind, subject, fromIndex: BigInt(fromIndex), toIndex: BigInt(toIndex) }, wide);
          least = Math.min(least, performance.now() - t1);
        }
        return { answered: bytes !== undefined, bytes: bytes?.length ?? null, ms: Number(least.toFixed(2)), samples };
      };
      const t2 = performance.now();
      const present = Array.from({ length: count }, (_, i) => ask(1, i, i, 1).answered);
      const singleIndexMs = Math.round(performance.now() - t2);
      const resolved = present.filter(Boolean).length;
      assert.equal(resolved, suppliedBlocks.length, "an index has a section exactly where every transaction was supplied and the root held");
      let run = 0, longest = 0;
      const unresolvedIndices = [];
      present.forEach((ok, i) => { if (ok) { run++; longest = Math.max(longest, run); } else { run = 0; unresolvedIndices.push(i); } });
      const lastDay = { fromIndex: Math.max(0, count - DAY), toIndex: count - 1 }, wholeWindow = { fromIndex: 0, toIndex: count - 1 };
      const requests = {};
      for (const [label, { fromIndex, toIndex }] of Object.entries({ lastDay, wholeWindow })) {
        requests[label] = { fromIndex, toIndex, kinds: Object.fromEntries([1, 2, 3, 4].map(kind => [kind, ask(kind, fromIndex, toIndex)])) };
        const expected = present.slice(fromIndex, toIndex + 1).every(Boolean);
        for (const kind of [1, 2, 3, 4]) {
          assert.equal(requests[label].kinds[kind].answered, expected, `${label} kind ${kind} answers exactly where every index has a section`);
          if (expected) assert.equal(requests[label].kinds[kind].bytes, EMPTY_ANSWER_BYTES, "nothing at a throwaway location under the subject: the answer is empty by exhaustion");
        }
      }
      verifierResults[name] = { blocksSupplied: suppliedBlocks.length, constructMs, witnessedIndex: count - 1, resolvedIndices: resolved, unresolvedIndices: count - resolved,
        longestResolvedRun: longest, firstUnresolvedIndices: unresolvedIndices.slice(0, 20), singleIndexProbeMs: singleIndexMs,
        requestMsIs: `the least of ${REQUEST_SAMPLES} repetitions`, requests };
    }

    const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json")));
    const { ergoNode, sigmaInterpreter, scrypto } = manifest.sources;
    report = {
      status: "public-node-window-measured", node: process.version,
      window: { ...window, firstTimestamp: totals.firstTimestamp, lastTimestamp: totals.lastTimestamp, spanHours: totals.spanHours, blocksPerDay: totals.blocksPerDay },
      sources: sourceInfo, headerAgreement,
      cache: { directory: cache, digest: digest.digest("hex"), covers: "every cached response read by this run, by name: the header slices and anchor read of each source and the window's block sections",
        liveFetches, liveFetchMs: Math.round(liveFetchMs), delayMs },
      framing: { ...framing, compares: "per transaction supplied, the framer's outputs (ErgoTree bytes, register names in order and constants) against the node's JSON statement, where the framer reads the unsigned bytes (the bytes are copied from that same statement, so this shows the framer splits the id-verified bytes as the node's JSON does, not agreement with an independent parser; the hostile probe compares with the node's own parser); suppliedBytes is what the reader takes, each unsigned byte string plus its 31-byte witness id; unsupplied counts transactions whose copied unsigned bytes do not hash to the id the node states" },
      profile: { context: profile.ERGO_PROFILE_CONTEXT, identity: hex(identity), depth: String(depth), lag: String(depth + 1), locations: Object.fromEntries(Object.entries(scripts).map(([kind, script]) => [kind, hex(script)])) },
      totals, days,
      timing: { supplyMs: Math.round(supplyMs), frameMs: Math.round(frameMs), rootCheckMs: Math.round(rootCheckMs),
        note: "supplyMs is the supplier's work: parsing each block's JSON text and copying every transaction's unsigned bytes, with their id and witness id hashes; frameMs the framer over every supplied transaction for the comparison with the node's statement; rootCheckMs the script's root over the supplied ids; the verifier's constructMs is where every section's root is rechecked from the hashes of the unsigned bytes and every output of a section whose root holds is framed and scanned, and a request afterwards walks per-index lists." },
      verifier: verifierResults,
      pins: { ergoNode, sigmaInterpreter, scrypto },
      files,
      limitations: [
        "Public nodes are the header source: their agreement with each other on id, parent, height, version and transaction root, linkage and the anchor's child are checked; proof of work, chain selection and finality are not, and a colluding or shared upstream is not excluded.",
        "Each transaction's unsigned bytes are copied from the nodes' JSON text (src/ergo-supplier.ts); a block counts only where every copy hashes to the id the node states and the ids and witness ids reproduce its header's transaction root. Section bytes are the same copy with each input's proof, so for block versions above 1 the root binds each transaction's unsigned bytes and the concatenation of its proofs, not the proofs' split among inputs, and a version-1 root binds no proof bytes. Attribution reads outputs only, so neither gap reaches an answer, but the byte counts are authenticated only that far.",
        "Neither the reader nor the supplier runs a decoder: the reader frames the unsigned bytes itself, and a transaction outside its framer's grammar carries no record while its block keeps its section; the supplier copies fields and parses no constant. A transaction whose copy did not hash to its id would leave its block unsupplied in this run, a limit of this supplier, not of the reader.",
        "The throwaway locations hold no real output and the subject is fixed, so every answer is empty by exhaustion: the cost measured is the scan at construction, not a real record set.",
        "Fetch time is the public nodes' response time under pacing from one host, only for responses fetched live in this run; an offline run records no live node state; only the exact window's header slices replay offline.",
        "No transaction was submitted, no node accepted anything of ours, no inclusion-latency distribution was taken, and no profile, decoder or dependency pin is selected here.",
      ],
    };
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}
const text = JSON.stringify(report, null, 2);
if (out !== undefined) writeFileSync(resolve(root, out), text + "\n");
console.log(text);
