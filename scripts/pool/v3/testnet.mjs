// Explicit live-testnet harness support. Reader trust inputs are held beside
// the keys, outside the evidence package; no funding secret enters a reader.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ErgoVenue, ergoAnchorContext } from "../../../dist/ergo.js";
import { parseErgoHeader } from "../../../dist/ergo-headers.js";
import { ERGO_TESTNET_REFERENCE, ownErgoProfile } from "../../../dist/ergo-profile.js";
import { ErgoPublisher, ergoNodePublisher, payToPublicKeyTree } from "../../../dist/ergo-publisher.js";
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
  return recordReader(venue, TESTNET_EVIDENCE_KIND);
}

/** Live writer, only constructed by store-check --testnet. */
export async function openTestnet() {
  const started = Date.now(), info = await testnetInfo(), supplier = supplierFor();
  const anchorHeight = info.get("fullHeight") - TESTNET_DEPTH;
  const anchor = await headerAt(supplier, anchorHeight), profile = profileAt(anchor.id);
  const context = await ergoAnchorContext(supplier, profile.anchor, anchorHeight);
  await anchorReadback(supplier, profile, anchorHeight);
  const wallet = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../scratch/ergo-testnet/wallet.json"), "utf8"));
  assert.equal(wallet.network, "testnet");
  const secretKey = bytes(wallet.secretHex);
  assert.equal(hex(payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true))), wallet.ergoTree);
  const submitted = [], nodePublisher = ergoNodePublisher(TESTNET_ENDPOINT);
  const counting = { name: nodePublisher.name, unspentBoxes: tree => nodePublisher.unspentBoxes(tree), hasBox: id => nodePublisher.hasBox(id),
    submit: async (signed, id) => { submitted.push(hex(id)); return nodePublisher.submit(signed, id); } };
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
  return { venue, profile, publisher, submitted, anchorHeight, context,
    reference: { context: ERGO_TESTNET_REFERENCE, profile },
    get pin() { return last.witnessedHeaderId; },
    get tipHeight() { return last.tipHeight; },
    selection() { return { profile, anchorHeight, judgingIndex: venue.witnessedIndex() }; },
    readerConfig() { return { schema: "moe-v3-testnet-reader-1", endpoint: TESTNET_ENDPOINT,
      context: ERGO_TESTNET_REFERENCE, depth: profile.depth.toString(), anchor: hex(profile.anchor),
      anchorHeight: anchorHeight.toString(), judgingIndex: venue.witnessedIndex().toString() }; },
    headerId: async index => (await headerAt(supplier, anchorHeight + 1n + index)).id,
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
