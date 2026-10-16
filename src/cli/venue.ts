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
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { compareBytes, EncodingError } from "../bytes.js";
import { DEFAULT_ERGO_DEPTH, ErgoVenue, ergoAnchorContext, syncCaughtUp, type ErgoCatchUpReport } from "../ergo.js";
import { parseErgoHeader } from "../ergo-headers.js";
import { ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE, ergoProfileIdentity, MINER_FEE_TREE_HEX, ownErgoProfile, type ErgoProfile,
  type ErgoReferenceContext } from "../ergo-profile.js";
import { ErgoPublisher, ergoNodePublisher, payToPublicKeyTree, readPlainBox, rowOutbox, verifyErgoProof, type ErgoPublisherPersistence,
  type ErgoPublishingSupplier } from "../ergo-publisher.js";
import { foldPublicInputs, type ExhaustionSet, type ExhaustionSupplier, type Fold } from "../ergo-exhaustion.js";
import { ExhaustionServer, ExhaustionServerError, type ServedBlock } from "../ergo-exhaustion-server.js";
import { shippedExhaustionSet } from "../ergo-exhaustion-set.js";
import { decodeFold, encodeFold } from "../ergo-exhaustion-wire.js";
import { ErgoVenueJournal } from "../ergo-store.js";
import { EvidenceRefusal } from "../pool/v3/refusals.js";
import { ReplayStore } from "../pool/v3/replay-store.js";
import { exhaustionClient, V3ServiceClientError } from "../pool/v3/service-client.js";
import type { ExhaustionSource } from "../pool/v3/service-http.js";
import { ergoNodeSupplier, nodeText, parseNodeJson, type ErgoSupplier } from "../ergo-supplier.js";
import { MempoolNode } from "../ergo-synthetic.js";
import type { RecordKind } from "../record-range.js";
import type { VenueReference } from "../pool/v3/guard.js";
import { VenueError } from "../venue-error.js";
import { directoryBackend, type ExhaustionProver } from "./backend.js";
import { isListenerUrl } from "./serve.js";
import { keptTerms } from "./terms.js";
import { CommandError, event, fresh, openDirectory, parseArguments, print, readJson, readOptional, readSecret, required, UsageError, writeExclusive,
  writeReplace, type Directory } from "./common.js";

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
      // Read bounded, as every other node answer is: an endpoint is untrusted and may stream without end.
      const text = await nodeText(fetch, `${url.replace(/\/+$/, "")}/info`, "/info", { signal: AbortSignal.timeout(NODE_TIMEOUT_MS) }, 1 << 20);
      if (text === undefined) continue;
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
    try { takesContext(venue, readContext(directory)); return; } catch { /* fetched again below */ }
  }
  const context = await fetchContext(directory, venue.profile.anchor, venue.anchorHeight);
  takesContext(venue, context);
  writeReplace(directory.file("anchor.json"), `${JSON.stringify(context.map(bytesToHex))}\n`);
}
/** Check that a view takes the anchor's context, closing the in-memory rows it builds to do so (Next 4 (ac)). */
function takesContext(venue: VenueFile, context: readonly Uint8Array[]): void {
  const rows = ErgoVenueJournal.memory(ergoProfileIdentity(venue.profile));
  try { new ErgoVenue(venue.profile, context, {}, undefined, rows); } finally { rows.close(); }
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
 * A rerun prints the existing file where it is the context and depth asked, and refuses (`VENUE`) otherwise. */
export async function createVenue(directory: Directory, options: { readonly synthetic: boolean; readonly depth?: bigint }): Promise<{ readonly venue: VenueFile; readonly created: boolean }> {
  const existing = ownVenue(directory), context = options.synthetic ? ERGO_SYNTHETIC_REFERENCE : ERGO_TESTNET_REFERENCE;
  if (existing !== undefined) {
    if (existing.profile.reference !== context || (options.depth !== undefined && options.depth !== existing.profile.depth)) {
      throw new CommandError("VENUE", "venue.json names another context or depth than asked");
    }
    return { venue: existing, created: false };
  }
  const depth = options.depth ?? DEFAULT_ERGO_DEPTH;
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
  const kept = existsSync(directory.file("location.key")), key = kept ? readSecret(directory.file("location.key"), "location.key") : fresh();
  let profile: ErgoProfile;
  try {
    if (!kept) writeExclusive(directory.file("location.key"), key);
    profile = ownErgoProfile({ reference: context, anchor, depth,
      scripts: { 1: locationTree(key, 1), 2: locationTree(key, 2), 3: locationTree(key, 3), 4: locationTree(key, 4) } });
  } finally { key.fill(0); }
  const venue = parseVenue(JSON.parse(venueText(profile, anchorHeight)));
  await keepContext(directory, venue);
  writeExclusive(directory.file("venue.json"), venueText(profile, anchorHeight));
  return { venue, created: true };
}

/** The exhaustion set a succinct directory reads its venue under and a replica serves (succinct-read §4, slice 43): the
 * circuit set the package ships, a test set (no set is adopted, §6), from the venue's anchor, so every party computes it
 * from the venue file. Its folds verify on a verifier started from the directory's parameters at the first fold. */
export function exhaustionSet(directory: Pick<Directory, "path">, file: VenueFile): ExhaustionSet & { close(): Promise<void> } {
  return shippedExhaustionSet({ id: file.profile.anchor, height: file.anchorHeight }, () => directoryBackend(directory));
}
/** The file a directory keeps its view in: a succinct directory's (`--read succinct`) is a succinct view of its own
 * (succinct-read §4), never the complete `venue.db`, which neither form's view opens as the other. */
export const viewFile = (directory: Pick<Directory, "succinct">): string => directory.succinct ? "succinct-venue.db" : "venue.db";
/** Every replica URL the directory keeps, for any operator, each once; a string that is none is passed over (the
 * command reading its file refuses it). */
export function keptReplicaUrls(directory: Pick<Directory, "file">): string[] {
  let names: string[];
  try { names = readdirSync(directory.file("replicas")); } catch { return []; }
  const urls = new Set<string>();
  for (const name of names.filter(n => /^[0-9a-f]{64}\.json$/.test(n)).sort()) {
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readOptional(directory.file(`replicas/${name}`)) ?? new Uint8Array())) as { urls?: unknown };
      for (const url of Array.isArray(value.urls) ? value.urls : []) if (typeof url === "string" && isListenerUrl(url)) urls.add(url);
    } catch { /* a replicas file that does not parse is refused by the command that reads it */ }
  }
  return [...urls];
}
/** A client of each replica the directory keeps, except the `except` URLs (as `new URL(url).href`): a succinct view
 * asks each for the exhaustion, and a replica asks the others for their folds. */
export function exhaustionSuppliers(directory: Pick<Directory, "file">, set: Uint8Array, except: readonly string[] = []): ExhaustionSupplier[] {
  const out: ExhaustionSupplier[] = [], seen = new Set(except);
  for (const url of keptReplicaUrls(directory)) {
    try {
      const href = new URL(url).href;
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(exhaustionClient(url, set));
    } catch { /* not a replica URL */ }
  }
  return out;
}
/** The subjects a succinct view follows for the directory's kept backings: each backing (replacements, publications),
 * its terms' operator (commitments) and obligor (revocations). Terms that do not authenticate are passed over: the
 * command reading them refuses them. */
function keptSubjects(directory: Directory, file: VenueFile): Uint8Array[] {
  let names: string[];
  try { names = readdirSync(directory.file("terms")); } catch { return []; }
  const subjects: Uint8Array[] = [];
  for (const name of names.filter(n => /^[0-9a-f]{64}$/.test(n))) {
    try {
      const kept = keptTerms(directory, hexToBytes(name), file);
      subjects.push(kept.backing, kept.terms.operator, kept.terms.obligor);
    } catch { /* refused where read */ }
  }
  return subjects;
}

/** The directory's own view, restored from its file (`viewFile`), with an optional publisher attached later. */
export interface View {
  readonly file: VenueFile;
  readonly venue: ErgoVenue;
  readonly journal: ErgoVenueJournal;
  /** Sync until the view is caught up (`syncCaughtUp`), noting each pass another follows as a progress event. A
   * succinct view first follows its kept backings' subjects and asks its replicas for the exhaustion. */
  sync(): Promise<ErgoCatchUpReport>;
  /** `sync`, refusing a venue that has witnessed nothing yet: its clock then stands on a block. */
  syncWitnessed(): Promise<ErgoCatchUpReport & { readonly witnessedIndex: bigint }>;
  /** Run `read`; where a succinct view leaves it unresolved for subjects it does not follow (an operator a replacement
   * names), follow them, sync and run it again, while each round follows a new subject. A complete view runs it once. */
  following<T>(read: () => Promise<T>): Promise<T>;
  close(): void;
}
/** The exhaustion sets a succinct directory dropped (`exhaustion.json`): a transaction showed each unsound (succinct-read
 * §2 rule 7), so its view reads without it from then on. */
function droppedSets(directory: Directory): string[] {
  const held = readOptional(directory.file("exhaustion.json"));
  if (held === undefined) return [];
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held)) as { dropped?: unknown };
    if (Array.isArray(value.dropped) && value.dropped.every(set => typeof set === "string")) return value.dropped as string[];
  } catch { /* refused below */ }
  throw new CommandError("INVALID", `${directory.file("exhaustion.json")} is not { dropped }: correct or remove it`);
}
/** A succinct view whose set disagreed: the set is dropped for the directory, and the view's file and every answer kept
 * under it (the reader's `replay.db`, a wallet's `wallet.db.replay`) are discarded (§6), so the next view reads natively. */
function dropSet(directory: Directory, set: Uint8Array): void {
  const name = bytesToHex(set), dropped = droppedSets(directory);
  if (!dropped.includes(name)) writeReplace(directory.file("exhaustion.json"), `${JSON.stringify({ dropped: [...dropped, name] }, null, 2)}\n`);
  for (const kept of ["replay.db", "wallet.db.replay"]) {
    if (!existsSync(directory.file(kept))) continue;
    const store = new ReplayStore(directory.file(kept), { digest: directory.file(`${kept}.sha256`) });
    try { store.discardKept(); } finally { store.close(); }
  }
  // The view's -wal and -shm first: a crash after them leaves the main file, its disagreement and spans checkpointed,
  // which the next opening drops again.
  for (const suffix of ["-wal", "-shm", ""]) rmSync(directory.file(`${viewFile(directory)}${suffix}`), { force: true });
  event({ event: "exhaustion-dropped", set: name });
}

/** The directory's view. `exhaustion` stands in for the shipped set of a succinct directory (tests; so in `exhaustionOver`). */
export function openView(directory: Directory, options: { readonly exhaustion?: ExhaustionSet & { close?(): Promise<void> } } = {}): View {
  const file = requireVenue(directory);
  // The set first: a package without its keys refuses before any file opens.
  const set = directory.succinct ? options.exhaustion ?? exhaustionSet(directory, file) : undefined;
  let journal = new ErgoVenueJournal(directory.file(viewFile(directory)), file.id);
  try {
    const open = () => new ErgoVenue(file.profile, readContext(directory), {}, undefined, journal, set === undefined ? undefined : { set });
    let venue = open();
    // A view holding indices read under a dropped set (one restored from before the drop) is dropped again.
    const dropped = set !== undefined && droppedSets(directory).includes(bytesToHex(set.identity));
    if (venue.disagreed() || (dropped && venue.succinctSummary()!.succinctIndices > 0n)) {
      journal.close();
      dropSet(directory, set!.identity);
      journal = new ErgoVenueJournal(directory.file(viewFile(directory)), file.id);
      venue = open();
    }
    // A dropped set is asked of no replica: the view reads every index natively.
    const asked = set !== undefined && !droppedSets(directory).includes(bytesToHex(set.identity));
    const sources = suppliers(directory);
    const sync = () => {
      if (set !== undefined) for (const subject of keptSubjects(directory, file)) venue.follow(subject);
      return syncCaughtUp(venue, sources, pass => event({ event: "syncing", witnessedIndex: pass.witnessedIndex, tipHeight: pass.tipHeight }),
        asked ? exhaustionSuppliers(directory, set!.identity) : []);
    };
    const syncWitnessed = async () => {
      const synced = await sync(), at = synced.witnessedIndex;
      if (at === undefined) throw new CommandError("UNAVAILABLE", "the venue has witnessed nothing yet: its first index is final once the depth is mined above it");
      return { ...synced, witnessedIndex: at };
    };
    const following = async <T>(read: () => Promise<T>): Promise<T> => {
      for (;;) {
        // Only what this read asks counts: a subject an earlier read wanted is not this read's reason.
        venue.forgetWanted();
        try { return await read(); } catch (error) {
          const wanted = venue.wanted(), before = venue.followed().length;
          if (!(error instanceof EvidenceRefusal && error.status === "unresolved-evidence") || wanted.length === 0) throw error;
          for (const subject of wanted) venue.follow(subject);
          await sync();
          // A sync that followed nothing new (no replica served a fold reaching the indices read succinctly) leaves the
          // read unresolved for the view's own reason, which no evidence source is charged with.
          if (venue.followed().length === before) {
            throw new CommandError("UNAVAILABLE", `the view does not yet hold ${wanted.map(bytesToHex).join(", ")}: no replica served a fold reaching ` +
              "the indices it read succinctly; read again once one does");
          }
          event({ event: "following", subjects: wanted.map(bytesToHex) });
        }
      }
    };
    const own = venue, ownJournal = journal;
    return { file, venue: own, journal: ownJournal, sync, syncWitnessed, following, close: () => { ownJournal.close(); void set?.close?.(); } };
  } catch (error) { journal.close(); void set?.close?.(); throw error; }
}

/** A replica's exhaustion: what its listener serves, and the work its rounds do. */
export interface ReplicaExhaustion {
  readonly source: ExhaustionSource;
  /** Whether a period is proving now. */
  readonly busy: boolean;
  /** Take the kept fold if not yet taken; then a peer's fold beyond the map, if one is taken; else, with a prover and
   * none proving, start proving the indices the view newly read as one period (or a period whose proof failed, after a
   * wait), in the background: `folded` hears each fold, and for a peer's its URL. */
  advance(folded: (fold: Fold, how: "kept" | "proved" | "taken", from?: string) => void): Promise<void>;
  /** Stop: a period proving is abandoned (its kept leaf proofs stay for the next start). */
  close(): Promise<void>;
}
/** How long a replica waits before proving a period whose proof failed again, at most. */
const PERIOD_RETRY_MS = 60_000, PERIOD_RETRY_MAX_MS = 3_600_000;
/** A period's most blocks: about two hours of Ergo's chain. */
const PERIOD_BLOCKS = 64n;
/** How many turns a kept fold's verification may fail to run before the replica proves from the start. */
const KEPT_TRIES = 5;
/** How long a peer whose fold was refused is not asked again, doubling from a minute to at most a day. */
const PEER_WAIT_MS = 60_000, PEER_WAIT_MAX_MS = 86_400_000;
/** What a replica that stopped a set serves of it. */
const NOTHING: ExhaustionSupplier = Object.freeze({ fold: async () => undefined, key: async () => undefined, transaction: async () => undefined });

/**
 * A replica's exhaustion over its own view (succinct-read §4.7, slice 43): the map under the directory's set from the
 * venue's anchor over the view's rows; the latest fold kept in `exhaustion-fold.bin` and taken again at the next start
 * (it must verify and the map over the view's rows must end at its end with its root, or it is passed over); and, with
 * a prover, a period proved over the indices the view newly read each time none is proving, so that rounds go on while
 * one proves (a period costs minutes of proving at least). Without a prover it serves its kept fold.
 *
 * It also takes folds another proved (§4.7): each turn no period is proving or pending, it asks `peers` (the other
 * replicas its directory keeps) for their latest fold within its view, and adopts the one ending highest above its map
 * where it verifies and the map over the view's own rows reproduces it, as it takes a kept fold; a taken fold is kept
 * and served, and a prover's next period continues it. One prover thus serves every replica that keeps it. A peer whose
 * fold is refused (it does not verify, is of another start or key hash, or ends at another header than the view's) is
 * not asked again for a doubling wait; a peer that does not answer is asked at the next turn.
 */
export function exhaustionOver(directory: Pick<Directory, "path" | "file">, view: View, prover?: ExhaustionProver,
    options: { readonly exhaustion?: ExhaustionSet & { close?(): Promise<void> }; readonly peers?: () => readonly ExhaustionSupplier[] } = {}): ReplicaExhaustion {
  const set = options.exhaustion ?? exhaustionSet(directory, view.file), anchorHeight = view.file.anchorHeight, keptFile = directory.file("exhaustion-fold.bin");
  const block = (height: bigint): ServedBlock | undefined => view.venue.section(height - anchorHeight - 1n);
  const make = () => new ExhaustionServer({ start: set.start, foldKeyHash: set.foldKeyHash, block, name: "replica",
    prove: (first, inputs, period) => {
      if (prover === undefined) throw new CommandError("PROVER", "this replica proves no exhaustion");
      return prover.fold(first, inputs, period);
    } });
  let server = make(), proving: Promise<void> | undefined, retryAt = 0, failures = 0, waiting = false, unverified = 0;
  /** Where a fold this replica's map disagreed with is kept, by the set's identity: while one is, the set is served no more. */
  const evidencePrefix = `exhaustion-disagreement-${bytesToHex(set.identity)}-`;
  /** Why the replica serves this set no more: its map disagreed with a fold that verified (succinct-read §2 rule 7). */
  let stopped: string | undefined;
  try {
    const held = readdirSync(directory.path).find(name => name.startsWith(evidencePrefix));
    if (held !== undefined) {
      stopped = `${held} holds a fold the map disagreed with`;
      event({ event: "exhaustion", code: "DISAGREEMENT", message: `${stopped}: this set is served no more until it is removed` });
    }
  } catch { /* a directory that cannot be listed holds none */ }
  /** The kept fold not yet taken: null before it is read; undefined where none is (left). */
  let kept: Fold | undefined | null = null;
  const verify = async (fold: Fold): Promise<boolean> => {
    const inputs = foldPublicInputs(fold.inputs);
    return inputs !== undefined && await set.verifyFold(fold.first, inputs, fold.proof) === true;
  };
  const passOver = (why: string): void => { event({ event: "exhaustion", code: "KEPT", message: `${keptFile} is passed over: ${why}` }); };
  /** The kept fold, where it is one of this set that verifies: checked before the replica waits for its end. Null
   * where the verification could not run (its verifier did not start): it is tried again at the next turn. */
  const readKept = async (): Promise<Fold | undefined | null> => {
    let fold: Fold;
    try {
      const bytes = readOptional(keptFile);
      if (bytes === undefined) return undefined;
      fold = decodeFold(bytes);
    } catch { passOver("it is no fold"); return undefined; }
    const { inputs } = fold;
    if (compareBytes(inputs.startId, set.start.id) !== 0 || inputs.startHeight !== set.start.height || inputs.foldKeyHash !== set.foldKeyHash) {
      passOver("it is a fold of another start or key hash"); return undefined;
    }
    let verified: boolean;
    try { verified = await verify(fold); } catch (error) {
      // Tried again at the next turns; after KEPT_TRIES the replica proves from the start instead.
      if (++unverified < KEPT_TRIES) {
        if (unverified === 1) event({ event: "exhaustion", code: "KEPT", message: `the kept fold could not be verified yet: ${(error as Error).message}` });
        return null;
      }
      passOver(`it could not be verified in ${KEPT_TRIES} turns: ${(error as Error).message}`);
      return undefined;
    }
    if (!verified) { passOver("it does not verify"); return undefined; }
    return fold;
  };
  const blocksTo = (top: bigint): ServedBlock[] | undefined => {
    const blocks: ServedBlock[] = [];
    for (let height = server.height + 1n; height <= top; height++) {
      const read = block(height);
      if (read === undefined) return undefined;
      blocks.push(read);
    }
    return blocks;
  };
  /** Adopt `fold` on `target` (the replica's server, or a fresh one in its place) over the view's rows, its blocks read
   * one at a time (a fold far from the start holds no span in memory): undefined where it was taken, else why not. A
   * fold that verified while the map over the view's own blocks has another root shows the set or this map unsound: the
   * fold is kept aside as the evidence (the kept file moved there, a peer's written), and the replica serves and proves
   * this set no more, also after a restart. */
  const adopt = async (target: ExhaustionServer, fold: Fold, from: "kept" | "peer"): Promise<unknown> => {
    try { await target.adopt(fold, block, verify); return undefined; } catch (error) {
      if (error instanceof ExhaustionServerError && error.code === "DISAGREEMENT") {
        stopped = error.message;
        const evidence = `${evidencePrefix}${fold.inputs.endHeight}-${randomUUID()}.bin`;
        try {
          if (from === "kept") renameSync(keptFile, directory.file(evidence));
          else writeExclusive(directory.file(evidence), encodeFold(fold));
        } catch { /* the kept file left in place; a peer's fold asked again */ }
        event({ event: "exhaustion", code: "DISAGREEMENT", message: `${error.message}; the fold is kept in ${evidence} and this set is served no more` });
      }
      return error;
    }
  };
  /** Take the kept fold once the view's rows reach its end: false while it waits for them. */
  const adoptKept = async (folded: (fold: Fold, how: "kept") => void): Promise<boolean> => {
    if (kept === null) {
      const read = await readKept();
      if (read === null) return false;
      kept = read;
    }
    if (kept === undefined) return true;
    const fold = kept, top = anchorHeight + 1n + view.venue.witnessedIndex();
    if (fold.inputs.endHeight > top) {
      if (!waiting) event({ event: "exhaustion", code: "WAITING", message: `the kept fold to ${fold.inputs.endHeight} waits for the view to read its blocks` });
      waiting = true;
      return false;
    }
    kept = undefined;
    const refused = await adopt(server, fold, "kept");
    if (refused === undefined) { folded(fold, "kept"); return true; }
    if (stopped !== undefined) return false;
    // The kept fold is passed over (a map part-appended is replaced): the replica proves or takes from the start.
    server = make();
    passOver((refused as Error).message);
    return true;
  };
  /** Peers passed over, by URL: until when, the wait that set it, and how often their fold's verification could not run. */
  const silent = new Map<string, { readonly until: number; readonly wait: number }>(), unverifiable = new Map<string, number>();
  /** A refused fold doubles its peer's wait; one that did not answer waits the least (`doubling` false). */
  const silence = (name: string, why: string, doubling = true): void => {
    const wait = doubling ? Math.min((silent.get(name)?.wait ?? PEER_WAIT_MS / 2) * 2, PEER_WAIT_MAX_MS) : PEER_WAIT_MS;
    silent.set(name, { until: Date.now() + wait, wait });
    event({ event: "exhaustion", code: "PEER", peer: name, message: `${why}; not asked again for ${wait} ms` });
  };
  /** Take the highest fold a peer offers above the map and within the view: whether one was taken. Peers are asked at
   * once, so one that does not answer costs a turn its timeout at most, and is then passed over for a minute; one whose
   * fold is refused, for a doubling wait, reset by any answer that decodes. Where a period is pending (its proof
   * failed), a fold above the one served is taken on a fresh map in place of the pending one. */
  const takeFromPeers = async (folded: (fold: Fold, how: "taken", from: string) => void): Promise<boolean> => {
    // Above the map, or above the served fold where a period is pending.
    const top = anchorHeight + 1n + view.venue.witnessedIndex(), pending = server.pending;
    const floor = pending === undefined ? server.height : server.latest?.inputs.endHeight ?? set.start.height;
    if (options.peers === undefined || top <= floor) return false;
    const now = Date.now();
    const asked = options.peers().map(peer => ({ name: peer.name ?? "peer", peer })).filter(({ name }) => (silent.get(name)?.until ?? 0) <= now);
    const answers = await Promise.allSettled(asked.map(({ peer }) => peer.fold(top)));
    const offered: { readonly name: string; readonly fold: Fold }[] = [];
    answers.forEach((answer, i) => {
      const { name } = asked[i]!;
      if (answer.status === "rejected") {
        // Bytes that are no fold are the peer's failure (§2 rule 5); one that does not answer is passed over for a
        // minute; the replica's own proxy refusing the route is no peer's.
        const error = answer.reason as Error;
        if (error instanceof EncodingError) silence(name, `its fold is malformed: ${error.message}`);
        else if (!(error instanceof V3ServiceClientError && error.code === "PROXY" && error.status === 0)) silence(name, `it did not answer: ${error?.message}`, false);
        else event({ event: "exhaustion", code: "PROXY", peer: name, message: error.message });
        return;
      }
      silent.delete(name);
      const fold = answer.value;
      if (fold !== undefined && fold.inputs.endHeight > floor && fold.inputs.endHeight <= top) offered.push({ name, fold });
    });
    offered.sort((a, b) => a.fold.inputs.endHeight > b.fold.inputs.endHeight ? -1 : a.fold.inputs.endHeight < b.fold.inputs.endHeight ? 1 : 0);
    for (const { name, fold } of offered) {
      // Over a pending period, a fresh map from the start: the pending one stays where the fold is not taken.
      const target = pending === undefined ? server : make(), refused = await adopt(target, fold, "peer");
      if (refused === undefined) {
        unverifiable.delete(name);
        // A taken fold replaces a pending period: the next period is proved from it, with no wait left from the old.
        server = target; failures = 0; retryAt = 0;
        // Kept, so a restart takes it again; a prover's kept leaves are of periods it no longer proves.
        try { writeReplace(keptFile, encodeFold(fold)); prover?.folded(); } catch (error) {
          event({ event: "exhaustion", code: "KEPT", message: `the fold to ${fold.inputs.endHeight} could not be kept: ${(error as Error).message}` });
        }
        folded(fold, "taken", name);
        return true;
      }
      if (stopped !== undefined) return false;
      if (refused instanceof ExhaustionServerError && refused.code === "BLOCKS") {
        // The view's rows could not be read again: an availability fault, not the peer's. A part-appended map is
        // replaced by a fresh one, which takes the kept fold again from the start at the next turn.
        event({ event: "exhaustion", code: "BLOCKS", peer: name, message: refused.message });
        if (target === server) { server = make(); kept = null; unverified = 0; }
        return false;
      }
      if (refused instanceof ExhaustionServerError || refused instanceof EncodingError) { silence(name, (refused as Error).message); continue; }
      // A verification that could not run is this replica's until it recurs: the next offer is tried, and a peer whose
      // fold fails to verify so KEPT_TRIES times is passed over.
      const tries = (unverifiable.get(name) ?? 0) + 1;
      unverifiable.set(name, tries);
      if (tries >= KEPT_TRIES) { unverifiable.delete(name); silence(name, `its fold could not be verified in ${tries} turns: ${(refused as Error).message}`); }
      else event({ event: "exhaustion", code: "PEER", peer: name, message: `its fold could not be verified yet: ${(refused as Error).message}` });
    }
    return false;
  };
  return {
    // A stopped set is served no more: no fold, path or transaction.
    source: { set: set.identity, get supplier() { return stopped === undefined ? server : NOTHING; } },
    get busy() { return proving !== undefined; },
    async advance(folded) {
      if (proving !== undefined || stopped !== undefined) return;
      if (!await adoptKept(folded) || await takeFromPeers(folded) || prover === undefined || Date.now() < retryAt) return;
      // At most PERIOD_BLOCKS a period: a replica far behind folds as it goes rather than holding every block at once.
      // A pending period (its proof failed) is proved alone first.
      const top = anchorHeight + 1n + view.venue.witnessedIndex(), end = top < server.height + PERIOD_BLOCKS ? top : server.height + PERIOD_BLOCKS;
      const blocks = server.pending !== undefined ? [] : end > server.height ? blocksTo(end) : [];
      if (blocks === undefined || (blocks.length === 0 && server.pending === undefined)) return;
      const run = server.extend(blocks).then(fold => {
        failures = 0;
        // A fold proved is served whether or not it could be kept; an unkept one is proved again after a restart.
        try { writeReplace(keptFile, encodeFold(fold)); prover.folded(); } catch (error) {
          event({ event: "exhaustion", code: "KEPT", message: `the fold to ${fold.inputs.endHeight} could not be kept: ${(error as Error).message}` });
        }
        folded(fold, "proved");
      }, (error: unknown) => {
        failures++;
        const wait = Math.min(PERIOD_RETRY_MS * 2 ** Math.min(failures - 1, 6), PERIOD_RETRY_MAX_MS);
        retryAt = Date.now() + wait;
        event({ event: "exhaustion", code: "PROVER", message: (error as Error).message, failures, retryMs: wait });
      }).catch(() => { /* a line that could not be written */ }).finally(() => { proving = undefined; });
      proving = run;
    },
    async close() {
      await prover?.close();
      await proving;
      await set.close?.();
    },
  };
}

/** The directory's view read beside the process that owns and syncs it (`moe operator prepare` beside `serve`,
 * Next 4 (bg)): no sync, no publisher, answers through the clock its rows held when it opened. A directory whose view
 * never synced has none (`ABSENT`). */
export function besideView(directory: Directory): { readonly file: VenueFile; readonly venue: ErgoVenue; close(): void } {
  const file = requireVenue(directory);
  if (!existsSync(directory.file("venue.db"))) throw new CommandError("ABSENT", "the directory keeps no view (venue.db): serve or sync it first");
  const journal = ErgoVenueJournal.beside(directory.file("venue.db"), file.id);
  try {
    const venue = new ErgoVenue(file.profile, readContext(directory), {}, undefined, journal);
    journal.settled();
    return { file, venue, close: () => journal.close() };
  } catch (error) { journal.close(); throw error; }
}

/**
 * `moe venue audit --dir <d>` (slice 13): any role's view re-checked as a reader that never trusted its rows would
 * (`ErgoVenue.audit` with work): run it on a directory restored from a backup or copied from elsewhere, or after a
 * disk fault, before any other command. Reopening checks only what is cheap. It reads no node and changes nothing; a
 * row that does not reproduce refuses `AUDIT`, naming the first. A directory whose view never synced has nothing
 * to audit (`ABSENT`).
 */
export async function venueAudit(argv: readonly string[]): Promise<void> {
  if (argv[0] !== "audit") throw new UsageError("moe venue audit --dir <directory>");
  const args = parseArguments(argv.slice(1), { dir: "value" }, 0), directory = openDirectory(required(args, "dir"), "any");
  if (!existsSync(directory.file(viewFile(directory)))) throw new CommandError("ABSENT", `the directory keeps no view (${viewFile(directory)}): nothing to audit`);
  const view = openView(directory);
  try {
    let witnessed: bigint;
    // A view that failed refuses with its failure (VENUE), kept as the evidence that finality broke.
    try { witnessed = view.venue.witnessedIndex(); } catch (error) {
      if (error instanceof VenueError && /no settled snapshot/.test(error.message)) throw new CommandError("ABSENT", "the view has no settled snapshot: nothing to audit");
      throw error;
    }
    let audited;
    try { audited = view.venue.audit({ work: true }); } catch (error) {
      if (error instanceof VenueError) throw new CommandError("AUDIT", error.message);
      throw error;
    }
    print({ status: "audited", role: directory.config.role, venue: bytesToHex(view.file.id), witnessedIndex: witnessed,
      headers: audited.headers, sections: audited.sections, objects: audited.objects });
  } finally { view.close(); }
}

/** The directory's node endpoints as publishing suppliers, each submission first passing the spend budget, which asks
 * the publisher's `proceed` before it reserves, and `proceed` again immediately before it is sent: the budget's read
 * can outlast the submission's call (Next 4 (bi)). */
export function publishingSuppliers(directory: Pick<Directory, "config">, budget: Pick<SpendBudget, "tree" | "authorize">): ErgoPublishingSupplier[] {
  return directory.config.nodes.map((url, i) => {
    const node = ergoNodePublisher(url, { name: `node ${i + 1}`, timeoutMs: NODE_TIMEOUT_MS });
    return Object.freeze({ name: node.name, unspentBoxes: (tree: Uint8Array) => node.unspentBoxes(tree), hasBox: (id: Uint8Array) => node.hasBox(id),
      hasTransaction: (id: Uint8Array) => node.hasTransaction(id),
      submit: async (signed: Uint8Array, id: Uint8Array, proceed: () => void) => {
        await budget.authorize(signed, id, await node.unspentBoxes(budget.tree), proceed);
        proceed();
        return node.submit(signed, id, proceed);
      } });
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

/** A funding directory's publisher outbox outside a journal (`relay.db`), as `rowOutbox` keeps it. */
export function publisherStore(path: string): { readonly persistence: ErgoPublisherPersistence; close(): void } {
  const db = new DatabaseSync(path, { timeout: 5000, readBigInts: true });
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS ergo_publisher (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, snapshot TEXT NOT NULL) STRICT;`);
  } catch (error) { db.close(); throw error; }
  const transaction = <T>(work: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return { close: () => db.close(), persistence: rowOutbox(db, transaction, (code, message) => { throw new CommandError(code, message); }) };
}

/** The funding tree of a 32-byte secp256k1 secret. */
export const fundingTree = (secret: Uint8Array): Uint8Array => payToPublicKeyTree(secp256k1.getPublicKey(secret, true));

/**
 * A funding directory's spend budget (`config.json`'s `spendBudgetNanoErg`, M10b item 6), as the live drills'
 * guard judges it: before each broadcast the signed transaction is replayed on an offline mempool funded with the
 * key's unspent boxes, and what it takes from the key (fees and record boxes' minimums) is reserved in `spend.db`
 * before it is sent, so a refused or uncertain broadcast keeps its reservation; `proceed` is asked before reserving, so
 * a transaction the publisher no longer sends reserves nothing. A transaction past the budget is
 * refused (`BUDGET`); an exact resubmission of one already reserved passes. A `spend.db` restored from a copy misses
 * what was spent since it was made; the funding key's balance stays the hard cap (slice 13 M13e).
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
  async authorize(signed: Uint8Array, id: Uint8Array, boxes: readonly Uint8Array[], proceed: () => void): Promise<void> {
    try { await this.judge(signed, id, boxes, proceed); } catch (error) {
      if (error instanceof CommandError) this.refused = error;
      throw error;
    }
  }
  private async judge(signed: Uint8Array, id: Uint8Array, boxes: readonly Uint8Array[], proceed: () => void): Promise<void> {
    const key = bytesToHex(id), digest = bytesToHex(sha256(signed));
    // An exact resubmission of a reserved transaction passes without a second reservation.
    const reserved = (): boolean => {
      const prior = this.db.prepare("SELECT signed FROM spend WHERE id=?").get(key);
      if (prior === undefined) return false;
      if (prior.signed !== digest) throw new CommandError("BUDGET", "a reserved transaction id names other bytes");
      proceed();
      return true;
    };
    if (reserved()) return;
    const shadow = new MempoolNode("spend budget", verifyErgoProof), fee = hexToBytes(MINER_FEE_TREE_HEX);
    for (const box of boxes) if (readPlainBox(box, this.tree) !== undefined) shadow.fund(box);
    const total = (tree: Uint8Array) => [...shadow.boxes.values()].reduce((sum, box) => sum + (readPlainBox(box, tree)?.value ?? 0n), 0n);
    const before = total(this.tree), feeBefore = total(fee);
    try { await shadow.submit(signed, id); } catch {
      // Not the budget: the node's listing of the key's boxes does not carry the transaction's inputs (an index
      // behind its mempool, or another spender); nothing is reserved and the publication is tried again later.
      throw new CommandError("UNREPLAYED", "the transaction does not replay over the unspent boxes the node lists for the funding key");
    }
    // The publisher sends one transaction to every node at once: another judgement of it may have reserved it meanwhile.
    if (reserved()) return;
    const cost = before - total(this.tree), paid = total(fee) - feeBefore;
    if (paid <= 0n || cost < paid) throw new CommandError("BUDGET", "the transaction's cost is not a publication's");
    if (this.spent() + cost > this.limit) throw new CommandError("BUDGET", `the transaction would pass the spend budget of ${this.limit} nanoErg`);
    proceed();
    this.db.prepare("INSERT INTO spend VALUES(?,?,?)").run(key, digest, cost);
  }
  close(): void { this.db.close(); }
}

/** A fresh secp256k1 funding secret. */
export const freshFunding = (): Uint8Array => secp256k1.utils.randomPrivateKey();
