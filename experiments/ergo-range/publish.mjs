// P2: publication and reassembly on a node (recovery map P2, A10, A11), under
// the candidate Ergo profile's layout. TESTNET ONLY: the script refuses any
// node whose /info does not report the testnet, and the only key it signs
// with is a throwaway read from an ignored file under scratch/. It is run
// explicitly, never by `check` or CI, because it submits transactions to a
// public testnet node and reads blocks back from it. No runtime path reads
// it, no answer selects the profile, and testnet acceptance is not mainnet
// acceptance.
//
// Usage, from the repository root on Node 24 after the experiment's pinned install:
//   node experiments/ergo-range/publish.mjs --dry-run [--out <report>]
//     builds, signs and reads back every case over a synthetic funded input and a
//     synthetic block on a real cached header; GET only, and offline once /info and
//     the signing context are cached under scratch/ergo-testnet/cache/.
//   node experiments/ergo-range/publish.mjs [--node http://213.239.193.208:9052]
//     [--wallet scratch/ergo-testnet/wallet.json] [--state scratch/ergo-testnet/run.json]
//     [--depth 2] [--poll 20] [--max-wait 120] [--delay 250] [--out <report>] [--resume]
//     publishes the cases from the wallet's unspent boxes, spends the pieces back,
//     waits for the depth and reads every block of the window through the model verifier.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import * as sigma from "ergo-lib-wasm-nodejs";
import { decodeTransaction } from "./decoder.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const dryRun = args.includes("--dry-run"), resume = args.includes("--resume");
const nodeUrl = option("--node", "http://213.239.193.208:9052").replace(/\/$/, "");
const walletFile = resolve(root, option("--wallet", "scratch/ergo-testnet/wallet.json"));
const stateFile = resolve(root, option("--state", "scratch/ergo-testnet/run.json"));
const cache = resolve(root, option("--cache", "scratch/ergo-testnet/cache"));
const depth = Number(option("--depth", "2")), pollSeconds = Number(option("--poll", "20")), maxWaitMinutes = Number(option("--max-wait", "120"));
const delayMs = Number(option("--delay", "250")), out = option("--out");
assert(Number.isInteger(depth) && depth >= 0 && depth < 64 && pollSeconds > 0 && maxWaitMinutes > 0, "usage: [--depth d] [--poll s] [--max-wait min]");
mkdirSync(cache, { recursive: true });

// Venue constants checked against upstream source by the earlier offline probe and the profile check. The node
// enforces the box limit and the dust rule (BoxUtils.minimalErgoAmount: minValuePerByte times the full box bytes)
// over the full ErgoBox bytes, which add the creating transaction's 32-byte id and the output index's VLQ to the
// candidate; minValuePerByte is a votable parameter read from the node below.
const MAX_BOX_BYTES = 4096, MEMPOOL_MAX_TX_BYTES = 98304, PIECE_BYTES = 3981, SEPARATOR_VALUE = 1000000n;
const TESTNET = sigma.NetworkPrefix.Testnet;
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
// The models' direct sources are bound by hash; their deeper src/ imports are bound through the repository revision.
const files = Object.fromEntries(["experiments/ergo-range/publish.mjs", "experiments/ergo-range/decoder.mjs", "experiments/ergo-range/package.json",
  "experiments/ergo-range/package-lock.json", "model/pool-v3-ergo-profile.ts", "model/pool-v3-range.ts", "model/pool-v3-records.ts",
  "src/bytes.ts", "src/contexts.ts", "src/pool/field.ts"].map(file => [file, fileHash(file)]));
const require = createRequire(join(here, "package.json"));
const library = { version: require("ergo-lib-wasm-nodejs/package.json").version, wasmSha256: hex(sha256(readFileSync(require.resolve("ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm")))) };
assert.equal(library.version, JSON.parse(readFileSync(join(here, "vendor/ergo-lib-wasm-nodejs/package.json"), "utf8")).version, "the installed library is the vendored one");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const vlqLength = n => { let bytes = 1; while (n >= 128) { n = Math.floor(n / 128); bytes++; } return bytes; };
const value = n => sigma.BoxValue.from_i64(sigma.I64.from_str(String(n)));
const valueOf = boxValue => BigInt(boxValue.as_i64().to_str());
// Deterministic synthetic bytes: a proof-sized field the venue never reads, labelled as such in the report.
const synthetic = (label, length) => {
  const parts = [];
  for (let i = 0; parts.reduce((n, p) => n + p.length, 0) < length; i++) parts.push(sha256(Buffer.from(`moe/experiment/ergo-publication/${label}/${i}`)));
  return Buffer.concat(parts).subarray(0, length);
};
// Node 24's source text keeps the node's large integers exact; the exact text of each array element is
// what the pinned library serializes, since a re-emitted object sorts a spending-proof extension's keys.
const parseExact = raw => JSON.parse(raw, (_key, v, context) => typeof v === "number" ? JSON.rawJSON(context.source) : v);
const elementTexts = (text, key) => {
  const start = text.indexOf(`"${key}"`);
  assert(start >= 0, `no "${key}" in the response`);
  let level = 0, inString = false, from = -1;
  const found = [];
  for (let i = text.indexOf("[", start) + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) { if (c === "\\") i++; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === "{") { if (level === 0) from = i; level++; }
    else if (c === "}") { level--; if (level === 0) found.push(text.slice(from, i + 1)); }
    else if (c === "]" && level === 0) break;
  }
  return found;
};

// Node access: paced, every response digested; immutable responses cached by name (no ":" in a name on NTFS).
// A submission is never retried blindly: a lost response is checked against what the node holds.
const digest = createHash("sha256");
let requests = 0;
async function http(method, path, body, retry = true) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${nodeUrl}${path}`, { method, signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }) });
      const text = await response.text();
      requests++;
      await sleep(delayMs);
      if (!response.ok) { const error = new Error(`HTTP ${response.status} ${method} ${path}: ${text.slice(0, 300)}`); error.status = response.status; error.body = text; throw error; }
      return text;
    } catch (error) {
      if (error.status !== undefined || !retry || attempt >= 5) throw error;
      await sleep(2000 * 2 ** attempt);
    }
  }
}
const get = path => http("GET", path);
async function cached(name, path) {
  const file = join(cache, name);
  let text;
  if (existsSync(file)) text = readFileSync(file, "utf8");
  else { text = await get(path); writeFileSync(file, text); }
  digest.update(`${name}:${hex(sha256(text))}\n`);
  return text;
}

// The models are compiled from source into a disposable build, as the profile and chain-cost experiments do.
mkdirSync(join(root, "scratch"), { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "ergo-publish-")));
const url = pathToFileURL(build + sep).href;
let report;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert(!config.error, "TypeScript configuration unreadable");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(["ergo-profile", "range", "records"].map(name => join(root, `model/pool-v3-${name}.ts`)), {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "models compile");
  assert.equal(program.emit().emitSkipped, false);
  const profile = await import(new URL("model/pool-v3-ergo-profile.js", url));
  const range = await import(new URL("model/pool-v3-range.js", url));
  const records = await import(new URL("model/pool-v3-records.js", url));
  const { limbsOf } = await import(new URL("src/pool/field.js", url));

  // The node must be the testnet before anything else is read from it, let alone submitted, and its votable
  // parameters fix the dust rule the pieces are valued by. The dry run reads /info and the signing context once
  // and caches both together, so it repeats offline against the same node state; the live run reads them fresh.
  const infoRaw = JSON.parse(dryRun ? await cached("info.json", "/info") : await get("/info"));
  assert.equal(infoRaw.network, "testnet", `refusing a node whose network is ${JSON.stringify(infoRaw.network)}`);
  const info = { name: infoRaw.name, appVersion: infoRaw.appVersion, network: infoRaw.network, fullHeight: infoRaw.fullHeight, headersHeight: infoRaw.headersHeight,
    bestFullHeaderId: infoRaw.bestFullHeaderId, parameters: infoRaw.parameters };
  assert(Number.isInteger(info.parameters?.minValuePerByte) && info.parameters.minValuePerByte > 0, "the node reports its minValuePerByte");
  const MIN_VALUE_PER_BYTE = BigInt(info.parameters.minValuePerByte);
  const contextHeaders = JSON.parse(dryRun ? await cached("lastHeaders-10.json", "/blocks/lastHeaders/10") : await get("/blocks/lastHeaders/10"));
  assert.equal(contextHeaders.length, 10, "ten headers for the signing context");
  const latest = contextHeaders.at(-1);
  assert(contextHeaders.every((header, i) => i === 0 || header.height === contextHeaders[i - 1].height + 1), "the context headers ascend");
  const stateContext = new sigma.ErgoStateContext(sigma.PreHeader.from_block_header(sigma.BlockHeader.from_json(JSON.stringify(latest))),
    sigma.BlockHeaders.from_json(contextHeaders), sigma.Parameters.default_parameters());
  // Live state, loaded early: a run pins its output creation height, so a resumed run rebuilds any unrecorded
  // transaction byte for byte (same id) instead of double-spending its inputs at a newer height. The node requires
  // creation heights at or above every input's (txMonotonicHeight) and not above the tip (txFuture); the pinned
  // height is the tip at the run's start, above the funding boxes and equal across the chain.
  const state = dryRun ? undefined : resume && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { started: new Date().toISOString(), node: nodeUrl, transactions: {}, order: [] };
  const save = () => { if (state !== undefined) writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n"); };
  const creationHeight = dryRun ? Number(latest.height) : (state.creationHeight ??= Number(latest.height));
  save();

  // Keys: the funded throwaway key from the ignored file; the four locations are pay-to-public-key trees of
  // keys derived from it, so the kind-4 pieces can be spent back. No secret leaves this process.
  assert(existsSync(walletFile), `no wallet file at ${walletFile}; create one with a fresh testnet key under scratch/`);
  const wallet = JSON.parse(readFileSync(walletFile, "utf8"));
  assert.equal(wallet.network, "testnet", "the wallet file must declare the testnet");
  const walletKey = sigma.SecretKey.dlog_from_bytes(Buffer.from(wallet.secretHex, "hex"));
  const walletAddress = walletKey.get_address();
  assert.equal(walletAddress.to_base58(TESTNET), wallet.address, "the wallet file's address is its key's");
  const locationKey = kind => sigma.SecretKey.dlog_from_bytes(sha256(Buffer.concat([Buffer.from(`moe/experiment/ergo-publication/location/${kind}/`), Buffer.from(wallet.secretHex, "hex")])));
  const locationKeys = Object.fromEntries([1, 2, 3, 4].map(kind => [kind, locationKey(kind)]));
  const treeOf = address => address.to_ergo_tree().sigma_serialize_bytes();
  const scripts = Object.fromEntries([1, 2, 3, 4].map(kind => [kind, treeOf(locationKeys[kind].get_address())]));
  const walletTree = treeOf(walletAddress), publicationAddress = locationKeys[4].get_address();
  assert(Object.values(scripts).every(script => hex(script) !== hex(walletTree)), "the wallet's tree is no location");
  const secrets = new sigma.SecretKeys(); secrets.add(walletKey); for (const kind of [1, 2, 3, 4]) secrets.add(locationKeys[kind]);
  const signer = sigma.Wallet.from_secrets(secrets);

  // Two publications under one backing: the largest (a release, pool-v3 §6) and the smallest with force
  // (a withdrawal). Frames and lengths are exact; the proof and signatures are synthetic bytes, since the
  // venue applies no content rule and no real settle proof is retained outside the proving harness.
  const id = label => sha256(Buffer.from(`moe/experiment/ergo-publication/${label}`));
  const domain = id("domain"), segment = id("segment"), backing = id("backing"), demand = id("demand");
  const pairOf = bytes => [...limbsOf(bytes)];
  const release = { domain, backing, kind: 3, record: { domain, kind: 6,
    publicInputs: [...pairOf(domain), ...pairOf(segment), 0n, ...pairOf(backing), 1n, 7n, 0n, 0n, 0n, 0n, 0n, 0n, ...pairOf(demand)],
    proof: synthetic("proof", 14656), authorization: synthetic("authorization", 136), capsules: [] } };
  const withdrawal = { domain, backing, kind: 4, record: { domain, kind: 5,
    publicInputs: [...pairOf(domain), ...pairOf(segment), 0n, ...pairOf(demand)], proof: new Uint8Array(0), authorization: synthetic("presenter", 64), capsules: [] } };
  const publications = {};
  for (const [name, publication] of Object.entries({ release, withdrawal })) {
    const bytes = records.encodePublication(publication);
    assert.equal(hex(records.encodePublication(records.decodePublication(bytes))), hex(bytes), `${name} round trips`);
    const pieces = [];
    for (let at = 0; at < bytes.length; at += PIECE_BYTES) pieces.push(bytes.subarray(at, Math.min(at + PIECE_BYTES, bytes.length)));
    publications[name] = { bytes, pieces, id: hex(records.publicationId(publication)) };
  }
  assert.equal(publications.release.bytes.length, 15498, "a release publication under a 14,656-byte proof is 15,498 bytes");
  assert.equal(publications.withdrawal.bytes.length, 450, "a withdrawal publication is 450 bytes");
  assert.equal(publications.release.pieces.length, 4, "a release is four pieces");
  const decodes = bytes => { try { records.decodePublication(bytes); return true; } catch { return false; } };

  // A piece box: the kind-4 location, R4 the subject and R5 the piece, valued at the node's rule over the
  // full box bytes (candidate bytes plus the 32-byte transaction id and the output index's VLQ). The library's
  // own estimate covers the candidate only and is recorded beside it.
  const pieceBox = (piece, outputIndex) => {
    const builder = new sigma.ErgoBoxCandidateBuilder(value(1000000), sigma.Contract.pay_to_address(publicationAddress), creationHeight);
    builder.set_register_value(sigma.NonMandatoryRegisterId.R4, sigma.Constant.from_byte_array(backing));
    builder.set_register_value(sigma.NonMandatoryRegisterId.R5, sigma.Constant.from_byte_array(piece));
    const libraryMinimum = valueOf(builder.calc_min_box_value());
    let fullBytes, minimum = 0n;
    for (let round = 0; round < 4; round++) {
      fullBytes = builder.calc_box_size_bytes() + 32 + vlqLength(outputIndex);
      const next = BigInt(fullBytes) * MIN_VALUE_PER_BYTE;
      if (next === minimum) break;
      minimum = next; builder.set_value(value(minimum));
    }
    assert(fullBytes <= MAX_BOX_BYTES, `a piece box of ${fullBytes} bytes exceeds the box limit`);
    return { candidate: builder.build(), fullBytes, minimum, libraryMinimum, pieceBytes: piece.length };
  };
  const plainBox = (amount = SEPARATOR_VALUE) => new sigma.ErgoBoxCandidateBuilder(value(amount), sigma.Contract.pay_to_address(walletAddress), creationHeight).build();
  const fee = sigma.TxBuilder.SUGGESTED_TX_FEE();
  const totalOf = boxes => { let sum = 0n; for (let i = 0; i < boxes.len(); i++) sum += valueOf(boxes.get(i).value()); return sum; };

  // The cases. Each is one transaction whose first outputs are the listed objects; the builder appends the
  // change (to the wallet) and the fee box after them. "separator" is a plain wallet output between two runs.
  const R = publications.release.pieces, W = publications.withdrawal.pieces;
  const cases = [
    { name: "release", outputs: R, expect: [{ record: "release", firstOutput: 0 }] },
    { name: "duplicate", outputs: R, expect: [{ record: "release", firstOutput: 0 }] },
    { name: "reordered", outputs: [R[1], R[0], R[2], R[3]], expect: [{ record: "reordered", firstOutput: 0 }] },
    { name: "partial", outputs: [R[0], R[1], R[2]], expect: [{ record: "partial", firstOutput: 0 }] },
    { name: "merged", outputs: [...R, ...W], expect: [{ record: "merged", firstOutput: 0 }] },
    { name: "separated", outputs: [...R, "separator", ...W], expect: [{ record: "release", firstOutput: 0 }, { record: "withdrawal", firstOutput: 5 }] },
  ];
  const expectedRecords = { release: publications.release.bytes, withdrawal: publications.withdrawal.bytes,
    reordered: Buffer.concat([R[1], R[0], R[2], R[3]]), partial: Buffer.concat([R[0], R[1], R[2]]), merged: Buffer.concat([...R, ...W]) };
  const decodable = { release: true, withdrawal: true, reordered: false, partial: false, merged: false };
  for (const [name, bytes] of Object.entries(expectedRecords)) assert.equal(decodes(bytes), decodable[name], `${name} decodes under §6 exactly where expected`);
  // What each case costs the wallet (piece and separator values plus the fee); the sweep pays its fee from the pieces.
  const caseCost = spec => spec.outputs.reduce((sum, piece, i) => sum + (piece === "separator" ? SEPARATOR_VALUE : pieceBox(piece, i).minimum), valueOf(fee));
  const costs = cases.map(caseCost), runCost = costs.reduce((a, b) => a + b, 0n);
  // A final change box below the dust minimum would be refused, so the wallet holds exactly the run's cost or that plus one plain box.
  const minChange = BigInt(new sigma.ErgoBoxCandidateBuilder(value(10n ** 9n), sigma.Contract.pay_to_address(walletAddress), creationHeight).calc_box_size_bytes() + 33) * MIN_VALUE_PER_BYTE;

  // Build and sign one transaction from the given inputs. `reserve` is value the selection must carry beyond
  // this transaction (it returns as change), so the first case of a chain funds every later one. "sweep"
  // returns every input's value less the fee to the wallet in one plain box, so every input is consumed.
  const buildTransaction = (name, inputBoxes, outputSpecs, reserve = 0n) => {
    const built = outputSpecs.map((spec, i) => spec === "separator" ? { candidate: plainBox(), role: "separator" }
      : spec === "sweep" ? { candidate: plainBox(totalOf(inputBoxes) - valueOf(fee)), role: "return" } : { ...pieceBox(spec, i), role: "piece" });
    const candidates = new sigma.ErgoBoxCandidates(built[0].candidate);
    for (const { candidate } of built.slice(1)) candidates.add(candidate);
    // Inputs are selected for the target plus the reserve; the change is everything selected beyond the target
    // itself, so the reserve returns to the wallet in the change box.
    const target = built.reduce((sum, { candidate }) => sum + valueOf(candidate.value()), valueOf(fee));
    const selected = new sigma.SimpleBoxSelector().select(inputBoxes, value(target + reserve), new sigma.Tokens()).boxes();
    const change = totalOf(selected) - target, changeList = new sigma.ErgoBoxAssetsDataList();
    if (change > 0n) changeList.add(new sigma.ErgoBoxAssetsData(value(change), new sigma.Tokens()));
    const selection = new sigma.BoxSelection(selected, changeList);
    const unsigned = sigma.TxBuilder.new(selection, candidates, creationHeight, fee, walletAddress).build();
    const t0 = performance.now();
    const signed = signer.sign_transaction(stateContext, unsigned, selection.boxes(), sigma.ErgoBoxes.empty());
    const signMs = Math.round(performance.now() - t0);
    const bytes = signed.sigma_serialize_bytes();
    assert(bytes.length <= MEMPOOL_MAX_TX_BYTES, "within the mempool policy");
    assert.equal(hex(sigma.Transaction.sigma_parse_bytes(bytes).sigma_serialize_bytes()), hex(bytes), "exact round trip");
    const outputs = signed.outputs(), outputRows = [];
    for (let i = 0; i < outputs.len(); i++) {
      const box = outputs.get(i), tree = hex(box.ergo_tree().sigma_serialize_bytes());
      const role = i < built.length ? built[i].role : tree === hex(walletTree) ? "change" : "fee";
      outputRows.push({ index: i, role, boxId: box.box_id().to_str(), value: valueOf(box.value()).toString(), boxBytes: box.sigma_serialize_bytes().length,
        ...(role === "piece" ? { pieceBytes: built[i].pieceBytes, nodeMinimum: built[i].minimum.toString(), libraryMinimum: built[i].libraryMinimum.toString() } : {}) });
    }
    for (const row of outputRows) assert(row.boxBytes <= MAX_BOX_BYTES, "every box within the limit");
    for (const row of outputRows.filter(r => r.role === "piece")) assert.equal(BigInt(row.boxBytes) * MIN_VALUE_PER_BYTE, BigInt(row.nodeMinimum), "the node's rule was applied to the exact box bytes");
    const inputsSelected = selection.boxes(), inputIds = [];
    for (let i = 0; i < inputsSelected.len(); i++) inputIds.push(inputsSelected.get(i).box_id().to_str());
    return { name, signed, json: signed.to_json(), id: signed.id().to_str(), bytes: bytes.length, jsonBytes: Buffer.byteLength(signed.to_json()), signMs, inputs: inputIds, outputs: outputRows,
      pieceValue: outputRows.filter(r => r.role === "piece").reduce((sum, r) => sum + BigInt(r.value), 0n).toString(), fee: valueOf(fee).toString() };
  };
  const changeBox = transaction => {
    const outputs = transaction.signed.outputs();
    const row = transaction.outputs.find(r => r.role === "change");
    assert(row !== undefined, `${transaction.name} has a change output to chain from`);
    return outputs.get(row.index);
  };
  const pieceBoxes = transactions => {
    const boxes = sigma.ErgoBoxes.empty();
    for (const transaction of transactions) {
      const outputs = transaction.signed.outputs();
      for (const row of transaction.outputs) if (row.role === "piece") boxes.add(outputs.get(row.index));
    }
    return boxes;
  };
  const summarize = ({ signed, json, ...rest }) => rest;

  // The reader: headers as views, sections from the node's exact text through the pinned serializer and the
  // strict decoder, the model verifier from the anchor, and one kind-4 request under the subject.
  const headerView = header => ({ id: Buffer.from(header.id, "hex"), parentId: Buffer.from(header.parentId, "hex"), height: BigInt(header.height),
    version: BigInt(header.version), transactionsRoot: Buffer.from(header.transactionsRoot, "hex") });
  const candidate = anchorId => ({ anchor: Buffer.from(anchorId, "hex"), depth: BigInt(depth), scripts });
  const wide = { maxBytes: 1n << 40n, maxEntries: 1n << 20n };
  const readBack = (anchorId, headerViews, blocks, transactionsByCase) => {
    const chosen = candidate(anchorId), identity = profile.ergoProfileIdentity(chosen);
    const supplied = blocks.filter(b => b.views !== undefined);
    const t0 = performance.now();
    const verifier = profile.ergoRangeVerifier(chosen, { headers: headerViews, blocks: supplied.map(b => ({ headerId: b.headerId, transactions: b.views })) });
    const constructMs = Math.round(performance.now() - t0);
    assert(verifier !== undefined, "the headers anchor a chain through the anchor's child");
    const origin = headerViews.find(h => hex(h.parentId) === anchorId).height;
    const witnessed = verifier.witnessedIndex();
    // The range runs through the last block read, every index of which must have its section; the tip may be beyond it.
    const last = blocks.reduce((max, b) => b.height > max ? b.height : max, 0n) - origin;
    assert(last <= witnessed, "the last block read is witnessed under the depth");
    const request = { venue: identity, kind: 4, subject: backing, fromIndex: 0n, toIndex: last };
    const t1 = performance.now();
    const answerBytes = verifier.range(request, wide);
    const answerMs = Number((performance.now() - t1).toFixed(2));
    assert(answerBytes !== undefined, `the kind-4 range through index ${last} is answered; refused: ${JSON.stringify(blocks.filter(b => b.views === undefined).map(b => b.refused))}`);
    const answer = range.decodeRangeAnswer(answerBytes, request, wide);
    // Every entry is attributed to the transaction at its index and position; every case's expectation is met exactly once.
    const entries = answer.entries.map(entry => {
      const height = origin + entry.index, block = blocks.find(b => b.height === height);
      assert(block !== undefined, "an answered index has a supplied block");
      const position = Number(entry.ordinal >> 32n), firstOutput = Number(entry.ordinal & 0xffffffffn);
      const transactionId = block.ids[position];
      const found = Object.entries(transactionsByCase).find(([, t]) => t.id === transactionId);
      const record = Object.entries(expectedRecords).find(([, bytes]) => hex(bytes) === hex(entry.record))?.[0] ?? "unexpected";
      return { index: entry.index.toString(), height: height.toString(), ordinal: entry.ordinal.toString(), transactionPosition: position, firstOutput,
        transactionId, case: found?.[0] ?? null, recordBytes: entry.record.length, record, decodesUnder6: decodes(entry.record) };
    });
    for (const [name, transaction] of Object.entries(transactionsByCase)) {
      const spec = cases.find(c => c.name === name), own = entries.filter(e => e.transactionId === transaction.id);
      assert.equal(own.length, spec.expect.length, `${name}: one object per expected run`);
      for (const [i, expectation] of spec.expect.entries()) {
        assert.equal(own[i].record, expectation.record, `${name}: run ${i} is ${expectation.record}`);
        assert.equal(own[i].firstOutput, expectation.firstOutput, `${name}: run ${i} starts at output ${expectation.firstOutput}`);
        assert.equal(own[i].decodesUnder6, decodable[expectation.record], `${name}: run ${i} decodes exactly where expected`);
      }
    }
    assert(entries.every(e => e.case !== null), "no object outside the cases under the subject");
    // Same-index order: within one block, entries stand in transaction position then output order.
    for (let i = 1; i < entries.length; i++) {
      const a = entries[i - 1], b = entries[i];
      assert(a.index < b.index || (a.index === b.index && BigInt(a.ordinal) < BigInt(b.ordinal)), "answer in venue order");
    }
    const byHeight = {};
    for (const e of entries) (byHeight[e.height] ??= []).push(`${e.case}@${e.transactionPosition}.${e.firstOutput}`);
    // No output stands at the kind-1–3 locations, so those ranges answer empty (102 bytes) by exhaustion.
    const kinds123Empty = [1, 2, 3].map(kind => verifier.range({ ...request, kind }, wide)?.length === 102);
    assert(kinds123Empty.every(Boolean), "kinds 1-3 answer empty under the subject");
    return { identity: hex(identity), origin: origin.toString(), witnessedIndex: witnessed.toString(), toIndex: last.toString(), constructMs, answerMs, answerBytes: answerBytes.length,
      entries, sameIndexOrder: byHeight, kinds123Empty };
  };
  const sectionOf = async header => {
    const text = await cached(`tx-${header.height}-${header.id}.json`, `/blocks/${header.id}/transactions`);
    const block = parseExact(text), texts = elementTexts(text, "transactions");
    assert.equal(block.headerId, header.id, "the response names the requested block");
    assert.equal(texts.length, block.transactions.length, "one exact text per transaction");
    const views = [], ids = [], refused = [];
    let sectionBytes = 0;
    for (const [position, tx] of block.transactions.entries()) {
      ids.push(tx.id);
      let bytes;
      try { const wasm = sigma.Transaction.from_json(texts[position]); try { bytes = wasm.sigma_serialize_bytes(); } finally { wasm.free(); } }
      catch (error) {
        // An overflow or trap leaves the library's instance unusable: fatal, never a refusal (decoder.mjs).
        if (error instanceof RangeError || error instanceof WebAssembly.RuntimeError) throw error;
        refused.push({ position, id: tx.id, step: "serialize", error: String(error).slice(0, 120) }); continue;
      }
      const view = decodeTransaction(bytes);
      if (view === undefined) { refused.push({ position, id: tx.id, step: "decode" }); continue; }
      views.push(view); sectionBytes += bytes.length;
    }
    // A block with a refused transaction has no section: its index stays unresolved and the read through it fails, as the profile says.
    const complete = refused.length === 0 && hex(profile.transactionsRoot(BigInt(header.version), views)) === header.transactionsRoot;
    if (refused.length === 0) assert(complete, `the section reproduces the root at ${header.height}`);
    return { height: BigInt(header.height), headerId: Buffer.from(header.id, "hex"), views: complete ? views : undefined, ids, transactions: block.transactions.length, sectionBytes, refused };
  };

  const layout = { pieceBytes: PIECE_BYTES, maxBoxBytes: MAX_BOX_BYTES, minValuePerByte: Number(MIN_VALUE_PER_BYTE), mempoolMaxTransactionBytes: MEMPOOL_MAX_TX_BYTES,
    fullBoxBytesRule: "the node's txDust rule is its minValuePerByte times the full ErgoBox bytes (BoxUtils.minimalErgoAmount): the candidate bytes plus the 32-byte transaction id and the output index's VLQ; the library's calc_min_box_value covers the candidate only",
    runCost: runCost.toString(), caseCosts: Object.fromEntries(cases.map((c, i) => [c.name, costs[i].toString()])), minChange: minChange.toString(), creationHeight };
  const describe = () => ({ address: wallet.address, tree: hex(walletTree), publicationAddress: publicationAddress.to_base58(TESTNET), locations: Object.fromEntries(Object.entries(scripts).map(([k, s]) => [k, hex(s)])) });
  const publicationSummary = Object.fromEntries(Object.entries(publications).map(([name, p]) => [name, { bytes: p.bytes.length, pieces: p.pieces.map(piece => piece.length), publicationId: p.id }]));
  const limitations = [
    "The venue is the public Ergo testnet through one public node; acceptance, fees, minimum values and inclusion latency are the testnet's under its reported parameters and current miners, not mainnet's.",
    "The publications' frames and lengths are exact under pool-v3 §6; the proof, authorization and signature bytes are synthetic, since the venue applies no content rule and no real settle proof is retained outside the proving harness. Nothing here is a valid statement, a demand or a settlement.",
    "Headers come from the one node the transactions were submitted to; linkage, contiguity and the anchor's child are checked by the model, proof of work and chain selection are not.",
    "The four locations are pay-to-public-key trees of throwaway keys derived from the funded testnet key; no deployment, backing or specification names them.",
    "Transaction bytes are the pinned library's serialization of the node's exact JSON text and count only where they reproduce the header's transaction root; the strict decoder has no containment or node-equivalence proof beyond the fixtures and one mainnet week.",
    "The cases are chained on one change box and submitted together, so their inclusion latencies are correlated observations, not a distribution; only the sweep is submitted at a separate time.",
    "The signed transactions' witness ids, and so a block root over them, vary between runs (Schnorr proofs are randomized); transaction ids, box ids, sizes and every answer are deterministic.",
    "No runtime path, profile selection, specification change or dependency change follows from this measurement.",
  ];

  if (dryRun) {
    // A synthetic funded input at the wallet's tree, the cases chained as the live path chains them (each spends the
    // previous case's change, so every case has its own id), and one synthetic block holding every case as the
    // child of the real cached latest header, with synthetic children to the depth.
    const funded = new sigma.ErgoBox(value(10n ** 9n), creationHeight - 5, sigma.Contract.pay_to_address(walletAddress), sigma.TxId.from_str(hex(id("dry-run-input"))), 0, new sigma.Tokens());
    let inputs = new sigma.ErgoBoxes(funded);
    const transactions = {};
    for (const [i, spec] of cases.entries()) {
      transactions[spec.name] = buildTransaction(spec.name, inputs, spec.outputs, costs.slice(i + 1).reduce((a, b) => a + b, 0n));
      inputs = new sigma.ErgoBoxes(changeBox(transactions[spec.name]));
    }
    const spend = buildTransaction("spend", pieceBoxes(Object.values(transactions)), ["sweep"]);
    assert.equal(spend.inputs.length, Object.values(transactions).reduce((n, t) => n + t.outputs.filter(r => r.role === "piece").length, 0), "the spend consumes every piece box");
    const views = Object.values(transactions).map(t => decodeTransaction(t.signed.sigma_serialize_bytes()));
    const anchor = latest, blockHeight = BigInt(anchor.height) + 1n;
    const blockRoot = profile.transactionsRoot(4n, views);
    const heightBytes = h => { const b = Buffer.alloc(8); b.writeBigUInt64BE(h); return b; };
    const syntheticHeader = (height, parentId, transactionsRoot) => ({ id: hex(sha256(Buffer.concat([Buffer.from("moe/experiment/ergo-publication/dry-run/header"), heightBytes(height), Buffer.from(parentId, "hex"), transactionsRoot]))),
      parentId, height: height.toString(), version: 4, transactionsRoot: hex(transactionsRoot) });
    const chain = [syntheticHeader(blockHeight, anchor.id, blockRoot)];
    for (let d = 1; d <= depth; d++) chain.push(syntheticHeader(blockHeight + BigInt(d), chain.at(-1).id, sha256(Buffer.from(`empty-${d}`))));
    const block = { height: blockHeight, headerId: Buffer.from(chain[0].id, "hex"), views, ids: Object.values(transactions).map(t => t.id) };
    const read = readBack(anchor.id, chain.map(headerView), [block], transactions);
    report = { status: "dry-run-no-submission", node: process.version, library, network: requests === 0 ? "none: /info and the signing context from the cache" : "GET only: /info and the signing context, now cached", nodeUrl, nodeInfo: info, requests,
      cacheDigest: digest.digest("hex"), signingContext: { heights: `${contextHeaders[0].height}-${latest.height}`, headerVersions: [...new Set(contextHeaders.map(h => h.version))] },
      wallet: describe(), publications: publicationSummary, layout,
      transactions: Object.fromEntries([...Object.entries(transactions), ["spend", spend]].map(([name, t]) => [name, summarize(t)])),
      syntheticBlock: { anchor: { height: anchor.height, id: anchor.id, real: true }, height: blockHeight.toString(), transactions: views.length, root: hex(blockRoot), depth,
        note: "the root varies between runs with the randomized proofs; the transaction ids do not" },
      readBack: read, files, limitations: [
        "Dry run: nothing was submitted or accepted by a node; the input is synthetic, the block and its headers after the real anchor are synthetic, and node acceptance, fees, the dust rule's enforcement and inclusion latency are not measured.",
        ...limitations] };
  } else {
    // Live: the state file records every step so an interrupted run resumes, re-submitting only what the node does not hold.
    const tip = async () => { const i = JSON.parse(await get("/info")); return { height: i.fullHeight, id: i.bestFullHeaderId }; };
    const inclusion = async txId => {
      try {
        const found = JSON.parse(await get(`/blockchain/transaction/byId/${txId}`));
        if (found.inclusionHeight === undefined || found.inclusionHeight === null) return undefined;
        return { inclusionHeight: found.inclusionHeight, blockId: found.blockId, blockTimestamp: found.timestamp, index: found.index, numConfirmations: found.numConfirmations };
      } catch (error) { if (error.status === 404) return undefined; throw error; }
    };
    const heldByNode = async txId => {
      try { await get(`/transactions/unconfirmed/byTransactionId/${txId}`); return true; } catch (error) { if (error.status !== 404) throw error; }
      return (await inclusion(txId)) !== undefined;
    };
    const submit = async transaction => {
      const before = await tip(), submittedAt = new Date().toISOString();
      let response;
      try { response = await http("POST", "/transactions", transaction.json, false); }
      catch (error) {
        // Neither a lost response nor a refusal of a transaction the node already holds (a resumed run re-submitting
        // an unrecorded case byte for byte) is a refusal; the recorded submission time is then this attempt's.
        if (await heldByNode(transaction.id)) return { accepted: true, submittedAt, tipAtSubmit: before.height, tipIdAtSubmit: before.id, alreadyHeld: true, response: String(error.message).slice(0, 200) };
        return { accepted: false, submittedAt, tipAtSubmit: before.height, error: String(error.message).slice(0, 400) };
      }
      assert.equal(JSON.parse(response), transaction.id, "the node returns the submitted transaction's id");
      return { accepted: true, submittedAt, tipAtSubmit: before.height, tipIdAtSubmit: before.id };
    };
    // Each wait has its own deadline.
    const waitFor = async (what, condition) => {
      const deadline = Date.now() + maxWaitMinutes * 60000;
      for (;;) {
        const result = await condition();
        if (result !== undefined) return result;
        assert(Date.now() < deadline, `timed out waiting for ${what}`);
        console.error(`  waiting for ${what}`);
        await sleep(pollSeconds * 1000);
      }
    };
    const record = (name, transaction, submission) => {
      state.transactions[name] = { ...summarize(transaction), json: transaction.json, submission };
      if (!state.order.includes(name)) state.order.push(name);
      save();
    };
    const unspentAt = async address => {
      const boxes = JSON.parse(await http("POST", `/blockchain/box/unspent/byAddress?offset=0&limit=50`, JSON.stringify(address)));
      return boxes.map(({ boxId, value: v, ergoTree, assets, creationHeight: h, additionalRegisters, transactionId, index }) => ({ boxId, value: v, ergoTree, assets, creationHeight: h, additionalRegisters, transactionId, index }));
    };

    // The cases, chained: each spends the previous case's change, so the six can share a block, and the first
    // selects the whole run's cost from the wallet. A recorded case is rebuilt from its exact JSON; a recorded
    // refusal is dropped and rebuilt; the first unrecorded case takes the previous case's change.
    const rebuilt = {};
    let previous;
    for (const [i, spec] of cases.entries()) {
      let recorded = state.transactions[spec.name];
      if (recorded !== undefined && recorded.submission?.accepted !== true) {
        delete state.transactions[spec.name]; state.order = state.order.filter(name => name !== spec.name); save(); recorded = undefined;
      }
      let transaction;
      if (recorded !== undefined) transaction = { ...recorded, signed: sigma.Transaction.from_json(recorded.json) };
      else {
        let inputs;
        if (previous !== undefined) inputs = new sigma.ErgoBoxes(changeBox(previous));
        else {
          const unspent = await unspentAt(wallet.address);
          const balance = unspent.reduce((sum, box) => sum + BigInt(box.value), 0n);
          state.funding = { boxes: unspent.length, balance: balance.toString(), boxIds: unspent.map(box => box.boxId), runCost: runCost.toString() };
          save();
          assert(unspent.length > 0, `no unspent boxes at ${wallet.address}; fund the address with testnet ERG first`);
          assert(balance === runCost || balance >= runCost + minChange, `the wallet holds ${balance} nanoERG; the run needs ${runCost}, or at least ${runCost + minChange} to leave change above the dust minimum`);
          inputs = sigma.ErgoBoxes.from_boxes_json(unspent);
        }
        transaction = buildTransaction(spec.name, inputs, spec.outputs, costs.slice(i + 1).reduce((a, b) => a + b, 0n));
        console.error(`  submitting ${spec.name} (${transaction.bytes} bytes)`);
        let submission = await submit(transaction);
        if (!submission.accepted && previous !== undefined) {
          // A node that does not chain unconfirmed transactions accepts the same transaction once its parent is included.
          await waitFor(`inclusion of ${previous.name}`, () => inclusion(previous.id));
          submission = { firstAttempt: submission, ...(await submit(transaction)) };
        }
        record(spec.name, transaction, submission);
        assert(submission.accepted, `${spec.name} was not accepted: ${submission.error}`);
      }
      rebuilt[spec.name] = transaction; previous = transaction;
    }
    // Inclusion of every case, then the spend of every piece box once the cases are witnessed under the depth.
    for (const name of cases.map(c => c.name)) {
      const entry = state.transactions[name];
      if (entry.inclusion === undefined) { entry.inclusion = await waitFor(`inclusion of ${name}`, () => inclusion(entry.id)); save(); }
    }
    const lastCaseHeight = Math.max(...cases.map(c => state.transactions[c.name].inclusion.inclusionHeight));
    await waitFor(`the depth over height ${lastCaseHeight}`, async () => (await tip()).height >= lastCaseHeight + depth ? true : undefined);
    if (state.transactions.spend?.submission?.accepted !== true) {
      const spend = buildTransaction("spend", pieceBoxes(cases.map(c => rebuilt[c.name])), ["sweep"]);
      console.error(`  submitting spend (${spend.bytes} bytes, ${spend.inputs.length} inputs)`);
      const submission = await submit(spend);
      record("spend", spend, submission);
      assert(submission.accepted, `the spend was not accepted: ${submission.error}`);
    }
    if (state.transactions.spend.inclusion === undefined) { state.transactions.spend.inclusion = await waitFor("inclusion of the spend", () => inclusion(state.transactions.spend.id)); save(); }
    const spendHeight = state.transactions.spend.inclusion.inclusionHeight;
    await waitFor(`the depth over height ${spendHeight}`, async () => (await tip()).height >= spendHeight + depth ? true : undefined);

    // The UTXO view after the spend: no piece box is served unspent, the indexed view names the spend for each, and
    // nothing stands unspent at the publication location.
    const pieceIds = cases.flatMap(c => state.transactions[c.name].outputs.filter(r => r.role === "piece").map(r => r.boxId));
    const utxo = { checked: pieceIds.length, absent: 0, spentBy: 0 };
    for (const boxId of pieceIds) {
      try { await get(`/utxo/byId/${boxId}`); } catch (error) { if (error.status === 404) utxo.absent++; else throw error; }
      const indexed = JSON.parse(await get(`/blockchain/box/byId/${boxId}`));
      if (indexed.spentTransactionId === state.transactions.spend.id) utxo.spentBy++;
    }
    const unspentAtLocation = await unspentAt(publicationAddress.to_base58(TESTNET));
    assert.equal(utxo.absent, pieceIds.length, "no piece box is served unspent after the spend");
    assert.equal(utxo.spentBy, pieceIds.length, "the indexed view names the spend for every piece box");
    assert.equal(unspentAtLocation.length, 0, "nothing stands unspent at the publication location");

    // The read: the anchor is the header below the first inclusion; headers to the tip; every block through the last inclusion.
    const heights = [...cases.map(c => c.name), "spend"].map(name => state.transactions[name].inclusion.inclusionHeight);
    const firstHeight = Math.min(...heights), lastHeight = Math.max(...heights), anchorHeight = firstHeight - 1;
    const tipNow = await tip();
    const anchorIds = JSON.parse(await get(`/blocks/at/${anchorHeight}`));
    assert.equal(anchorIds.length, 1, "one header at the anchor height");
    const headers = [];
    for (let low = anchorHeight; low < tipNow.height; low += 1000) {
      const high = Math.min(low + 1000, tipNow.height);
      headers.push(...JSON.parse(await get(`/blocks/chainSlice?fromHeight=${low}&toHeight=${high}`)));
    }
    headers.sort((a, b) => a.height - b.height);
    assert.equal(headers[0].parentId, anchorIds[0], "the slice begins at the anchor's child");
    const blocks = [];
    for (const header of headers.filter(h => h.height <= lastHeight)) blocks.push(await sectionOf(header));
    const transactionsByCase = Object.fromEntries(cases.map(c => [c.name, { id: state.transactions[c.name].id }]));
    const read = readBack(anchorIds[0], headers.map(headerView), blocks, transactionsByCase);
    // The spend is in the window too: its outputs are one plain box at the wallet and the fee, no object.
    assert(blocks.some(b => b.ids.includes(state.transactions.spend.id)), "the spend's block is in the window");

    const order = [...cases.map(c => c.name), "spend"];
    const latency = order.map(name => {
      const t = state.transactions[name], s = t.submission, inc = t.inclusion;
      return { name, id: t.id, bytes: t.bytes, submittedAt: s.submittedAt, tipAtSubmit: s.tipAtSubmit, inclusionHeight: inc.inclusionHeight, blockTimestamp: inc.blockTimestamp,
        blocksToInclusion: inc.inclusionHeight - s.tipAtSubmit, secondsToInclusion: Math.round((inc.blockTimestamp - Date.parse(s.submittedAt)) / 1000),
        positionInBlock: inc.index, alreadyHeld: s.alreadyHeld === true, firstAttemptRejected: s.firstAttempt !== undefined ? s.firstAttempt.error : null };
    });
    // A transaction the node already held when a resumed run re-submitted it has no honest submission time.
    const blocksTo = latency.filter(l => !l.alreadyHeld).map(l => l.blocksToInclusion).sort((a, b) => a - b);
    report = { status: "testnet-published-and-read-back", node: process.version, library, nodeUrl, nodeInfo: info, requests, cacheDigest: digest.digest("hex"),
      wallet: { ...describe(), funding: state.funding }, publications: publicationSummary, layout,
      transactions: Object.fromEntries(order.map(name => { const { json, ...rest } = state.transactions[name]; return [name, rest]; })),
      latency: { perTransaction: latency, blocksToInclusion: { min: blocksTo[0] ?? null, median: blocksTo[Math.floor(blocksTo.length / 2)] ?? null, max: blocksTo.at(-1) ?? null, samples: blocksTo.length },
        independentSubmissionTimes: new Set(latency.map(l => l.tipAtSubmit)).size, lag: depth + 1,
        note: "blocksToInclusion is the inclusion height less the node's full height at submission; the cases are chained and submitted together, so their latencies are one correlated observation, and the sweep another; the profile's lag is depth + 1 and a publication submitted at clock c must land in (c, c + lag] to have force at c + lag" },
      window: { anchorHeight, anchorId: anchorIds[0], firstHeight, lastHeight, tipHeight: tipNow.height, depth, headers: headers.length,
        blocks: blocks.map(b => ({ height: b.height.toString(), transactions: b.transactions, sectionBytes: b.sectionBytes, refused: b.refused })) },
      utxoAfterSpend: { ...utxo, unspentAtPublicationLocation: unspentAtLocation.length },
      readBack: read, files, limitations };
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}
const text = JSON.stringify(report, null, 2);
if (out !== undefined) writeFileSync(resolve(root, out), text + "\n");
console.log(text);
