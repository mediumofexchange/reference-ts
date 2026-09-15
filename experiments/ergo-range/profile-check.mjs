// Offline venue-profile candidate check: pool-v3 §13 answers over full-block
// evidence. Fleet serializes synthetic transactions from locally built
// objects and hash-pinned fixtures; sigma-rust decodes the exact bytes after
// a strict round trip; the model verifier attributes, reassembles and answers.
// Nothing here reads a network, a node or a runtime path, and no answer is
// evidence: the retained report is an observation about fixed inputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b";
import { serializeTransaction } from "@fleet-sdk/serializer";
import { Address, ErgoTree, Transaction } from "ergo-lib-wasm-nodejs";

const here = import.meta.dirname, root = resolve(here, "../..");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json")));
let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert(value, message); checks++; };

// The model is compiled from source into a disposable build, as the local replay does.
mkdirSync(join(root, "scratch"), { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "ergo-range-profile-")));
const url = pathToFileURL(build + sep).href;
const report = {};
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
  const range = await import(new URL("model/pool-v3-range.js", url));
  const { signCommitment, encodeCommitment } = await import(new URL("src/commitment.js", url));
  const { encodeReplacement, replacementMessage, ROLE_OPERATOR } = await import(new URL("src/replacement.js", url));
  const { encodeRevocation, signRevocation } = await import(new URL("src/revocation.js", url));
  const wide = { maxBytes: 1n << 40n, maxEntries: 1n << 20n };

  // Locations: four distinct pay-to-public-key trees of throwaway keys. A
  // deployment chooses its own; the identity binds whichever it names.
  const p2pk = n => Address.from_public_key(secp256k1.getPublicKey(new Uint8Array(32).fill(n), true)).to_ergo_tree().sigma_serialize_bytes();
  const scripts = { 1: p2pk(1), 2: p2pk(2), 3: p2pk(3), 4: p2pk(4) }, plainTree = p2pk(5);
  for (const script of [...Object.values(scripts), plainTree]) {
    const parsedTree = ErgoTree.from_bytes(script);
    equal(hex(parsedTree.sigma_serialize_bytes()), hex(script), "location parses as an ErgoTree");
    parsedTree.free();
    equal(script.length, 36, "pay-to-public-key tree");
  }

  // The reader's own decoder: strict round trip, then fields from the parsed bytes only.
  const decodeTransaction = bytes => {
    let tx;
    try { tx = Transaction.sigma_parse_bytes(bytes); } catch { return undefined; }
    try {
      if (hex(tx.sigma_serialize_bytes()) !== hex(bytes)) return undefined;
      const js = tx.to_js_eip12();
      const proofs = js.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"));
      return { id: Buffer.from(js.id, "hex"), witnessId: blake2b(Buffer.concat(proofs), { dkLen: 32 }).subarray(1),
        outputs: js.outputs.map(output => ({ ergoTree: Buffer.from(output.ergoTree, "hex"),
          registers: Object.fromEntries(Object.entries(output.additionalRegisters).map(([name, value]) => [name, Buffer.from(value, "hex")])) })) };
    } finally { tx.free(); }
  };
  // Independent oracle from check.mjs: Fleet's unsigned bytes and the node's root algorithm.
  const unsignedBytes = tx => serializeTransaction({ ...tx, inputs: tx.inputs.map(input => ({ boxId: input.boxId, extension: input.spendingProof.extension })) }).toBytes();
  const fleetId = tx => blake2b(unsignedBytes(tx), { dkLen: 32 });
  const fleetWitness = tx => blake2b(Buffer.concat(tx.inputs.map(input => Buffer.from(input.spendingProof.proofBytes, "hex"))), { dkLen: 32 }).subarray(1);
  const merkle = leaves => {
    let level = leaves.map(leaf => blake2b(Buffer.concat([Buffer.from([0]), leaf]), { dkLen: 32 }));
    do {
      const next = [];
      for (let i = 0; i < level.length; i += 2) next.push(blake2b(Buffer.concat([Buffer.from([1]), level[i], level[i + 1] ?? Buffer.alloc(0)]), { dkLen: 32 }));
      level = next;
    } while (level.length > 1);
    return level[0];
  };
  const oracleRoot = (version, txs) => merkle(version === 1n ? txs.map(fleetId) : [...txs.map(fleetId), ...txs.map(fleetWitness)]);

  // Synthetic contiguous chain with real signed records in register constants.
  const vlq = n => { const out = []; do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; out.push(byte); } while (n > 0); return Buffer.from(out); };
  const coll = bytes => "0e" + hex(vlq(bytes.length)) + hex(bytes);
  const b = (n, width = 32) => Buffer.alloc(width, n);
  const operatorSecret = b(29), operator = ed25519.getPublicKey(operatorSecret);
  const otherSecret = b(31), other = ed25519.getPublicKey(otherSecret);
  const ruleSecret = b(37), rule = ed25519.getPublicKey(ruleSecret);
  const obligorSecret = b(41), obligor = ed25519.getPublicKey(obligorSecret);
  const backing = b(17), backingY = b(18);
  const commitment = (sequence, secret = operatorSecret) => encodeCommitment(signCommitment(secret, sequence, b(Number(sequence) + 60)));
  const replacement = effective => {
    const fields = { role: ROLE_OPERATOR, successor: other, predecessor: backing, effective };
    const message = replacementMessage(backing, { ...fields, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) });
    return encodeReplacement(backing, { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, otherSecret) });
  };
  const revocation = encodeRevocation(signRevocation(obligorSecret));
  const junk = Buffer.concat([Buffer.from(commitment(2n)).subarray(0, 8), b(1), operator, b(0, 64)]);
  const piece = (n, length = 40) => b(n, length);
  let counter = 0;
  const box = (tree, registers = {}) => ({ value: 1000000n, ergoTree: hex(tree), creationHeight: 1, assets: [], additionalRegisters: registers });
  const record = (kind, subject, bytes) => box(scripts[kind], { R4: coll(subject), R5: coll(bytes) });
  const plain = () => box(plainTree);
  const tx = (outputs, proofs = [""]) => ({
    inputs: proofs.map((proofBytes, i) => ({ boxId: hex(sha256(`in-${counter++}-${i}`)), spendingProof: { proofBytes, extension: {} } })),
    dataInputs: [], outputs });
  const spec = {
    2: [tx([plain(), record(1, operator, commitment(1n))])],
    3: [tx([record(2, backing, replacement(40n)), record(1, operator, junk)])],
    4: [tx([record(1, operator, commitment(3n)), record(1, operator, commitment(2n))]), tx([record(4, backing, piece(1))])],
    5: [tx([plain()]), tx([record(4, backing, piece(2)), record(4, backing, piece(3)), record(4, backing, piece(4)), plain(), record(4, backingY, piece(5))])],
    6: [tx([record(3, obligor, revocation)]), tx([record(3, obligor, revocation), record(1, other, commitment(7n, otherSecret))])],
    7: [tx([record(4, backing, piece(6, 3900)), record(4, backing, piece(7, 3900))])],
    8: [tx([record(1, operator, commitment(4n))], [hex(b(0x5a, 56)), hex(b(0xa5, 56))])],
    10: [tx([record(1, operator, commitment(5n))])],
    11: [tx([record(1, operator, commitment(6n))])],
  };
  const heights = 12n, depth = 2n, version = 3n;
  let serializedBytes = 0, transactions = 0;
  const chain = { headers: [], blocks: [] }, txBytesAt = new Map();
  let parentId = Buffer.alloc(32);
  for (let height = 1n; height <= heights; height++) {
    const txs = spec[height] ?? [tx([plain()])];
    const bytes = txs.map(t => serializeTransaction(t).toBytes());
    const decoded = bytes.map(decodeTransaction);
    ok(decoded.every(d => d !== undefined), "every synthetic transaction decodes after an exact round trip");
    decoded.forEach((d, i) => {
      equal(hex(d.id), hex(fleetId(txs[i])), "decoder id equals Fleet's unsigned-bytes hash");
      equal(hex(d.witnessId), hex(fleetWitness(txs[i])), "31-byte witness id from the decoded proofs");
    });
    const transactionsRoot = oracleRoot(version, txs);
    const id = sha256(Buffer.concat([Buffer.from(height.toString()), transactionsRoot, parentId]));
    chain.headers.push({ id, parentId, height, version, transactionsRoot });
    chain.blocks.push({ headerId: id, transactions: decoded });
    txBytesAt.set(height, bytes);
    serializedBytes += bytes.reduce((n, x) => n + x.length, 0); transactions += txs.length;
    parentId = id;
  }
  const candidate = { genesis: chain.headers[0].id, depth, scripts };
  const identity = profile.ergoProfileIdentity(candidate);
  const verifier = profile.ergoRangeVerifier(candidate, chain);
  ok(verifier !== undefined, "model root agrees with the independent oracle on every synthetic block");
  equal(verifier.witnessedIndex(), heights - depth, "witnessed index is the tip less the depth");
  equal(verifier.lag(), depth + 1n, "lag is the depth plus one");
  const t = verifier.witnessedIndex();
  const ask = (kind, subject, fromIndex = 0n, toIndex = t) => {
    const request = { venue: identity, kind, subject, fromIndex, toIndex }, bytes = verifier.range(request, wide);
    return bytes === undefined ? undefined : { bytes, answer: range.decodeRangeAnswer(bytes, request, wide) };
  };
  const answers = {};
  const commitments = ask(1, operator);
  equal(commitments.answer.entries.map(e => e.index), [2n, 3n, 4n, 4n, 8n, 10n], "every object at the location is carried, junk included");
  const held = range.heldCommitments(commitments.answer);
  equal(held.held.map(h => [h.index, h.commitment.sequence]), [[2n, 1n], [4n, 2n], [4n, 3n], [8n, 4n], [10n, 5n]], "held by sequence, junk disregarded");
  answers.commitments = commitments.bytes.length;
  const replacements = ask(2, backing);
  const admitted = range.admittedReplacements(replacements.answer, rule);
  equal(admitted.map(a => a.index), [3n], "one admitted replacement");
  const walk = range.replacementChain(admitted, { backing, original: operator, lag: verifier.lag(), now: t });
  equal([walk.chain.length, walk.pending?.from], [1, 40n], "lead floor met; the successor is pending at the reading index");
  answers.replacements = replacements.bytes.length;
  const revocations = ask(3, obligor);
  equal([range.revocationIndex(revocations.answer), revocations.answer.entries.length], [6n, 2], "revoked at the first witnessing; the copy is carried");
  equal(range.revocationIndex(ask(3, obligor, 0n, 5n).answer), undefined, "not revoked through 5");
  answers.revocations = revocations.bytes.length;
  const publicationsX = ask(4, backing), publicationsY = ask(4, backingY);
  const merged = range.mergeVenueOrder([publicationsX.answer, publicationsY.answer]);
  equal(merged.map(e => [e.index, e.ordinal.toString(16), e.record.length]),
    [[4n, "100000000", 40], [5n, "100000000", 120], [5n, "100000004", 40], [7n, "0", 7800]], "venue order by transaction then output; runs reassembled");
  equal(hex(merged[1].record), hex(Buffer.concat([piece(2), piece(3), piece(4)])), "pieces in output order");
  equal(hex(merged[3].record), hex(Buffer.concat([piece(6, 3900), piece(7, 3900)])), "two 3900-byte pieces");
  answers.publications = publicationsX.bytes.length + publicationsY.bytes.length;
  const empty = ask(1, other, 0n, 5n);
  equal(empty.bytes.length, 102, "authenticated empty answer");
  equal(range.heldCommitments(ask(1, other, 6n, 6n).answer, { fromIndex: 6n, highest: 0n }).held.map(h => h.commitment.sequence), [7n], "the other operator at 6");
  equal(ask(1, operator, 0n, t + 1n), undefined, "no answer above the witnessed index");
  equal(verifier.range({ venue: b(12), kind: 1, subject: operator, fromIndex: 0n, toIndex: t }, wide), undefined, "no answer for another venue");
  assert.throws(() => verifier.range({ venue: identity, kind: 1, subject: operator, fromIndex: 0n, toIndex: t }, { maxBytes: 300n, maxEntries: 8n }), range.RangeLimitError); checks++;

  // Hostile evidence: a flipped byte inside a record still decodes, as another transaction whose id fails the
  // block's root, so output bytes are bound to the header through the decoder's id; a truncated transaction
  // fails the strict decode and is unsupported evidence; a broken link fails the chain.
  const original = txBytesAt.get(4n)[0], flipped = Buffer.from(original); flipped[flipped.length - 20] ^= 1;
  const reread = decodeTransaction(flipped);
  ok(reread !== undefined && hex(reread.id) !== hex(chain.blocks[3].transactions[0].id), "a flipped record byte is another transaction");
  const substituted = { headers: chain.headers, blocks: chain.blocks.map((block, i) => (i === 3 ? { ...block, transactions: [reread, block.transactions[1]] } : block)) };
  equal(profile.ergoRangeVerifier(candidate, substituted), undefined, "the flipped transaction fails its block's root");
  equal(decodeTransaction(original.subarray(0, original.length - 1)), undefined, "a truncated transaction does not decode");
  const unlinked = { ...chain, headers: chain.headers.map((h, i) => (i === 5 ? { ...h, parentId: b(0) } : h)) };
  equal(profile.ergoRangeVerifier(candidate, unlinked), undefined, "an unlinked header is no chain");
  const gapped = { headers: chain.headers, blocks: chain.blocks.filter((_block, i) => i !== 6) };
  const partial = profile.ergoRangeVerifier(candidate, gapped);
  equal(partial.range({ venue: identity, kind: 4, subject: backing, fromIndex: 0n, toIndex: t }, wide), undefined, "a missing block leaves the range unresolved");
  ok(partial.range({ venue: identity, kind: 4, subject: backing, fromIndex: 8n, toIndex: t }, wide) instanceof Uint8Array, "ranges without the gap answer");
  equal(profile.ergoRangeVerifier({ ...candidate, genesis: b(1) }, chain), undefined, "another genesis is another venue");

  // Real fixtures: one-block ranges at depth 0. The model's root reproduces the node's header roots for block
  // versions 1 and 3 from decoder-derived ids, and exhaustion over every output attributes nothing.
  const parseFixture = raw => JSON.parse(raw, (_key, value, context) => {
    if (typeof value !== "number") return value;
    assert.match(context.source, /^-?\d+$/);
    return BigInt(context.source);
  });
  const sdkIndex = value => { assert(value >= 0n && value <= 0x7fffffffn); return Number(value); };
  const fixtures = [];
  for (const fixture of manifest.fixtures) {
    const raw = readFileSync(join(here, fixture.file));
    equal(hex(sha256(raw)), fixture.sha256, "fixture pin before parsing");
    const block = parseFixture(raw.toString("utf8")), { header } = block;
    const txs = block.blockTransactions.transactions.map(t => ({ ...t, outputs: t.outputs.map(o => ({ ...o, creationHeight: sdkIndex(o.creationHeight), index: sdkIndex(o.index) })) }));
    const decoded = txs.map(t => decodeTransaction(serializeTransaction(t).toBytes()));
    ok(decoded.every(d => d !== undefined), "every fixture transaction decodes");
    decoded.forEach((d, i) => equal(hex(d.id), txs[i].id, "decoded id equals the node's"));
    const view = { id: Buffer.from(header.id, "hex"), parentId: Buffer.from(header.parentId, "hex"), height: header.height, version: header.version,
      transactionsRoot: Buffer.from(header.transactionsRoot, "hex") };
    const fixtureProfile = { genesis: b(0), depth: 0n, scripts };
    const single = profile.ergoRangeVerifier(fixtureProfile, { headers: [view], blocks: [{ headerId: view.id, transactions: decoded }] });
    ok(single !== undefined, "the model reproduces the real transaction root");
    equal(single.witnessedIndex(), header.height, "witnessed at depth 0");
    const request = { venue: profile.ergoProfileIdentity(fixtureProfile), kind: 1, subject: b(0), fromIndex: header.height, toIndex: header.height };
    equal(single.range(request, wide).length, 102, "exhaustion over the real block answers empty");
    equal(profile.attributeBlock(fixtureProfile, decoded).length, 0, "no fixture output is at a location");
    const outputs = decoded.reduce((n, d) => n + d.outputs.length, 0);
    equal(String(outputs), String(txs.reduce((n, t) => n + t.outputs.length, 0)), "every output scanned");
    fixtures.push({ height: fixture.height, version: fixture.version, transactions: fixture.transactions, outputs: String(outputs),
      headerWireBytes: header.size.toString(), rootReproduced: true, emptyAnswerBytes: 102 });
  }

  Object.assign(report, {
    status: "offline-profile-candidate-only", node: process.version, checks,
    profile: { context: profile.ERGO_PROFILE_CONTEXT, identity: hex(identity), depth: depth.toString(), lag: verifier.lag().toString(),
      locations: Object.fromEntries(Object.entries(scripts).map(([kind, script]) => [kind, hex(script)])) },
    sources: manifest.sources, inputManifestSha256: hex(sha256(readFileSync(join(here, "fixtures/manifest.json")))),
    files: Object.fromEntries(["experiments/ergo-range/profile-check.mjs", "experiments/ergo-range/package.json", "experiments/ergo-range/package-lock.json",
      "model/pool-v3-ergo-profile.ts", "model/pool-v3-range.ts"].map(file => [file, fileHash(file)])),
    synthetic: { heights: heights.toString(), witnessedIndex: t.toString(), transactions: String(transactions), serializedTransactionBytes: String(serializedBytes),
      headers: String(chain.headers.length), answerBytes: answers, heldCommitments: held.held.length, mergedPublications: merged.length },
    fixtures,
    ergoBounds: { maxBoxBytes: 4096, mempoolMaxTransactionBytes: 98304, kind4RecordBound: range.MAX_RANGE_RECORD_BYTES[4],
      note: "a kind-4 object is one transaction's run of outputs, so a publication above what one transaction carries has no location here" },
    limitations: [
      "Headers are the reader's own source: linkage, contiguity and the genesis anchor are checked; proof of work, chain selection and finality are not.",
      "Synthetic blocks are serialized by Fleet from local objects and were never accepted by a node; the fixtures are three non-contiguous real blocks.",
      "sigma-rust's strict round trip is the decoder boundary; it has no hard memory limit and no node-equivalence proof (see the decoder probe).",
      "No range from index zero was read on a real chain; the cost of exhaustion over real block bytes is not measured here.",
      "No runtime path, spec selection, publication, chunking on a node or C2.10.13 completeness claim for any real venue follows.",
    ] });
} finally {
  rmSync(build, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
