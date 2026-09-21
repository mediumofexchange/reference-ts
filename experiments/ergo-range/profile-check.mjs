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
import { Address, Constant, ErgoTree } from "ergo-lib-wasm-nodejs";
import { decodeTransaction } from "./decoder.mjs";

const here = import.meta.dirname, root = resolve(here, "../..");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
const manifest = JSON.parse(readFileSync(join(here, "fixtures/manifest.json")));
let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert(value, message); checks++; };
// Node 24's source text keeps the fixtures' large integers exact.
const parseFixture = raw => JSON.parse(raw, (_key, value, context) => {
  if (typeof value !== "number") return value;
  assert.match(context.source, /^-?\d+$/);
  return BigInt(context.source);
});

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
  const b = (n, width = 32) => Buffer.alloc(width, n);

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

  // The real genesis header, pinned, as an anchor: the chain's first header is at height 1 with a zero
  // parent id, and a profile anchored at it indexes the chain from height 2, its child. The anchor alone
  // reaches no index; a chain through the child witnesses index 0 at depth 0, and index 0 needs its section.
  const [genesisPin] = manifest.headers;
  const genesisRaw = readFileSync(join(here, genesisPin.file));
  equal(hex(sha256(genesisRaw)), genesisPin.sha256, "genesis header pin before parsing");
  const genesis = parseFixture(genesisRaw.toString("utf8"));
  equal([genesis.height, genesis.version, genesis.id, genesis.parentId], [1n, 1n, genesisPin.headerId, "00".repeat(32)],
    "the pinned genesis header is at height 1 with a zero parent id");
  const genesisView = { id: Buffer.from(genesis.id, "hex"), parentId: Buffer.from(genesis.parentId, "hex"), height: genesis.height,
    version: genesis.version, transactionsRoot: Buffer.from(genesis.transactionsRoot, "hex") };
  const anchored = { anchor: genesisView.id, depth: 0n, scripts }, anchoredId = profile.ergoProfileIdentity(anchored);
  equal(profile.ergoRangeVerifier(anchored, { headers: [genesisView], blocks: [] }), undefined, "the anchor alone reaches no index");
  // A synthetic child of the real genesis: one plain transaction, its root computed as the node would.
  const childTx = { inputs: [{ boxId: hex(sha256("child-of-genesis")), spendingProof: { proofBytes: "", extension: {} } }], dataInputs: [],
    outputs: [{ value: 1000000n, ergoTree: hex(p2pk(5)), creationHeight: 2, assets: [], additionalRegisters: {} }] };
  const childRoot = oracleRoot(3n, [childTx]);
  const childView = { id: sha256(Buffer.concat([Buffer.from("2"), childRoot, genesisView.id])), parentId: genesisView.id, height: 2n, version: 3n, transactionsRoot: childRoot };
  const atOrigin = profile.ergoRangeVerifier(anchored, { headers: [genesisView, childView], blocks: [] });
  ok(atOrigin !== undefined, "the real genesis header anchors a chain through its child");
  equal(atOrigin.witnessedIndex(), 0n, "the child, height 2, is index 0 and is witnessed at depth 0");
  equal(atOrigin.range({ venue: anchoredId, kind: 2, subject: b(17), fromIndex: 0n, toIndex: 0n }, wide), undefined, "index 0 needs its section");
  const withOrigin = profile.ergoRangeVerifier(anchored, { headers: [genesisView, childView],
    blocks: [{ headerId: childView.id, transactions: [decodeTransaction(serializeTransaction(childTx).toBytes())] }] });
  equal(withOrigin.range({ venue: anchoredId, kind: 2, subject: b(17), fromIndex: 0n, toIndex: 0n }, wide).length, 102,
    "index 0 answers empty from its section by exhaustion");
  equal(profile.ergoRangeVerifier({ ...anchored, anchor: b(1) }, { headers: [genesisView, childView], blocks: [] }), undefined, "another anchor refuses the real header");

  // Synthetic contiguous chain with real signed records in register constants.
  const vlq = n => { const out = []; do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; out.push(byte); } while (n > 0); return Buffer.from(out); };
  const coll = bytes => "0e" + hex(vlq(bytes.length)) + hex(bytes);
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
  // The chain's first header is the anchor, so height h is index h - 2.
  const candidate = { anchor: chain.headers[0].id, depth, scripts };
  const identity = profile.ergoProfileIdentity(candidate);
  const verifier = profile.ergoRangeVerifier(candidate, chain);
  ok(verifier !== undefined, "model root agrees with the independent oracle on every synthetic block");
  equal(verifier.witnessedIndex(), heights - depth - 2n, "witnessed index is the tip less the depth less the origin");
  equal(verifier.lag(), depth + 1n, "lag is the depth plus one");
  const t = verifier.witnessedIndex();
  const ask = (kind, subject, fromIndex = 0n, toIndex = t, from = verifier) => {
    const request = { venue: identity, kind, subject, fromIndex, toIndex }, bytes = from.range(request, wide);
    return bytes === undefined ? undefined : { bytes, answer: range.decodeRangeAnswer(bytes, request, wide) };
  };
  const answers = {};
  const commitments = ask(1, operator);
  equal(commitments.answer.entries.map(e => e.index), [0n, 1n, 2n, 2n, 6n, 8n], "every object at the location is carried, junk included");
  const held = range.heldCommitments(commitments.answer);
  equal(held.held.map(h => [h.index, h.commitment.sequence]), [[0n, 1n], [2n, 2n], [2n, 3n], [6n, 4n], [8n, 5n]], "held by sequence, junk disregarded");
  answers.commitments = commitments.bytes.length;
  const replacements = ask(2, backing);
  const admitted = range.admittedReplacements(replacements.answer, rule);
  equal(admitted.map(a => a.index), [1n], "one admitted replacement");
  const walk = range.replacementChain(admitted, { backing, original: operator, lag: verifier.lag(), now: t });
  equal([walk.chain.length, walk.pending?.from], [1, 40n], "lead floor met; the successor is pending at the reading index");
  answers.replacements = replacements.bytes.length;
  const revocations = ask(3, obligor);
  equal([range.revocationIndex(revocations.answer), revocations.answer.entries.length], [4n, 2], "revoked at the first witnessing; the copy is carried");
  equal(range.revocationIndex(ask(3, obligor, 0n, 3n).answer), undefined, "not revoked through 3");
  answers.revocations = revocations.bytes.length;
  const publicationsX = ask(4, backing), publicationsY = ask(4, backingY);
  const merged = range.mergeVenueOrder([publicationsX.answer, publicationsY.answer]);
  equal(merged.map(e => [e.index, e.ordinal.toString(16), e.record.length]),
    [[2n, "100000000", 40], [3n, "100000000", 120], [3n, "100000004", 40], [5n, "0", 7800]], "venue order by transaction then output; runs reassembled");
  equal(hex(merged[1].record), hex(Buffer.concat([piece(2), piece(3), piece(4)])), "pieces in output order");
  equal(hex(merged[3].record), hex(Buffer.concat([piece(6, 3900), piece(7, 3900)])), "two 3900-byte pieces");
  answers.publications = publicationsX.bytes.length + publicationsY.bytes.length;
  const empty = ask(1, other, 0n, 3n);
  equal(empty.bytes.length, 102, "authenticated empty answer");
  equal(range.heldCommitments(ask(1, other, 4n, 4n).answer, { fromIndex: 4n, highest: 0n }).held.map(h => h.commitment.sequence), [7n], "the other operator at 4");
  equal(ask(1, operator, 0n, t + 1n), undefined, "no answer above the witnessed index");
  equal(verifier.range({ venue: b(12), kind: 1, subject: operator, fromIndex: 0n, toIndex: t }, wide), undefined, "no answer for another venue");
  assert.throws(() => verifier.range({ venue: identity, kind: 1, subject: operator, fromIndex: 0n, toIndex: t }, { maxBytes: 300n, maxEntries: 8n }), range.RangeLimitError); checks++;

  // Hostile evidence: a flipped byte inside a record still decodes, as another transaction whose id fails the
  // block's root, so output bytes are bound to the header through the decoder's id and that height has no
  // section; a truncated transaction fails the strict decode and is unsupported evidence; a broken link fails
  // the chain; stray, duplicate and root-failing blocks beside the true sections change no answer.
  const original = txBytesAt.get(4n)[0], flipped = Buffer.from(original); flipped[flipped.length - 20] ^= 1;
  const reread = decodeTransaction(flipped);
  ok(reread !== undefined && hex(reread.id) !== hex(chain.blocks[3].transactions[0].id), "a flipped record byte is another transaction");
  const twin = { ...chain.blocks[3], transactions: [reread, chain.blocks[3].transactions[1]] };
  const damaged = profile.ergoRangeVerifier(candidate, { headers: chain.headers, blocks: chain.blocks.map((block, i) => (i === 3 ? twin : block)) });
  equal(ask(1, operator, 0n, t, damaged), undefined, "the flipped section fails its root, so ranges through index 2 (height 4) are unresolved");
  ok(ask(1, operator, 3n, t, damaged) !== undefined, "ranges past the damaged index answer");
  equal(decodeTransaction(original.subarray(0, original.length - 1)), undefined, "a truncated transaction does not decode");
  const noisy = profile.ergoRangeVerifier(candidate, { headers: chain.headers,
    blocks: [twin, { headerId: b(9), transactions: chain.blocks[0].transactions }, { headerId: chain.headers[2].id, transactions: [{ id: b(1), witnessId: b(1), outputs: [] }] },
      ...chain.blocks, chain.blocks[5]] });
  equal(hex(ask(1, operator, 0n, t, noisy).bytes), hex(commitments.bytes), "a root-failing twin, a stray block, a malformed block and a duplicate change no answer");
  const unlinked = { ...chain, headers: chain.headers.map((h, i) => (i === 5 ? { ...h, parentId: b(0) } : h)) };
  equal(profile.ergoRangeVerifier(candidate, unlinked), undefined, "an unlinked header is no chain");
  const partial = profile.ergoRangeVerifier(candidate, { headers: chain.headers, blocks: chain.blocks.filter((_block, i) => i !== 6) });
  equal(ask(4, backing, 0n, t, partial), undefined, "a missing block leaves the range unresolved");
  ok(ask(4, backing, 6n, t, partial) !== undefined, "ranges without the gap answer");
  equal(profile.ergoRangeVerifier({ ...candidate, anchor: b(1) }, chain), undefined, "another anchor is another venue");
  equal(profile.ergoRangeVerifier(candidate, { headers: chain.headers.slice(2), blocks: chain.blocks }), undefined, "a chain without the anchor's child gives no verifier");
  equal(hex(ask(1, operator, 0n, t, profile.ergoRangeVerifier(candidate, { headers: chain.headers.slice(1), blocks: chain.blocks })).bytes), hex(commitments.bytes),
    "a chain from the anchor's child answers the same; the genesis block below it is not read");

  // Real fixtures: one-block ranges at depth 0, each block index 0 under its own parent as the anchor. The model's
  // root reproduces the node's header roots for block versions 1 and 3 from decoder-derived ids; every real
  // register constant is decoded beside sigma-rust's own constant decoder; exhaustion over every output
  // attributes nothing at four throwaway locations.
  const sdkIndex = value => { assert(value >= 0n && value <= 0x7fffffffn); return Number(value); };
  const fixtures = [], registers = { total: 0, collByte: 0, other: 0 };
  for (const fixture of manifest.fixtures) {
    const raw = readFileSync(join(here, fixture.file));
    equal(hex(sha256(raw)), fixture.sha256, "fixture pin before parsing");
    const block = parseFixture(raw.toString("utf8")), { header } = block;
    const txs = block.blockTransactions.transactions.map(t => ({ ...t, outputs: t.outputs.map(o => ({ ...o, creationHeight: sdkIndex(o.creationHeight), index: sdkIndex(o.index) })) }));
    const decoded = txs.map(t => decodeTransaction(serializeTransaction(t).toBytes()));
    ok(decoded.every(d => d !== undefined), "every fixture transaction decodes");
    decoded.forEach((d, i) => equal(hex(d.id), txs[i].id, "decoded id equals the node's"));
    for (const d of decoded) for (const output of d.outputs) for (const value of Object.values(output.registers)) {
      const constant = Constant.decode_from_base16(hex(value));
      try {
        equal(hex(constant.sigma_serialize_bytes()), hex(value), "a real register constant reserializes exactly");
        const ours = profile.collBytes(value);
        registers.total++;
        if (constant.dbg_tpe() === "SColl(SByte)") { equal(hex(ours), hex(constant.to_byte_array()), "Coll[Byte] bytes equal sigma-rust's"); registers.collByte++; }
        else { equal(ours, undefined, "a constant of another type is not the shape"); registers.other++; }
      } finally { constant.free(); }
    }
    const view = { id: Buffer.from(header.id, "hex"), parentId: Buffer.from(header.parentId, "hex"), height: header.height, version: header.version,
      transactionsRoot: Buffer.from(header.transactionsRoot, "hex") };
    const fixtureProfile = { anchor: view.parentId, depth: 0n, scripts };
    const single = profile.ergoRangeVerifier(fixtureProfile, { headers: [view], blocks: [{ headerId: view.id, transactions: decoded }] });
    const request = { venue: profile.ergoProfileIdentity(fixtureProfile), kind: 1, subject: b(0), fromIndex: 0n, toIndex: 0n };
    ok(single !== undefined && single.range(request, wide) !== undefined, "the model reproduces the real transaction root, so the index has its section");
    equal(single.witnessedIndex(), 0n, "the block after the anchor is index 0, witnessed at depth 0");
    equal(single.range(request, wide).length, 102, "exhaustion over the real block answers empty at four throwaway locations");
    const outputs = decoded.reduce((n, d) => n + d.outputs.length, 0);
    equal(String(outputs), String(txs.reduce((n, t) => n + t.outputs.length, 0)), "every output scanned");
    fixtures.push({ height: fixture.height, version: fixture.version, transactions: fixture.transactions, outputs: String(outputs),
      headerWireBytes: header.size.toString(), rootReproduced: true, emptyAnswerBytes: 102 });
  }
  ok(registers.collByte > 0 && registers.other > 0, "the register oracle saw both shapes");

  // Capacity under the profile's layout: the largest R5 piece whose box stays within the 4,096-byte box
  // limit with its 34 bytes of transaction id and index, and the most such boxes one transaction carries
  // under the pinned node's 98,304-byte mempool policy. The largest publication a configuration can
  // produce is fixed by its pinned proof size (pool-v3 §11.1); 14,656 bytes is every retained relation's.
  const chunkTx = (k, n) => ({ inputs: [{ boxId: "11".repeat(32), spendingProof: { proofBytes: "", extension: {} } }], dataInputs: [],
    outputs: Array.from({ length: k }, () => ({ value: 1000000n, ergoTree: hex(scripts[4]), creationHeight: 2000000, assets: [],
      additionalRegisters: { R4: coll(backing), R5: coll(b(9, n)) } })) });
  const txSize = (k, n) => { try { return serializeTransaction(chunkTx(k, n)).toBytes().length; } catch { return Infinity; } };
  const boxBytes = n => txSize(2, n) - txSize(1, n) + 34;
  let pieceBytes = 4000; while (boxBytes(pieceBytes) > 4096) pieceBytes--;
  ok(boxBytes(pieceBytes) <= 4096 && boxBytes(pieceBytes + 1) > 4096, "the largest piece is exact");
  let pieces = 1; while (txSize(pieces + 1, pieceBytes) <= 98304) pieces++;
  const payloadCapacity = pieces * pieceBytes, observedProofBytes = 14656, statement = n => 58 + 32 * n;
  const publication = { release: 92 + statement(17) + 4 + observedProofBytes + 4 + 136 + 4, demand: 92 + statement(16) + 4 + observedProofBytes + 4 + 4,
    request: 92 + statement(7) + 4 + observedProofBytes + 4 + 4 };
  ok(publication.release > publication.demand && publication.demand > publication.request, "the release is the largest publication");
  ok(publication.release <= payloadCapacity, "the largest publication under the observed proof size fits one transaction");
  equal(Math.ceil(publication.release / pieceBytes), 4, "a release is four pieces");
  const largestProofThatFits = payloadCapacity - (92 + statement(17) + 4 + 4 + 136 + 4);
  ok(largestProofThatFits > observedProofBytes && largestProofThatFits < 131072, "the capacity lies between the observed proof and pool-v2 §12's ceiling");

  Object.assign(report, {
    status: "offline-profile-candidate-only", node: process.version, checks,
    profile: { context: profile.ERGO_PROFILE_CONTEXT, identity: hex(identity), depth: depth.toString(), lag: verifier.lag().toString(),
      locations: Object.fromEntries(Object.entries(scripts).map(([kind, script]) => [kind, hex(script)])) },
    sources: manifest.sources, inputManifestSha256: hex(sha256(readFileSync(join(here, "fixtures/manifest.json")))),
    files: Object.fromEntries(["experiments/ergo-range/profile-check.mjs", "experiments/ergo-range/decoder.mjs", "experiments/ergo-range/package.json", "experiments/ergo-range/package-lock.json",
      "model/pool-v3-ergo-profile.ts", "model/pool-v3-range.ts"].map(file => [file, fileHash(file)])),
    genesisAnchor: { height: genesis.height.toString(), version: genesis.version.toString(), id: genesis.id, parentIdZero: true,
      headerWireBytes: genesis.size.toString(), indexZeroHeight: "2", emptyAnswerBytesAtIndexZero: 102 },
    synthetic: { heights: heights.toString(), witnessedIndex: t.toString(), transactions: String(transactions), serializedTransactionBytes: String(serializedBytes),
      headers: String(chain.headers.length), answerBytes: answers, heldCommitments: held.held.length, mergedPublications: merged.length },
    fixtures, registerConstants: registers,
    capacity: { maxBoxBytes: 4096, mempoolMaxTransactionBytes: 98304, maxPieceBytes: pieceBytes, piecesPerTransaction: pieces,
      transactionBytes: txSize(pieces, pieceBytes), payloadCapacity, observedProofBytes, releasePublicationBytes: publication.release,
      releasePieces: Math.ceil(publication.release / pieceBytes), demandPublicationBytes: publication.demand, requestPublicationBytes: publication.request,
      largestProofThatFits, frameCeiling: range.MAX_RANGE_RECORD_BYTES[4],
      note: "a kind-4 object is one transaction's run of outputs; a configuration is publishable here only where its largest publication fits one transaction" },
    limitations: [
      "Headers are the reader's own source: linkage, contiguity and the anchor's child are checked; proof of work, chain selection and finality are not.",
      "A transaction the reader's decoder refuses is unsupported evidence: its height has no section and every range through it stays unresolved until the decoder is repaired, a denial one node-valid transaction can trigger.",
      "Synthetic blocks are serialized by Fleet from local objects and were never accepted by a node; the fixtures are three non-contiguous real blocks and the real genesis header.",
      "sigma-rust's strict round trip is the decoder boundary; it has no hard memory limit and no node-equivalence proof (see the decoder probe).",
      "No range from index zero was read on a real chain from a real anchor; the cost of exhaustion over real block bytes is not measured here.",
      "Capacity is measured by serialization against the box limit and the pinned mempool policy; no transaction was relayed or accepted by a node.",
      "No runtime path, spec selection, publication, chunking on a node or C2.10.13 completeness claim for any real venue follows.",
    ] });
} finally {
  rmSync(build, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
