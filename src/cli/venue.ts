// A `moe` directory's venue (slice 10 M10b, item 5): Ergo only, the synthetic
// reference chain for drills and the testnet reference context live.
//
// `venue.json` holds only the identity preimage (reference context, anchor id,
// depth, the four location trees) and the anchor height; the identity is
// derived from it and every command requires it to be the identity the terms
// name. The anchor's context (the anchor and the 1,024 headers below it) is
// kept in `anchor.json`, authenticated again by linkage to the anchor id each
// time a view opens. Each directory reads through its own node endpoints
// (`config.json`) with `ergoNodeSupplier`, publishes with `ergoNodePublisher`,
// and keeps its own view in `venue.db` (`ErgoVenueJournal`).
import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ERGO_DEPTH, ErgoVenue, ergoAnchorContext, type ErgoSyncReport } from "../ergo.js";
import { parseErgoHeader } from "../ergo-headers.js";
import { ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE, ergoProfileIdentity, MINER_FEE_TREE_HEX, ownErgoProfile, type ErgoProfile,
  type ErgoReferenceContext } from "../ergo-profile.js";
import { ErgoPublisher, ergoNodePublisher, payToPublicKeyTree, readPlainBox, verifyErgoProof, type ErgoPublisherPersistence,
  type ErgoPublishingSupplier } from "../ergo-publisher.js";
import { ErgoVenueJournal } from "../ergo-store.js";
import { ergoNodeSupplier, parseNodeJson, type ErgoSupplier } from "../ergo-supplier.js";
import { MempoolNode } from "../ergo-synthetic.js";
import type { RecordKind } from "../record-range.js";
import type { VenueReference } from "../pool/v3/guard.js";
import { CommandError, readJson, readOptional, readSecret, writeExclusive, writeReplace, type Directory } from "./common.js";

const KINDS: readonly RecordKind[] = [1, 2, 3, 4];
const NODE_TIMEOUT_MS = 30_000;

/** A venue file: the identity preimage and the anchor height. */
export interface VenueFile {
  readonly profile: ErgoProfile;
  readonly anchorHeight: bigint;
  readonly id: Uint8Array;
  readonly reference: VenueReference;
}

/** The JSON text of a venue file. */
export function venueText(profile: ErgoProfile, anchorHeight: bigint): string {
  return `${JSON.stringify({ schema: "moe-venue-1", context: profile.reference, anchor: bytesToHex(profile.anchor),
    anchorHeight: anchorHeight.toString(), depth: profile.depth.toString(),
    locations: KINDS.map(kind => bytesToHex(profile.scripts[kind])) }, null, 2)}\n`;
}

/** Read and check a venue file: one of the two reference contexts, an anchor, a depth and four distinct trees. */
export function parseVenue(value: unknown): VenueFile {
  const invalid = (): never => { throw new CommandError("INVALID", "the venue file is not a moe venue"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as { [key: string]: unknown };
  if (Object.keys(v).sort().join() !== "anchor,anchorHeight,context,depth,locations,schema" || v.schema !== "moe-venue-1") invalid();
  if (v.context !== ERGO_SYNTHETIC_REFERENCE && v.context !== ERGO_TESTNET_REFERENCE) {
    throw new CommandError("VENUE", "a moe venue is the synthetic or testnet reference context; mainnet stays disabled");
  }
  const hexOf = (x: unknown): Uint8Array => typeof x === "string" && /^(?:[0-9a-f]{2})+$/.test(x) ? hexToBytes(x) : invalid();
  const decimal = (x: unknown): bigint => typeof x === "string" && /^(0|[1-9][0-9]{0,18})$/.test(x) ? BigInt(x) : invalid();
  if (!Array.isArray(v.locations) || v.locations.length !== 4) invalid();
  const locations = (v.locations as unknown[]).map(hexOf);
  let profile: ErgoProfile;
  try {
    profile = ownErgoProfile({ reference: v.context as ErgoReferenceContext, anchor: hexOf(v.anchor), depth: decimal(v.depth),
      scripts: { 1: locations[0]!, 2: locations[1]!, 3: locations[2]!, 4: locations[3]! } });
  } catch { return invalid(); }
  const anchorHeight = decimal(v.anchorHeight);
  if (anchorHeight < 1025n) invalid();
  return { profile, anchorHeight, id: ergoProfileIdentity(profile),
    reference: { context: profile.reference as typeof ERGO_SYNTHETIC_REFERENCE, profile } };
}

/** The directory's venue, if it has one. */
export function ownVenue(directory: Directory): VenueFile | undefined {
  return readOptional(directory.file("venue.json")) === undefined ? undefined : parseVenue(readJson(directory.file("venue.json"), "venue.json"));
}
export function requireVenue(directory: Directory): VenueFile {
  const venue = ownVenue(directory);
  if (venue === undefined) throw new CommandError("ABSENT", "the directory has no venue: venue create, or init with --venue");
  return venue;
}

/** The directory's suppliers, one per endpoint, in its order. */
export function suppliers(directory: Directory): ErgoSupplier[] {
  if (directory.config.nodes.length === 0) throw new CommandError("ABSENT", "config.json names no node endpoint");
  return directory.config.nodes.map((url, i) => ergoNodeSupplier(url, { name: `node ${i + 1}`, timeoutMs: NODE_TIMEOUT_MS }));
}

/** The network and full height `/info` states, from the first endpoint that answers. */
async function nodeInfo(directory: Directory): Promise<{ readonly network: unknown; readonly fullHeight: bigint }> {
  for (const url of directory.config.nodes) {
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/info`, { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
      const text = await response.text();
      if (!response.ok || text.length > 1 << 20) continue;
      const info = parseNodeJson(text), height = info instanceof Map ? info.get("fullHeight") : undefined;
      if (info instanceof Map && typeof height === "bigint" && height >= 0n) return { network: info.get("network"), fullHeight: height };
    } catch { /* the next endpoint */ }
  }
  throw new CommandError("UNAVAILABLE", "no node endpoint answered /info");
}

/** The anchor's context from the first endpoint that supplies it. */
async function fetchContext(directory: Directory, anchor: Uint8Array, anchorHeight: bigint): Promise<Uint8Array[]> {
  for (const supplier of suppliers(directory)) {
    try { return await ergoAnchorContext(supplier, anchor, anchorHeight); } catch { /* the next endpoint */ }
  }
  throw new CommandError("UNAVAILABLE", "no node endpoint supplied the anchor's context");
}

/** Keep the anchor's context and check that the view takes it (the anchor's difficulty bound included). A kept
 * context that does not authenticate this anchor (an interrupted `venue create` that anchored elsewhere) is
 * fetched again and replaced. */
export async function keepContext(directory: Directory, venue: VenueFile): Promise<void> {
  if (readOptional(directory.file("anchor.json")) !== undefined) {
    try { new ErgoVenue(venue.profile, readContext(directory)); return; } catch { /* fetched again below */ }
  }
  const context = await fetchContext(directory, venue.profile.anchor, venue.anchorHeight);
  new ErgoVenue(venue.profile, context);
  writeReplace(directory.file("anchor.json"), `${JSON.stringify(context.map(bytesToHex))}\n`);
}
function readContext(directory: Directory): Uint8Array[] {
  const value = readJson(directory.file("anchor.json"), "anchor.json");
  if (!Array.isArray(value) || !value.every(x => typeof x === "string" && /^(?:[0-9a-f]{2})+$/.test(x))) {
    throw new CommandError("INVALID", "anchor.json is not a header list");
  }
  return value.map(x => hexToBytes(x as string));
}

/** One location tree per kind, from the creator's `location.key` (so the creator can collect the boxes' value). */
function locationTree(key: Uint8Array, kind: RecordKind): Uint8Array {
  for (let counter = 0; ; counter++) {
    const secret = sha256(new Uint8Array([...utf8ToBytes("moe/venue/location/v1"), kind, counter, ...key]));
    if (secp256k1.utils.isValidPrivateKey(secret)) return payToPublicKeyTree(secp256k1.getPublicKey(secret, true));
  }
}

/** `venue create`: anchor at the node's full height less the depth, under the synthetic context only when asked.
 * A rerun prints the existing file. */
export async function createVenue(directory: Directory, options: { readonly synthetic: boolean; readonly depth?: bigint }): Promise<{ readonly venue: VenueFile; readonly created: boolean }> {
  const existing = ownVenue(directory);
  if (existing !== undefined) return { venue: existing, created: false };
  const depth = options.depth ?? DEFAULT_ERGO_DEPTH, context = options.synthetic ? ERGO_SYNTHETIC_REFERENCE : ERGO_TESTNET_REFERENCE;
  // The headers decide what a reader accepts; the creator's own node's word only keeps a creator from naming the
  // context it did not mean (a difficulty-1 synthetic chain is also below the testnet context's bound).
  const { network, fullHeight: full } = await nodeInfo(directory);
  if (network !== (options.synthetic ? "synthetic" : "testnet")) {
    throw new CommandError("VENUE", options.synthetic ? "--synthetic is only for the synthetic node" : "the node is not a testnet node; pass --synthetic for the synthetic node");
  }
  if (full < depth + 1025n) throw new CommandError("UNAVAILABLE", "the node's chain is too short to anchor at that depth");
  const anchorHeight = full - depth;
  let anchor: Uint8Array | undefined;
  for (const supplier of suppliers(directory)) {
    try {
      const [bytes] = await supplier.headers(anchorHeight, anchorHeight), header = bytes === undefined ? undefined : parseErgoHeader(bytes);
      if (header?.height === anchorHeight) { anchor = header.id; break; }
    } catch { /* the next endpoint */ }
  }
  if (anchor === undefined) throw new CommandError("UNAVAILABLE", "no node endpoint supplied the anchor header");
  // A fresh location key, reused if an interrupted run left one.
  let key = readOptional(directory.file("location.key"));
  if (key === undefined) { key = new Uint8Array(randomBytes(32)); writeExclusive(directory.file("location.key"), key); }
  if (key.length !== 32) throw new CommandError("INVALID", "location.key is not 32 bytes");
  const profile = ownErgoProfile({ reference: context, anchor, depth,
    scripts: { 1: locationTree(key, 1), 2: locationTree(key, 2), 3: locationTree(key, 3), 4: locationTree(key, 4) } });
  const venue = parseVenue(JSON.parse(venueText(profile, anchorHeight)));
  await keepContext(directory, venue);
  writeExclusive(directory.file("venue.json"), venueText(profile, anchorHeight));
  return { venue, created: true };
}

/** The directory's own view, restored from `venue.db`, with an optional publisher attached later. */
export interface View {
  readonly file: VenueFile;
  readonly venue: ErgoVenue;
  readonly journal: ErgoVenueJournal;
  sync(): Promise<ErgoSyncReport>;
  close(): void;
}
export function openView(directory: Directory): View {
  const file = requireVenue(directory), journal = new ErgoVenueJournal(directory.file("venue.db"), file.id);
  try {
    const venue = new ErgoVenue(file.profile, readContext(directory), {}, undefined, journal), sources = suppliers(directory);
    return { file, venue, journal, sync: () => venue.sync(sources), close: () => journal.close() };
  } catch (error) { journal.close(); throw error; }
}

/** The directory's node endpoints as publishing suppliers, each submission first passing the spend budget. */
export function publishingSuppliers(directory: Directory, budget: SpendBudget): ErgoPublishingSupplier[] {
  return directory.config.nodes.map((url, i) => {
    const node = ergoNodePublisher(url, { name: `node ${i + 1}`, timeoutMs: NODE_TIMEOUT_MS });
    return Object.freeze({ name: node.name, unspentBoxes: (tree: Uint8Array) => node.unspentBoxes(tree), hasBox: (id: Uint8Array) => node.hasBox(id),
      hasTransaction: (id: Uint8Array) => node.hasTransaction(id),
      submit: async (signed: Uint8Array, id: Uint8Array) => { await budget.authorize(signed, id, await node.unspentBoxes(budget.tree)); return node.submit(signed, id); } });
  });
}

/** A funding directory's publisher over its `funding.key`. */
export function openPublisher(directory: Directory, persistence?: ErgoPublisherPersistence): { readonly publisher: ErgoPublisher; readonly budget: SpendBudget } {
  const secretKey = readSecret(directory.file("funding.key"), "funding.key");
  try {
    const budget = new SpendBudget(directory, payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true)));
    const publisher = new ErgoPublisher({ secretKey, suppliers: publishingSuppliers(directory, budget), ...(persistence === undefined ? {} : { persistence }) });
    return { publisher, budget };
  } finally { secretKey.fill(0); }
}

/** The funding tree of a 32-byte secp256k1 secret. */
export const fundingTree = (secret: Uint8Array): Uint8Array => payToPublicKeyTree(secp256k1.getPublicKey(secret, true));

/**
 * A funding directory's spend budget (`config.json`'s `spendBudgetNanoErg`, M10b item 6), as the live drills'
 * guard judges it: before each broadcast the signed transaction is replayed on an offline mempool funded with the
 * key's unspent boxes, and what it takes from the key (fees and record boxes' minimums) is reserved in `spend.db`
 * before it is sent, so a refused or uncertain broadcast keeps its reservation. A transaction past the budget is
 * refused (`BUDGET`); an exact resubmission of one already reserved passes.
 */
export class SpendBudget {
  private readonly db: DatabaseSync;
  private readonly limit: bigint;
  /** The last refusal, kept for the command: the publisher reads any supplier failure as "not taken", and the
   * journal reports that as UNAVAILABLE, which would hide the budget behind a node outage. */
  private refused: CommandError | undefined;
  constructor(directory: Directory, readonly tree: Uint8Array) {
    const limit = directory.config.spendBudgetNanoErg;
    if (limit === undefined) throw new CommandError("INVALID", "a funding directory's config.json carries spendBudgetNanoErg");
    this.limit = BigInt(limit);
    this.db = new DatabaseSync(directory.file("spend.db"), { timeout: 5000, readBigInts: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS spend (id TEXT PRIMARY KEY, signed TEXT NOT NULL, cost INTEGER NOT NULL CHECK(cost>=0)) STRICT;`);
  }
  /** What has been reserved so far, in nanoErg. */
  spent(): bigint { return (this.db.prepare("SELECT COALESCE(SUM(cost),0) AS n FROM spend").get()?.n as bigint) ?? 0n; }
  /** The refusal since the last call, if any, cleared. */
  take(): CommandError | undefined { const refused = this.refused; this.refused = undefined; return refused; }
  async authorize(signed: Uint8Array, id: Uint8Array, boxes: readonly Uint8Array[]): Promise<void> {
    try { await this.judge(signed, id, boxes); } catch (error) {
      if (error instanceof CommandError) this.refused = error;
      throw error;
    }
  }
  private async judge(signed: Uint8Array, id: Uint8Array, boxes: readonly Uint8Array[]): Promise<void> {
    const key = bytesToHex(id), digest = bytesToHex(sha256(signed));
    const prior = this.db.prepare("SELECT signed FROM spend WHERE id=?").get(key);
    if (prior !== undefined) {
      if (prior.signed !== digest) throw new CommandError("BUDGET", "a reserved transaction id names other bytes");
      return;
    }
    const shadow = new MempoolNode("spend budget", verifyErgoProof), fee = hexToBytes(MINER_FEE_TREE_HEX);
    for (const box of boxes) if (readPlainBox(box, this.tree) !== undefined) shadow.fund(box);
    const total = (tree: Uint8Array) => [...shadow.boxes.values()].reduce((sum, box) => sum + (readPlainBox(box, tree)?.value ?? 0n), 0n);
    const before = total(this.tree), feeBefore = total(fee);
    try { await shadow.submit(signed, id); } catch {
      // Not the budget: the node's listing of the key's boxes does not carry the transaction's inputs (an index
      // behind its mempool, or another spender); nothing is reserved and the publication is tried again later.
      throw new CommandError("UNREPLAYED", "the transaction does not replay over the unspent boxes the node lists for the funding key");
    }
    const cost = before - total(this.tree), paid = total(fee) - feeBefore;
    if (paid <= 0n || cost < paid) throw new CommandError("BUDGET", "the transaction's cost is not a publication's");
    if (this.spent() + cost > this.limit) throw new CommandError("BUDGET", `the transaction would pass the spend budget of ${this.limit} nanoErg`);
    this.db.prepare("INSERT INTO spend VALUES(?,?,?)").run(key, digest, cost);
  }
  close(): void { this.db.close(); }
}

/** Fresh random bytes for a key or token file. */
export const fresh = (): Uint8Array => new Uint8Array(randomBytes(32));
/** A fresh secp256k1 funding secret. */
export const freshFunding = (): Uint8Array => secp256k1.utils.randomPrivateKey();
