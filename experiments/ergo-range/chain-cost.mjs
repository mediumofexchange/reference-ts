// P4: the cost of the candidate profile's exhaustion on the real chain from a
// real anchor. GET-only reads of public Ergo nodes, cached under scratch/;
// nothing is submitted, no runtime path reads this, and no answer selects the
// profile. The public nodes are a trust input: header agreement between them
// is recorded, proof of work and chain selection are not checked.
// Usage, from the repository root on Node 24 after `npm ci` and the
// experiment's pinned install:
//   node experiments/ergo-range/chain-cost.mjs --from 1873361 --count 5040
//     [--depth 10] [--sources https://node.ergo.watch,http://213.239.193.208:9053]
//     [--cache scratch/ergo-chain] [--alternate <dir with another ergo-lib-wasm-nodejs>]
//     [--delay 250] [--offline] [--out <report file>]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b";
import { Address, Transaction } from "ergo-lib-wasm-nodejs";
import { decodeTransaction } from "./decoder.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const from = Number(option("--from")), count = Number(option("--count")), depth = Number(option("--depth", "10"));
assert(Number.isInteger(from) && from > 1 && Number.isInteger(count) && count > 0 && Number.isInteger(depth) && depth >= 0, "usage: --from <height> --count <blocks> [--depth d]");
const sources = option("--sources", "https://node.ergo.watch,http://213.239.193.208:9053").split(",");
const cache = resolve(root, option("--cache", "scratch/ergo-chain"));
const alternateDir = option("--alternate") === undefined ? undefined : resolve(root, option("--alternate"));
const delayMs = Number(option("--delay", "250")), offline = args.includes("--offline"), out = option("--out");
const DAY = 720, HEADER_VIEW_BYTES = 32 + 32 + 8 + 1 + 32, EMPTY_ANSWER_BYTES = 102;
mkdirSync(cache, { recursive: true });

const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
// A cache name must not carry ":", which NTFS reads as an alternate data stream.
const hostOf = url => new URL(url).host.replace(/:/g, "-");
// Node 24's source text keeps the nodes' large integers exact; rawJSON re-emits them unchanged.
const parseExact = raw => JSON.parse(raw, (_key, value, context) => typeof value === "number" ? JSON.rawJSON(context.source) : value);
// The exact text of each element of the named array: a transaction's bytes
// depend on its spending-proof extension's key order, which the node emits in
// its map's order and JavaScript objects would sort, so the serializer reads
// the node's text, not a re-serialization of a parsed object.
const elementTexts = (text, key) => {
  const start = text.indexOf(`"${key}"`);
  assert(start >= 0, `no "${key}" in the response`);
  let depth = 0, inString = false, from = -1;
  const out = [];
  for (let i = text.indexOf("[", start) + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") { if (depth === 0) from = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0) out.push(text.slice(from, i + 1)); }
    else if (c === "]" && depth === 0) break;
  }
  return out;
};
const witnessOf = tx => blake2b(Buffer.concat(tx.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"))), { dkLen: 32 }).subarray(1);
const treeVersion = output => parseInt(output.ergoTree.slice(0, 2), 16) & 7;
const percentile = (sorted, p) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const sameView = (a, b) => hex(a.id) === hex(b.id) && hex(a.witnessId) === hex(b.witnessId) && a.outputs.length === b.outputs.length && a.outputs.every((output, i) => {
  const other = b.outputs[i], names = Object.keys(output.registers).sort();
  return hex(output.ergoTree) === hex(other.ergoTree) && names.join() === Object.keys(other.registers).sort().join() &&
    names.every(name => hex(output.registers[name]) === hex(other.registers[name]));
});
// decoder.mjs's strict round trip, verbatim, over whichever build of the library's `Transaction` class
// is handed in; the run checks it against decoder.mjs itself on the pinned build for every transaction.
const strictDecoder = TransactionClass => bytes => {
  let tx;
  try { tx = TransactionClass.sigma_parse_bytes(bytes); } catch { return undefined; }
  try {
    if (hex(tx.sigma_serialize_bytes()) !== hex(bytes)) return undefined;
    const js = tx.to_js_eip12();
    const proofs = js.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"));
    return { id: Buffer.from(js.id, "hex"), witnessId: blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1),
      outputs: js.outputs.map(output => ({ ergoTree: Buffer.from(output.ergoTree, "hex"),
        registers: Object.fromEntries(Object.entries(output.additionalRegisters).map(([name, value]) => [name, Buffer.from(value, "hex")])) })) };
  } finally { tx.free(); }
};

const packageOf = dir => {
  const require = createRequire(join(dir, "package.json"));
  const { version } = require("ergo-lib-wasm-nodejs/package.json");
  return { version, wasmSha256: hex(sha256(readFileSync(require.resolve("ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm")))), module: require("ergo-lib-wasm-nodejs") };
};
const pinned = packageOf(here);
assert.equal(pinned.module.Transaction, Transaction, "the pinned decoder is the experiment's own package");
const alternate = alternateDir === undefined ? undefined : packageOf(alternateDir);
// The pinned package alone serializes; the alternate only reads the same bytes through the same strict round trip.
const decoders = { pinned: { ...pinned, decode: decodeTransaction }, ...(alternate ? { alternate: { ...alternate, decode: strictDecoder(alternate.module.Transaction) } } : {}) };
const pinnedCopy = strictDecoder(Transaction);

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
  const program = ts.createProgram([join(root, "model/pool-v3-ergo-profile.ts")], {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "model compiles");
  assert.equal(program.emit().emitSkipped, false);
  const profile = await import(new URL("model/pool-v3-ergo-profile.js", url));

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
    // Sections: every block of the window from its cached response, one transaction section per index.
    const rows = [], bytesUnavailable = [], reordered = [];
    const refusals = Object.fromEntries(Object.keys(decoders).map(name => [name, []]));
    const decodeMs = Object.fromEntries(Object.keys(decoders).map(name => [name, 0]));
    const views = Object.fromEntries(Object.keys(decoders).map(name => [name, []]));
    const agreement = { compared: 0, differing: 0 }, equivalence = { transactions: 0, differing: 0 };
    let serializeMs = 0, rootCheckMs = 0;
    for (let i = 0; i < count; i++) {
      const header = chain[i];
      assert.equal(header.height, from + i);
      const text = await cached(`tx-${header.height}-${header.id}.json`, `/blocks/${header.id}/transactions`);
      if (i % 500 === 499) console.error(`  ${i + 1}/${count} sections at ${header.height}`);
      const block = parseExact(text);
      assert.equal(block.headerId, header.id, "the response names the requested block");
      const txs = block.transactions, texts = elementTexts(text, "transactions");
      assert.equal(texts.length, txs.length, "one exact text per transaction");
      let sectionBytes = 0, maxTx = 0, treeV3Outputs = 0, serialized = 0, outputs = 0;
      const leaves = [], decoded = Object.fromEntries(Object.keys(decoders).map(name => [name, []]));
      for (const [position, tx] of txs.entries()) {
        outputs += tx.outputs.length;
        const treeVersions = tx.outputs.map(treeVersion);
        treeV3Outputs += treeVersions.filter(version => version === 3).length;
        // Bytes come from the node's exact JSON text through the pinned serializer, which refuses a text whose
        // claimed id differs from the id of its own serialization; the header root, not the serializer, authenticates them.
        let bytes, id;
        const t0 = performance.now();
        try {
          const wasm = Transaction.from_json(texts[position]);
          try { const serialization = wasm.sigma_serialize_bytes(), own = Buffer.from(wasm.id().to_str(), "hex"); bytes = serialization; id = own; } finally { wasm.free(); }
        } catch (error) { bytesUnavailable.push({ height: header.height, position, id: tx.id, treeVersions, error: String(error).slice(0, 120) }); }
        serializeMs += performance.now() - t0;
        if (bytes === undefined) continue;
        // The same transaction through a parsed-and-re-emitted object: integer-like keys come out sorted, so a
        // spending-proof extension of several entries can serialize to bytes with another id, which the library refuses.
        try { const again = Transaction.from_json(JSON.stringify(tx)); again.free(); } catch { reordered.push({ height: header.height, position, id: tx.id, extensionKeys: tx.inputs.map(input => Object.keys(input.spendingProof.extension).length) }); }
        serialized++;
        sectionBytes += bytes.length;
        maxTx = Math.max(maxTx, bytes.length);
        leaves.push({ id, witnessId: witnessOf(tx), outputs: [] });
        const viewsOf = {};
        for (const [name, decoder] of Object.entries(decoders)) {
          const t1 = performance.now();
          const view = decoder.decode(bytes);
          decodeMs[name] += performance.now() - t1;
          viewsOf[name] = view;
          if (view === undefined) refusals[name].push({ height: header.height, position, id: tx.id, treeVersions });
          else decoded[name].push(view);
        }
        // The verbatim copy must refuse and read exactly as decoder.mjs does, or the alternate's counts are not comparable.
        const copy = pinnedCopy(bytes);
        equivalence.transactions++;
        if ((copy === undefined) !== (viewsOf.pinned === undefined) || (copy !== undefined && !sameView(copy, viewsOf.pinned))) equivalence.differing++;
        if (alternate && viewsOf.pinned !== undefined && viewsOf.alternate !== undefined) { agreement.compared++; if (!sameView(viewsOf.pinned, viewsOf.alternate)) agreement.differing++; }
      }
      const t2 = performance.now();
      const rootOk = serialized === txs.length && hex(profile.transactionsRoot(BigInt(header.version), leaves)) === header.transactionsRoot;
      rootCheckMs += performance.now() - t2;
      const read = {};
      for (const name of Object.keys(decoders)) {
        read[name] = rootOk && decoded[name].length === txs.length;
        if (read[name]) views[name].push({ headerId: Buffer.from(header.id, "hex"), transactions: decoded[name] });
      }
      rows.push({ height: header.height, version: header.version, timestamp: Number(header.timestamp), headerSize: header.size, transactions: txs.length, outputs,
        jsonBytes: Buffer.byteLength(text), sectionBytes, maxTx, treeV3Outputs, rootOk, read });
    }

    // Sizes are summed over the blocks whose root held; a block that did not is counted, not measured.
    const aggregate = slice => {
      const held = slice.filter(row => row.rootOk), sum = key => held.reduce((total, row) => total + row[key], 0);
      const sections = held.map(row => row.sectionBytes).sort((a, b) => a - b);
      const first = slice[0].timestamp, last = slice.at(-1).timestamp, spanHours = (last - first) / 3.6e6;
      const result = { fromHeight: slice[0].height, toHeight: slice.at(-1).height, blocks: slice.length, rootOk: held.length, transactions: sum("transactions"), outputs: sum("outputs"),
        sectionBytes: sum("sectionBytes"), meanSectionBytes: held.length === 0 ? 0 : Math.round(sum("sectionBytes") / held.length), medianSectionBytes: percentile(sections, 0.5),
        p90SectionBytes: percentile(sections, 0.9), p99SectionBytes: percentile(sections, 0.99), maxSectionBytes: sections.at(-1) ?? 0,
        maxTransactionBytes: held.length === 0 ? 0 : Math.max(...held.map(row => row.maxTx)),
        headerWireBytes: slice.reduce((total, row) => total + row.headerSize, 0), headerViewBytesPerBlock: HEADER_VIEW_BYTES, headerViewBytes: slice.length * HEADER_VIEW_BYTES,
        jsonBytes: sum("jsonBytes"), treeV3Outputs: sum("treeV3Outputs"), blocksWithTreeV3: held.filter(row => row.treeV3Outputs > 0).length,
        firstTimestamp: first, lastTimestamp: last, spanHours: Number(spanHours.toFixed(2)),
        blocksPerDay: slice.length > 1 && spanHours > 0 ? Number(((slice.length - 1) / (spanHours / 24)).toFixed(1)) : null, read: {} };
      for (const name of Object.keys(decoders)) result.read[name] = slice.filter(row => row.read[name]).length;
      return result;
    };
    const totals = aggregate(rows);
    const days = [];
    for (let start = 0; start < rows.length; start += DAY) days.push(aggregate(rows.slice(start, start + DAY)));

    // The model verifier from the real anchor, with four throwaway locations no real output uses.
    const p2pk = n => Address.from_public_key(secp256k1.getPublicKey(new Uint8Array(32).fill(n), true)).to_ergo_tree().sigma_serialize_bytes();
    const scripts = { 1: p2pk(1), 2: p2pk(2), 3: p2pk(3), 4: p2pk(4) };
    const candidate = { anchor: Buffer.from(anchorId, "hex"), depth: BigInt(depth), scripts };
    const identity = profile.ergoProfileIdentity(candidate);
    const headerViews = chain.map(header => ({ id: Buffer.from(header.id, "hex"), parentId: Buffer.from(header.parentId, "hex"), height: BigInt(header.height),
      version: BigInt(header.version), transactionsRoot: Buffer.from(header.transactionsRoot, "hex") }));
    const wide = { maxBytes: 1n << 40n, maxEntries: 1n << 20n }, subject = Buffer.alloc(32, 17);
    const verifierResults = {};
    for (const name of Object.keys(decoders)) {
      // Construction is where every section's root is rechecked from the decoder's ids and every output is scanned and attributed.
      const t0 = performance.now();
      const verifier = profile.ergoRangeVerifier(candidate, { headers: headerViews, blocks: views[name] });
      const constructMs = Math.round(performance.now() - t0);
      assert(verifier !== undefined, "the real headers anchor a chain through the anchor's child");
      assert.equal(verifier.witnessedIndex(), BigInt(count - 1), "the tip witnesses the last index under the depth");
      const ask = (kind, fromIndex, toIndex) => {
        const t1 = performance.now();
        const bytes = verifier.range({ venue: identity, kind, subject, fromIndex: BigInt(fromIndex), toIndex: BigInt(toIndex) }, wide);
        return { answered: bytes !== undefined, bytes: bytes?.length ?? null, ms: Number((performance.now() - t1).toFixed(2)) };
      };
      const t2 = performance.now();
      const present = Array.from({ length: count }, (_, i) => ask(1, i, i).answered);
      const singleIndexMs = Math.round(performance.now() - t2);
      const resolved = present.filter(Boolean).length;
      assert.equal(resolved, totals.read[name], "an index has a section exactly where the decoder read its block and the root held");
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
      verifierResults[name] = { blocksSupplied: views[name].length, constructMs, witnessedIndex: count - 1, resolvedIndices: resolved, unresolvedIndices: count - resolved,
        longestResolvedRun: longest, firstUnresolvedIndices: unresolvedIndices.slice(0, 20), singleIndexProbeMs: singleIndexMs, requests };
    }

    const byTreeVersions = list => {
      const counts = {};
      for (const entry of list) { const key = [...new Set(entry.treeVersions)].sort().join(","); counts[key] = (counts[key] ?? 0) + 1; }
      return counts;
    };
    const refusalSummary = {};
    for (const [name, list] of Object.entries(refusals)) {
      refusalSummary[name] = { transactions: list.length, blocks: new Set(list.map(r => r.height)).size, byOutputTreeVersions: byTreeVersions(list), sample: list.slice(0, 40) };
    }
    const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json")));
    const { ergoNode, sigmaInterpreter, scrypto } = manifest.sources;
    report = {
      status: "public-node-window-measured", node: process.version,
      window: { ...window, firstTimestamp: totals.firstTimestamp, lastTimestamp: totals.lastTimestamp, spanHours: totals.spanHours, blocksPerDay: totals.blocksPerDay },
      sources: sourceInfo, headerAgreement,
      cache: { directory: cache, digest: digest.digest("hex"), covers: "every cached response read by this run, by name: the header slices and anchor read of each source and the window's block sections",
        liveFetches, liveFetchMs: Math.round(liveFetchMs), delayMs },
      decoders: Object.fromEntries(Object.entries(decoders).map(([name, { version, wasmSha256 }]) => [name, { version, wasmSha256, path: name === "pinned" ? "experiments/ergo-range" : alternateDir }])),
      decoderEquivalence: { ...equivalence, compares: "decoder.mjs against this script's verbatim copy of it on the pinned build: refusal or an equal id, witness id, ErgoTree and registers of every output, for every serialized transaction" },
      decoderAgreement: alternate ? { ...agreement, compares: "id, witness id, ErgoTree bytes and every register constant of every output, where both decoders read one transaction" } : null,
      profile: { context: profile.ERGO_PROFILE_CONTEXT, identity: hex(identity), depth: String(depth), lag: String(depth + 1), locations: Object.fromEntries(Object.entries(scripts).map(([kind, script]) => [kind, hex(script)])) },
      totals, days,
      bytes: { serialized: totals.transactions, unavailable: { transactions: bytesUnavailable.length, blocks: new Set(bytesUnavailable.map(r => r.height)).size,
        byOutputTreeVersions: byTreeVersions(bytesUnavailable), sample: bytesUnavailable.slice(0, 40) },
        refusedWhenReemitted: { transactions: reordered.length, blocks: new Set(reordered.map(r => r.height)).size, sample: reordered.slice(0, 40),
          means: "the same transactions parsed into objects and re-emitted, which sorts integer-like keys, serialize to bytes whose id the library rejects" } },
      timing: { serializeMs: Math.round(serializeMs), rootCheckMs: Math.round(rootCheckMs), decodeMs: Object.fromEntries(Object.entries(decodeMs).map(([name, ms]) => [name, Math.round(ms)])),
        note: "serializeMs is the pinned library's text-to-bytes work including its own id; rootCheckMs the script's root over those ids; decodeMs each decoder's strict round trip and field extraction over the same bytes; the verifier's constructMs is where every section's root is rechecked from the decoder's ids and every output is scanned, and a request afterwards walks per-index lists" },
      verifier: verifierResults, refusals: refusalSummary,
      pins: { ergoNode, sigmaInterpreter, scrypto },
      files: Object.fromEntries(["experiments/ergo-range/chain-cost.mjs", "experiments/ergo-range/decoder.mjs", "experiments/ergo-range/package.json",
        "experiments/ergo-range/package-lock.json", "experiments/ergo-range/fixtures/manifest.json", "model/pool-v3-ergo-profile.ts", "model/pool-v3-range.ts"].map(file => [file, fileHash(file)])),
      limitations: [
        "Public nodes are the header source: their agreement with each other on id, parent, height, version and transaction root, linkage and the anchor's child are checked; proof of work, chain selection and finality are not, and a colluding or shared upstream is not excluded.",
        "Transaction bytes are obtained by serializing the nodes' exact JSON text with the pinned library; a block counts only where the bytes reproduce its header's transaction root. For block versions above 1 the root binds each transaction's unsigned bytes and the concatenation of its proofs, not the proofs' split among inputs; a version-1 root binds no proof bytes. Attribution reads outputs only, so neither gap reaches an answer, but the byte counts are authenticated only that far.",
        "A decoder's refusal leaves its index without a section; the counts are for the exact package versions named and this window only, not a bound on future blocks. The alternate build runs this script's verbatim copy of decoder.mjs, checked against decoder.mjs on the pinned build for every transaction; the two builds are compared on ids, witness ids and the outputs they both read, not on inputs or data inputs.",
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
