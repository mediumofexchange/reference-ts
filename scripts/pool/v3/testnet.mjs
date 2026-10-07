// Live-testnet support for the command drill (command-drill.mjs --testnet
// --authorized-testnet): the own node's state and plain transfers from the
// retained testnet wallet. `--check` checks the transfers offline, without a
// node or wallet.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { MINER_FEE_TREE_HEX } from "../../../dist/ergo-profile.js";
import { DEFAULT_ERGO_FEE, ergoNodePublisher, payToPublicKeyTree, readPlainBox, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { MempoolNode, plainBox } from "../../../dist/ergo-synthetic.js";
import { parseNodeJson } from "../../../dist/ergo-supplier.js";

export const TESTNET_ENDPOINT = "http://127.0.0.1:9052";
export const TESTNET_DEPTH = 2n;
export const TESTNET_LIMITS = Object.freeze({ requestMs: 30_000, publicationWaitMs: 1_200_000, pollMs: 10_000 });
const hex = bytes => Buffer.from(bytes).toString("hex");
const bytes = text => { assert.match(text, /^[0-9a-f]{64}$/); return new Uint8Array(Buffer.from(text, "hex")); };
const pause = () => new Promise(resolve => setTimeout(resolve, TESTNET_LIMITS.pollMs));

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
 * The live command drill only: a plain transfer (buildPlainTransfer) over the own testnet node's listing of the key's boxes,
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  assert.deepEqual(process.argv.slice(2), ["--check"], "testnet.mjs runs only its offline --check");
  process.stdout.write(JSON.stringify(await checkPlainTransfer()) + "\n");
}
