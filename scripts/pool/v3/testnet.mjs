// Explicit live-testnet harness support. Reader trust inputs are held beside
// the keys, outside the evidence package; no funding secret enters a reader.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { ErgoVenue, ergoAnchorContext } from "../../../dist/ergo.js";
import { parseErgoHeader } from "../../../dist/ergo-headers.js";
import { ERGO_TESTNET_REFERENCE, MINER_FEE_TREE_HEX, ownErgoProfile } from "../../../dist/ergo-profile.js";
import { DEFAULT_ERGO_FEE, ErgoPublisher, ergoNodePublisher, payToPublicKeyTree, readPlainBox, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { MempoolNode, plainBox } from "../../../dist/ergo-synthetic.js";
import { ergoNodeSupplier, parseNodeJson } from "../../../dist/ergo-supplier.js";
import { decodeRangeAnswer } from "../../../dist/record-range.js";
import { encodeCommitment } from "../../../dist/venue-records.js";
import { recordReader, RANGE_LIMITS } from "./local-replay.mjs";

export const TESTNET_ENDPOINT = "http://127.0.0.1:9052";
export const TESTNET_DEPTH = 2n;
export const TESTNET_EVIDENCE_KIND = "ergo-venue-live-testnet";
export const TESTNET_LIMITS = Object.freeze({ requestMs: 30_000, responseBytes: 64 * 1024 * 1024,
  maxBlocks: 4096, publicationWaitMs: 1_200_000, runMs: 7_200_000, workerMs: 300_000, pollMs: 10_000 });
const policy = Object.freeze({ headersPerSupplier: TESTNET_LIMITS.maxBlocks, headersPerRequest: 500,
  sideHeadersPerSupplier: TESTNET_LIMITS.maxBlocks, sectionBytesPerSync: 256 * 1024 * 1024,
  retainedBytes: 64 * 1024 * 1024, supplierTimeoutMs: TESTNET_LIMITS.requestMs });
const hex = bytes => Buffer.from(bytes).toString("hex");
const bytes = text => { assert.match(text, /^[0-9a-f]{64}$/); return new Uint8Array(Buffer.from(text, "hex")); };
const pause = () => new Promise(resolve => setTimeout(resolve, TESTNET_LIMITS.pollMs));
const supplierFor = () => ergoNodeSupplier(TESTNET_ENDPOINT, { name: "own live testnet node",
  timeoutMs: TESTNET_LIMITS.requestMs, maxResponseBytes: TESTNET_LIMITS.responseBytes });

export async function testnetInfo() {
  const response = await fetch(`${TESTNET_ENDPOINT}/info`, { signal: AbortSignal.timeout(TESTNET_LIMITS.requestMs) });
  assert(response.ok, "testnet info unavailable");
  // /info is tiny; bound its body as well as every header/section response.
  const reader = response.body.getReader(), chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > 1_048_576) { await reader.cancel(); throw new Error("testnet info budget"); }
    chunks.push(value);
  }
  const info = parseNodeJson(Buffer.concat(chunks).toString("utf8"));
  assert(info instanceof Map); assert.equal(info.get("network"), "testnet"); assert.equal(info.get("appVersion"), "6.0.6");
  assert(typeof info.get("fullHeight") === "bigint" && info.get("fullHeight") >= 1027n);
  assert(typeof info.get("headersHeight") === "bigint" && info.get("headersHeight") >= info.get("fullHeight") &&
    info.get("headersHeight") - info.get("fullHeight") <= TESTNET_DEPTH, "own testnet node is not synced");
  return info;
}

function profileAt(anchor) {
  const location = kind => payToPublicKeyTree(secp256k1.getPublicKey(
    createHash("sha256").update(`moe/experiment/pool-v3-testnet/location/${kind}`).digest(), true));
  return ownErgoProfile({ reference: ERGO_TESTNET_REFERENCE, anchor, depth: TESTNET_DEPTH,
    scripts: { 1: location(1), 2: location(2), 3: location(3), 4: location(4) } });
}
async function headerAt(supplier, height) {
  const headers = await supplier.headers(height, height);
  assert.equal(headers.length, 1, "testnet header unavailable");
  const header = parseErgoHeader(headers[0]); assert(header && header.height === height);
  return header;
}
async function anchorReadback(supplier, profile, height) {
  assert.equal(hex((await headerAt(supplier, height)).id), hex(profile.anchor), "testnet anchor left the current chain");
}

/** Validate the harness-owned file, reconstruct the fixed scripts/profile. */
export function readTestnetSelection(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(data.schema, "moe-v3-testnet-reader-1"); assert.equal(data.endpoint, TESTNET_ENDPOINT);
  assert.equal(data.depth, "2"); assert.equal(data.context, ERGO_TESTNET_REFERENCE);
  assert.match(data.anchorHeight, /^[0-9]+$/); assert.match(data.judgingIndex, /^[0-9]+$/);
  const anchorHeight = BigInt(data.anchorHeight), judgingIndex = BigInt(data.judgingIndex);
  assert(anchorHeight >= 1025n && judgingIndex < BigInt(TESTNET_LIMITS.maxBlocks - 3));
  const profile = profileAt(bytes(data.anchor));
  return { profile, anchorHeight, judgingIndex,
    ...(data.withheldHeader === undefined ? {} : { withheldHeader: bytes(data.withheldHeader) }) };
}

/** The same actual node adapter for positive and hostile readers. Pin and
 * withholding choices are reader-owned, never accepted from IPC/package data. */
export async function testnetRecord(selection, pin) {
  const venue = await testnetVenue(selection, pin);
  return venue === undefined ? undefined : recordReader(venue, TESTNET_EVIDENCE_KIND);
}

/** A fresh runtime venue at the independently held reader selection and pin. */
export async function testnetVenue(selection, pin) {
  assert(pin instanceof Uint8Array && pin.length === 32);
  const { profile, anchorHeight, judgingIndex, withheldHeader } = selection;
  const supplier = supplierFor();
  await testnetInfo(); await anchorReadback(supplier, profile, anchorHeight);
  const context = await ergoAnchorContext(supplier, profile.anchor, anchorHeight);
  const tip = anchorHeight + 1n + judgingIndex + profile.depth;
  const capped = { name: supplier.name, tipHeight: async () => tip,
    headers: (from, to) => supplier.headers(from, to < tip ? to : tip),
    section: id => withheldHeader !== undefined && hex(id) === hex(withheldHeader) ? Promise.resolve(undefined) : supplier.section(id) };
  const venue = new ErgoVenue(profile, context, policy);
  const synced = await venue.sync([capped]);
  if (synced.witnessedHeaderId === undefined || hex(synced.witnessedHeaderId) !== hex(pin) ||
      synced.witnessedIndex !== judgingIndex || synced.unresolvedIndex !== undefined) return undefined;
  return venue;
}

/** The retained testnet wallet's secret (scratch/ergo-testnet/wallet.json), checked against its tree. */
export function testnetWalletKey() {
  const wallet = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../scratch/ergo-testnet/wallet.json"), "utf8"));
  assert.equal(wallet.network, "testnet");
  const secretKey = bytes(wallet.secretHex);
  assert.equal(hex(payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true))), wallet.ergoTree);
  return secretKey;
}

const vlq = n => { const out = []; do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n); return Uint8Array.from(out); };
const cat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const scalar = value => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
const toBig = value => BigInt(`0x${hex(value)}`);
/** A proveDlog proof of `message` (the publisher's layout: 24-byte challenge, 32-byte response), checked by the
 * runtime's verifyErgoProof before it is used. */
function proveDlog(secretKey, message) {
  const publicKey = secp256k1.getPublicKey(secretKey, true), x = toBig(secretKey), n = secp256k1.CURVE.n;
  const proposition = cat([0x10, 0x01, 0x08, 0xcd], publicKey, [0x73, 0x00]);
  for (;;) {
    const r = toBig(secp256k1.utils.randomPrivateKey()), a = secp256k1.ProjectivePoint.BASE.multiply(r).toRawBytes(true);
    const e = blake2b(cat([1, 0, proposition.length], proposition, [0, a.length], a, message), { dkLen: 32 }).subarray(0, 24);
    const proof = cat(e, scalar((r + toBig(e) * x) % n));
    if (verifyErgoProof(publicKey, message, proof)) return proof;
  }
}

/** A sweep leaves a key's boxes where they total no more than the fee and this. */
export const SWEEP_DUST = 1_000_000n;

/**
 * Build and sign a plain transfer from `secretKey`'s pay-to-public-key boxes (`boxBytes`, serialized, as a node
 * lists them; other boxes and boxes above `height` are left out): `outputs` and change back to the key, or with
 * `sweepTo` every box (at most 60) to that tree; the default fee to the miners, every output at `height`. The signed
 * bytes are replayed on an offline mempool funded with the inputs, which checks the id, each proof and the balance,
 * before they are returned. Undefined when a sweep finds only dust.
 */
export function buildPlainTransfer(secretKey, boxBytes, { outputs = [], sweepTo, height }) {
  assert((outputs.length > 0) !== (sweepTo !== undefined), "a transfer pays outputs or sweeps, not both");
  assert(typeof height === "bigint" && height > 0n);
  const tree = payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true));
  const boxes = boxBytes.map(bytes => ({ bytes, box: readPlainBox(bytes, tree) }))
    .filter(entry => entry.box !== undefined && entry.box.creationHeight <= height)
    .sort((a, b) => (a.box.value < b.box.value ? 1 : a.box.value > b.box.value ? -1 : 0));
  const paid = outputs.reduce((sum, output) => sum + output.value, 0n);
  let inputs = [], total = 0n;
  if (sweepTo !== undefined) inputs = boxes.slice(0, 60);
  else for (const entry of boxes) { if (total >= paid + DEFAULT_ERGO_FEE + SWEEP_DUST) break; inputs.push(entry); total += entry.box.value; }
  total = inputs.reduce((sum, entry) => sum + entry.box.value, 0n);
  if (sweepTo !== undefined && total <= DEFAULT_ERGO_FEE + SWEEP_DUST) return undefined;
  assert(inputs.length > 0 && inputs.length <= 60, "testnet transfer inputs");
  const pay = sweepTo !== undefined ? [{ tree: sweepTo, value: total - DEFAULT_ERGO_FEE }]
    : [...outputs, { tree, value: total - paid - DEFAULT_ERGO_FEE }];
  assert(pay.every(output => output.value >= SWEEP_DUST), "testnet transfer covers its outputs, the fee and change");
  const candidate = output => cat(vlq(output.value), output.tree, vlq(height), [0, 0]);
  const body = cat(vlq(0n), vlq(0n), vlq(BigInt(pay.length + 1)), ...pay.map(candidate),
    candidate({ tree: Buffer.from(MINER_FEE_TREE_HEX, "hex"), value: DEFAULT_ERGO_FEE }));
  const unsigned = cat(vlq(BigInt(inputs.length)), ...inputs.map(entry => cat(entry.box.id, vlq(0n), [0])), body);
  const signed = cat(vlq(BigInt(inputs.length)), ...inputs.map(entry => { const proof = proveDlog(secretKey, unsigned);
    return cat(entry.box.id, vlq(BigInt(proof.length)), proof, [0]); }), body);
  return { id: blake2b(unsigned, { dkLen: 32 }), signed, inputs: inputs.map(entry => entry.bytes),
    spentNanoErg: sweepTo !== undefined ? total : paid + DEFAULT_ERGO_FEE };
}
/** Replay a built transfer offline over exactly its inputs: the node's checks of ids, proofs and balance. */
export async function replayTransfer(built) {
  const shadow = new MempoolNode("testnet transfer shadow", verifyErgoProof);
  for (const bytes of built.inputs) shadow.fund(bytes);
  await shadow.submit(built.signed, built.id);
}

/** Wait until the node's extra index has read every full block, so its box listing misses no mined box. */
export async function testnetIndexed() {
  const deadline = Date.now() + TESTNET_LIMITS.publicationWaitMs;
  for (;;) {
    const response = await fetch(`${TESTNET_ENDPOINT}/blockchain/indexedHeight`, { signal: AbortSignal.timeout(TESTNET_LIMITS.requestMs) });
    const { indexedHeight, fullHeight } = await response.json();
    if (Number.isSafeInteger(indexedHeight) && indexedHeight >= fullHeight) return BigInt(fullHeight);
    assert(Date.now() < deadline, "testnet index wait budget"); await pause();
  }
}
/** The confirmations the node's index counts for a transaction, 0 while it is unconfirmed or unknown. */
export async function testnetConfirmations(id) {
  const response = await fetch(`${TESTNET_ENDPOINT}/blockchain/transaction/byId/${id}`, { signal: AbortSignal.timeout(TESTNET_LIMITS.requestMs) });
  if (response.status === 404) return 0;
  assert(response.ok, `testnet transaction ${id}: ${response.status}`);
  const confirmations = (await response.json()).numConfirmations;
  return Number.isSafeInteger(confirmations) ? confirmations : 0;
}

/**
 * Live drills only: a plain transfer (buildPlainTransfer) over the own testnet node's listing of the key's boxes,
 * read once the index has caught up, replayed offline, then submitted. Returns the transaction id (hex) and what left
 * the key, or undefined when a sweep finds only dust.
 */
export async function testnetTransfer(secretKey, { outputs = [], sweepTo } = {}) {
  await testnetInfo();
  const height = await testnetIndexed(), node = ergoNodePublisher(TESTNET_ENDPOINT);
  const built = buildPlainTransfer(secretKey, await node.unspentBoxes(payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true))),
    { outputs, sweepTo, height });
  if (built === undefined) return undefined;
  await replayTransfer(built);
  await node.submit(built.signed, built.id);
  return { id: hex(built.id), spentNanoErg: String(built.spentNanoErg) };
}

/** Offline: transfers built for an offline mempool pay, chain on unconfirmed change, sweep, and keep their floors. */
export async function checkPlainTransfer() {
  const keyA = new Uint8Array(32).fill(21), keyB = new Uint8Array(32).fill(22), tree = key => payToPublicKeyTree(secp256k1.getPublicKey(key, true));
  const node = new MempoolNode("offline transfer check", verifyErgoProof), worth = key => [...node.boxes.values()]
    .reduce((sum, box) => sum + (readPlainBox(box, tree(key))?.value ?? 0n), 0n);
  node.fund(plainBox(tree(keyA), 5_000_000_000n, 10n)); node.fund(plainBox(tree(keyA), 2_000_000n, 30n));
  const send = async (key, options) => {
    const built = buildPlainTransfer(key, await node.unspentBoxes(tree(key)), options);
    if (built !== undefined) { await replayTransfer(built); await node.submit(built.signed, built.id); }
    return built;
  };
  await send(keyA, { outputs: [{ tree: tree(keyB), value: 1_000_000_000n }], height: 20n });
  assert.equal(worth(keyB), 1_000_000_000n);
  // The box above the height was left out; the payment chains on the first one's change.
  await send(keyA, { outputs: [{ tree: tree(keyB), value: 500_000_000n }], height: 20n });
  assert.equal(worth(keyA), 5_002_000_000n - 1_500_000_000n - 2n * DEFAULT_ERGO_FEE);
  await send(keyB, { sweepTo: tree(keyA), height: 40n });
  assert.equal(worth(keyB), 0n);
  assert.equal(worth(keyA), 5_002_000_000n - 3n * DEFAULT_ERGO_FEE);
  assert.equal(await send(keyB, { sweepTo: tree(keyA), height: 40n }), undefined, "nothing left to sweep");
  assert.throws(() => buildPlainTransfer(keyA, [...node.boxes.values()], { outputs: [{ tree: tree(keyB), value: 6_000_000_000n }], height: 40n }),
    /covers its outputs/);
  const built = buildPlainTransfer(keyA, [...node.boxes.values()], { outputs: [{ tree: tree(keyB), value: 1n << 20n }], height: 40n });
  const altered = new Uint8Array(built.signed); altered[altered.length - 1] ^= 1;
  await assert.rejects(replayTransfer({ ...built, signed: altered }));
  return { status: "passed", checks: ["pay", "box above the height left out", "chained pay", "sweep", "dust sweep", "uncovered outputs", "altered bytes"] };
}

/** Live writer, only constructed by store-check --testnet. */
export async function openTestnet({ authorizeSubmission } = {}) {
  assert(authorizeSubmission === undefined || typeof authorizeSubmission === "function");
  const started = Date.now(), info = await testnetInfo(), supplier = supplierFor();
  const anchorHeight = info.get("fullHeight") - TESTNET_DEPTH;
  const anchor = await headerAt(supplier, anchorHeight), profile = profileAt(anchor.id);
  const context = await ergoAnchorContext(supplier, profile.anchor, anchorHeight);
  await anchorReadback(supplier, profile, anchorHeight);
  const secretKey = testnetWalletKey();
  const submitted = [], nodePublisher = ergoNodePublisher(TESTNET_ENDPOINT);
  const counting = { name: nodePublisher.name, unspentBoxes: tree => nodePublisher.unspentBoxes(tree), hasBox: id => nodePublisher.hasBox(id),
    submit: async (signed, id) => {
      if (authorizeSubmission !== undefined) await authorizeSubmission({ signed: new Uint8Array(signed), id: new Uint8Array(id),
        tree: publisher.tree, boxes: await nodePublisher.unspentBoxes(publisher.tree) });
      submitted.push(hex(id)); return nodePublisher.submit(signed, id);
    } };
  const publisher = new ErgoPublisher({ secretKey, suppliers: [counting] });
  const venue = new ErgoVenue(profile, context, policy, publisher);
  let last;
  async function sync() {
    assert(Date.now() - started < TESTNET_LIMITS.runMs, "testnet run time budget");
    const full = (await testnetInfo()).get("fullHeight");
    assert(full - anchorHeight < BigInt(TESTNET_LIMITS.maxBlocks), "testnet header budget");
    await anchorReadback(supplier, profile, anchorHeight);
    // The full tip, not the possibly-ahead header tip, bounds available sections.
    last = await venue.sync([{ name: supplier.name, tipHeight: async () => full,
      headers: (from, to) => supplier.headers(from, to < full ? to : full), section: id => supplier.section(id) }]);
    assert.equal(last.unresolvedIndex, undefined, "live testnet section unavailable");
    return last;
  }
  const bootstrapDeadline = Date.now() + TESTNET_LIMITS.publicationWaitMs;
  while ((await sync()).witnessedHeaderId === undefined) {
    assert(Date.now() < bootstrapDeadline, "testnet first witnessed block wait budget"); await pause();
  }
  return { venue, profile, publisher, submitted, anchorHeight, context, sync,
    reference: { context: ERGO_TESTNET_REFERENCE, profile },
    get pin() { return last.witnessedHeaderId; },
    get tipHeight() { return last.tipHeight; },
    selection() { return { profile, anchorHeight, judgingIndex: venue.witnessedIndex() }; },
    readerConfig() { return { schema: "moe-v3-testnet-reader-1", endpoint: TESTNET_ENDPOINT,
      context: ERGO_TESTNET_REFERENCE, depth: profile.depth.toString(), anchor: hex(profile.anchor),
      anchorHeight: anchorHeight.toString(), judgingIndex: venue.witnessedIndex().toString() }; },
    headerId: async index => (await headerAt(supplier, anchorHeight + 1n + index)).id,
    async waitUntil(index) {
      assert(typeof index === "bigint" && index >= 0n);
      const deadline = Date.now() + TESTNET_LIMITS.publicationWaitMs;
      for (;;) {
        await sync(); if (venue.witnessedIndex() >= index) return;
        assert(Date.now() < deadline, "testnet witnessed index wait budget"); await pause();
      }
    },
    async waitForRecord(kind, subject, bytes) {
      const deadline = Date.now() + TESTNET_LIMITS.publicationWaitMs, encoded = hex(bytes);
      for (;;) {
        await sync();
        const request = { venue: venue.id, kind, subject, fromIndex: 0n, toIndex: venue.witnessedIndex() };
        const answer = decodeRangeAnswer(venue.range(request, RANGE_LIMITS), request, RANGE_LIMITS);
        const entry = answer.entries.find(entry => hex(entry.record) === encoded);
        if (entry !== undefined) return entry.index;
        assert(Date.now() < deadline, "testnet record inclusion and depth wait budget"); await pause();
      }
    },
    async waitFor(commitment) {
      const deadline = Date.now() + TESTNET_LIMITS.publicationWaitMs, encoded = hex(encodeCommitment(commitment));
      for (;;) {
        await sync();
        const request = { venue: venue.id, kind: 1, subject: commitment.operator, fromIndex: 0n, toIndex: venue.witnessedIndex() };
        const answer = decodeRangeAnswer(venue.range(request, RANGE_LIMITS), request, RANGE_LIMITS);
        if (answer.entries.some(entry => hex(entry.record) === encoded)) return;
        assert(Date.now() < deadline, "testnet commitment inclusion and depth wait budget"); await pause();
      }
    } };
}
