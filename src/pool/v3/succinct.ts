// Succinct reading of pool-v3 trails (succinct-read.md, `moe/succinct/v1` §§2–3): a reader's option, never a verdict
// rule. A succinct read is the one walk (scope-reader.ts) over a construction whose trail records are proof-free (§3.3):
// pool-v3's view of each record, its evidence triple read with `proofHash` as carried, and its statement check taken
// from a check proof covering it (§3.2) or from the native check over its fetched proof (§3.5). Before a trail's replay,
// and before a non-extension is decided, every record's proof length is established (§3.4 step 3: `TrailChecks`), so the
// read is unresolved, or classified by §9.1, exactly where the complete read's authentication is inconclusive.
// Publications keep their full bytes at the venue: the reader reads each as its proof-free form and checks its proof
// natively over the bytes it holds (§3.6). What a succinct read derives is a succinct judgment: kept state is named by
// the set identity (§2 rule 8) and nothing it derives is served or shown to another party (§1).
//
// No circuit set is adopted (§6), so the only set here is a test set, labelled as such (`testCheckSet`): its check
// proofs are hashes any party computes, which exercise every rule of the reader and attest nothing.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import { SUCCINCT_TRAIL_CONTEXT, V3_SEGMENT_CONTEXT } from "../../contexts.js";
import { bytesToField, fieldToBytes, limbsOf } from "../field.js";
import { poseidon2Hash } from "../poseidon2.js";
import { POOL_V3, v3View, type Construction, type PublicationView, type ReaderFrames, type RequestView, type ServedTrailOf, type TrailChecks } from "./construction.js";
import {
  decodeProofFree, decodePublication, decodeRecord, encodeProofFree, MAX_PROOF, proofFreeDigests, proofFreeOf, proofLengthHolds, provedKind,
  statementHash,
  type Kind, type ProofFreeRecord, type Record,
} from "./records.js";
import { recoveryEffect } from "./recovery.js";
import { requireReplay, UnestablishedTrail } from "./refusals.js";
import type { Adopted, ProofCheck } from "./state.js";
import { MAX_ROOT_TERMS_BYTES } from "./terms.js";
import { MAX_TRAIL_RECORD_BYTES, trailCodec, type ServedTrail } from "./trail.js";
import type { TrailForm } from "./evidence-store.js";

/** The revision of succinct-read.md these rules implement; it names kept state with the set identity (§2 rule 8). */
export const SUCCINCT_SPECIFICATION = "succinct-read 94fc751";
export const T_CHECK_LEAF = 1008n;
export const T_CHECK_NODE = 1009n;
/** The proof length a cover fixes (§3.2): 458 field elements. */
export const COVER_PROOF_BYTES = 14656;
/** Fetched proof bytes a trail's establishment holds for its replay; past it, replay fetches a proof again. */
const HELD_BYTES = 64 << 20;

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** The proof-free trail (§3.3): pool-v3 §10's frame and bounds under its own context. */
export const PROOF_FREE_TRAILS = trailCodec({ context: SUCCINCT_TRAIL_CONTEXT, headerContext: V3_SEGMENT_CONTEXT,
  maxRecordBytes: MAX_TRAIL_RECORD_BYTES, maxTermsBytes: MAX_ROOT_TERMS_BYTES });

/** A complete trail's proof-free trail, which any holder of it derives (§3.3). EncodingError where a record does not
 * decode under §5: it has no proof-free form. */
export function proofFreeTrail(trail: ServedTrail): ServedTrail {
  return { header: copyBytes(trail.header), terms: trail.terms.map(t => ({ terms: copyBytes(t.terms), signature: copyBytes(t.signature) })),
    records: trail.records.map(PROOF_FREE_FORM.record) };
}

/** §3.2: a proved record's leaf digest, over its kind, public inputs and `proofHash`. */
export function leafDigest(record: ProofFreeRecord): bigint {
  return statementLeafDigest(record.kind, record.publicInputs, record.proofHash);
}
/** §3.2's leaf digest of a proof of kind `kind` with public inputs `inputs` and `proofHash` (an aggregator's view, before
 * any record holds the proof). */
export function statementLeafDigest(kind: number, inputs: readonly bigint[], proofHash: Uint8Array): bigint {
  const [hi, lo] = limbsOf(proofHash);
  return poseidon2Hash([T_CHECK_LEAF, BigInt(kind), ...inputs, hi, lo]);
}
/** §3.2: two spans' digest, left then right. */
export function nodeDigest(left: bigint, right: bigint): bigint {
  return poseidon2Hash([T_CHECK_NODE, left, right]);
}

/** A circuit set as a reader pins it (§§2, 6): its identity, and a check proof's verification under one of its pinned
 * keys with public inputs the reader derived itself. */
export interface CheckSet {
  /** The set identity (§6), which names a succinct read's kept state. */
  readonly identity: Uint8Array;
  /** True for a test set, which no adoption names (§1). */
  readonly test: boolean;
  /** Whether `proof` verifies under the pinned trail-leaf key for `kind` (a span of one record) or the pinned trail-node key
   * (`kind` undefined), with public inputs exactly (the trail node's pinned key hash, `digest`) (§2 rule 2, §3.2). False for
   * malformed bytes. */
  verify(kind: number | undefined, digest: bigint, proof: Uint8Array): Promise<boolean> | boolean;
}
/** Where a succinct reader obtains check proofs and proof bytes: any party, untrusted (§2 rule 6). Each answer is
 * checked by the reader; undefined where the supplier has none. */
export interface CheckSupply {
  /** A check proof whose digest is `digest` (§3.2). `accept` is the reader's own check of a candidate, which a supply of
   * several sources may use to pass over a wrong one; the reader checks whatever it returns. */
  cover(digest: bigint, accept?: (proof: Uint8Array) => Promise<boolean>): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  /** The bytes whose SHA-256 is `proofHash` (§3.5). `at` names the trail record that carries it, which a supplier may
   * look it up by; it authenticates nothing (§4.7), and a publication's proof is never fetched. */
  proof(proofHash: Uint8Array, at?: RecordAt): Promise<Uint8Array | undefined> | Uint8Array | undefined;
}
/** A trail record's place: its segment, its position, from 1, and its chain value there (pool-v3 §7.1), which names the
 * one record a supplier keeps there however many forks it keeps beside it. */
export interface RecordAt { readonly segment: Uint8Array; readonly position: bigint; readonly evidence: Uint8Array }

/** The proof-free form a supplier serves its complete trails in (§3.3), record by record. A kept record decodes, so it
 * has its form. */
export const PROOF_FREE_FORM: TrailForm = Object.freeze({
  of: POOL_V3.namespace.name,
  trailHead: PROOF_FREE_TRAILS.trailHead,
  record: (bytes: Uint8Array) => encodeProofFree(proofFreeOf(decodeRecord(bytes))),
  // About a second of a busy laptop's work and 2 MB a part: far inside both sides' stream bounds.
  piece: 2048,
});

/** A supplier's answer to a reader's fetch (§3.5): the proof field of `record` (the one kept at the asked place under the
 * asked chain value) where its SHA-256 is `proofHash`, or undefined. */
export function recordProof(record: Uint8Array | undefined, proofHash: Uint8Array): Uint8Array | undefined {
  if (record === undefined) return undefined;
  let proof: Uint8Array;
  try { proof = decodeRecord(record).proof; } catch (error) { if (error instanceof EncodingError) return undefined; throw error; }
  return proof.length > 0 && same(sha256(proof), proofHash) ? proof : undefined;
}

/** A check proof and the span it covers: a leaf's kind, or undefined for a node, and the span's digest (§3.2). */
export interface Cover {
  readonly kind: number | undefined;
  readonly digest: bigint;
  readonly proof: Uint8Array;
}
/** What proves covers (§§2 rule 6, 3.5): the aggregator (aggregator.ts), or a test set's maker (`testProver`). `leaf` checks
 * the statement proof natively first and gives no cover where it fails. */
export interface SpanProver {
  /** The identity of the set whose keys its covers verify under (§6), which names them where they are kept. */
  readonly identity: Uint8Array;
  leaf(record: Record): Promise<Cover | undefined>;
  node(left: Cover, right: Cover): Promise<Cover>;
}

/** Where a walk of a trail's proved records stands: how many it has walked, and the cover of each height's left span
 * whose right sibling comes next (undefined where it has none). */
export interface CoverWalk { readonly proved: number; readonly pending: readonly (Cover | undefined)[] }

/**
 * Covers of every aligned span (§3.2) of a trail's proved records, from its complete records in position order
 * (`records`; records of other kinds are passed over), numbered from 0: each leaf whose proof verifies and each node over
 * two covered spans of equal height, given to `keep` as made. A cover `held` gives for a span's digest is used as
 * made, not proved again, so walking a trail again proves only its new spans. Memory holds one cover per height.
 * A walk may go on from where an earlier one stood (`from`, with `records` the records after those it read), and stops
 * before the next record once `stop` holds; it returns how many records it read and where it stands.
 */
export async function coverTrail(prover: SpanProver, records: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  held: (digest: bigint) => Uint8Array | undefined, keep: (cover: Cover) => void, options: { readonly from?: CoverWalk; readonly stop?: () => boolean } = {}):
  Promise<{ readonly proved: number; readonly made: number; readonly read: number; readonly stopped: boolean; readonly walk: CoverWalk }> {
  const pending: (Cover | undefined)[] = [...options.from?.pending ?? []];
  let n = options.from?.proved ?? 0, made = 0, read = 0, stopped = false;
  const kept = (cover: Cover): Cover => { keep(cover); made++; return cover; };
  for await (const bytes of records) {
    if (options.stop?.() === true) { stopped = true; break; }
    read++;
    const record = decodeRecord(bytes);
    if (!provedKind(record.kind)) continue;
    let cover: Cover | undefined;
    if (record.proof.length === COVER_PROOF_BYTES) {
      const digest = statementLeafDigest(record.kind, record.publicInputs, sha256(record.proof)), proof = held(digest);
      if (proof !== undefined) cover = { kind: record.kind, digest, proof };
    }
    if (cover === undefined) { const leaf = await prover.leaf(record); if (leaf !== undefined) cover = kept(leaf); }
    for (let h = 0, index = n; ; h++, index = Math.floor(index / 2)) {
      if (index % 2 === 0) { pending[h] = cover; break; }
      const left = pending[h];
      pending[h] = undefined;
      if (left === undefined || cover === undefined) { cover = undefined; continue; }
      const digest = nodeDigest(left.digest, cover.digest), proof = held(digest);
      cover = proof !== undefined ? { kind: undefined, digest, proof } : kept(await prover.node(left, cover));
    }
    n++;
  }
  return { proved: n, made, read, stopped, walk: { proved: n, pending: [...pending] } };
}

/** A test set's prover (§1): a leaf over a proof `statements` accepts, and every node, made by the set's `cover`. */
export function testProver(set: ReturnType<typeof testCheckSet>, statements: ProofCheck): SpanProver {
  return {
    identity: set.identity,
    async leaf(record) {
      if (record.proof.length !== COVER_PROOF_BYTES || await statements.verify(record.kind, [...record.publicInputs], record.proof) !== true) return undefined;
      const digest = statementLeafDigest(record.kind, record.publicInputs, sha256(record.proof));
      return { kind: record.kind, digest, proof: set.cover(record.kind, digest) };
    },
    async node(left, right) {
      const digest = nodeDigest(left.digest, right.digest);
      return { kind: undefined, digest, proof: set.cover(undefined, digest) };
    },
  };
}

/** A set identity's frame (§6): each part u32-length-prefixed. */
export function setFrame(parts: readonly Uint8Array[]): Uint8Array {
  const w = new ByteWriter();
  for (const part of parts) w.lengthPrefixed(part);
  return w.finish();
}

/** A test set (§1): its check proof for a span is SHA-256 over a fixed context, the circuit and the digest. Anyone makes
 * them, so they attest nothing; `cover` makes one, as a prover would after checking the span's proofs natively. */
export function testCheckSet(label: string): CheckSet & { cover(kind: number | undefined, digest: bigint): Uint8Array } {
  const encoder = new TextEncoder(), name = encoder.encode(label);
  const identity = sha256(setFrame([encoder.encode("moe/succinct/v1/set"), encoder.encode("test"), name]));
  const cover = (kind: number | undefined, digest: bigint): Uint8Array =>
    sha256(setFrame([encoder.encode("moe/succinct/v1/test-cover"), identity, Uint8Array.of(kind ?? 0), fieldToBytes(digest)]));
  return Object.freeze({
    identity, test: true, cover,
    verify: (kind: number | undefined, digest: bigint, proof: Uint8Array) => proof instanceof Uint8Array && same(proof, cover(kind, digest)),
  });
}

/** What one trail's establishment hands its replay: each proved record in order, by digest, whether a cover reached it,
 * and the fetched bytes of those it did not, while they fit. */
interface Established {
  readonly digests: Uint8Array;
  readonly covered: Uint8Array;
  readonly held: Map<number, Uint8Array>;
  readonly kinds: Uint8Array;
  /** Each proved record's place and chain value there, which a fetch names. */
  readonly segment: Uint8Array;
  readonly positions: BigUint64Array;
  readonly chains: Uint8Array;
  cursor: number;
}
const ESTABLISHED = new WeakMap<ProofCheck, Established>();
/** The verifier one establishment's replay asks, a fresh object its cursor is kept under. Made here, so its closure
 * holds nothing of the establishment's buffers. */
const relay = (verifier: ProofCheck): ProofCheck => ({ verify: (kind, inputs, proof) => verifier.verify(kind, inputs, proof) });

/** What a span's asks found for each of its records: covered; none, asked alone; none in a wider span, never asked alone
 * (past the first uncovered record); and, for an establishment, a record to ask about once more, unsplit. */
const UNKNOWN = 0, COVERED = 1, NONE = 2, UNSPLIT = 3, ONCE = 4;
/** A segment's partition (§3.4): what asks over the proved records of the served trail of the latest checkpoint the walk
 * holds of it found, from proved-record number `start`, each record by its leaf digest, and that trail's chain value at
 * its length (`top`). A record of any trail of the segment at the same number with the same digest takes what was found
 * for it. */
interface Partition { readonly start: number; readonly digests: Uint8Array; readonly found: Uint8Array; readonly top: Uint8Array }

/**
 * §3.2, §3.4 step 2: asks over the `m` proved records numbered from `start` (their leaf digests `digests` and kinds
 * `kinds`), each aligned span of the canonical partition asked for a cover and split where none verifies. A record
 * `known` resolves (what an earlier partition found for it) is not asked about again. A top span's digests are made
 * once, bottom up. Provers walk a trail in order (`coverTrail`), so what sources cover is mostly a prefix of its proved
 * records: once one record has no cover from any source, the spans after it are asked once each and never split, since
 * splitting them asked about two covers a record of the tail (§3.5) and a missing cover changes no judgment (§2 rule 3).
 * A span all of whose open records `known` names `ONCE` is asked once and never split either. Returns what was found for
 * each record: `COVERED`, `NONE` or `UNSPLIT`.
 */
async function partition(set: CheckSet, supply: CheckSupply, digests: Uint8Array, kinds: Uint8Array, start: number, m: number,
  known: (i: number) => number = () => UNKNOWN): Promise<Uint8Array> {
  const found = new Uint8Array(m), once = new Uint8Array(m);
  for (let i = 0; i < m; i++) { const state = known(i); if (state === ONCE) once[i] = 1; else found[i] = state; }
  const digestAt = (values: Uint8Array, i: number): bigint => bytesToField(values.subarray(32 * i, 32 * i + 32));
  let tail = false;
  const coverSpan = async (s: number, first: number): Promise<void> => {
    const levels = [digests.subarray(32 * (first - start), 32 * (first - start + 2 ** s))];
    for (let l = 1; l <= s; l++) {
      const below = levels[l - 1]!, out = new Uint8Array(below.length / 2);
      for (let j = 0; j < out.length / 32; j++) out.set(fieldToBytes(nodeDigest(digestAt(below, 2 * j), digestAt(below, 2 * j + 1))), 32 * j);
      levels.push(out);
    }
    const ask = async (l: number, j: number): Promise<void> => {
      const index = first - start + j * 2 ** l, end = index + 2 ** l;
      if (found.subarray(index, end).every(state => state !== UNKNOWN)) return;
      const partly = found.subarray(index, end).some(state => state !== UNKNOWN);
      if (!partly) {
        const digest = digestAt(levels[l]!, j), kind = l === 0 ? kinds[index] : undefined;
        // The supply may try its sources' covers by the reader's own check (§2 rule 2); bytes that passed it are not checked again.
        let accepted: Uint8Array | undefined;
        const accept = async (proof: Uint8Array): Promise<boolean> => {
          const own = proof instanceof Uint8Array ? copyBytes(proof) : undefined;
          if (own === undefined || await set.verify(kind, digest, own) !== true) return false;
          accepted = own;
          return true;
        };
        const answer: unknown = await supply.cover(digest, accept);
        if (answer instanceof Uint8Array && ((accepted !== undefined && same(answer, accepted)) || await set.verify(kind, digest, copyBytes(answer)) === true)) {
          found.fill(COVERED, index, end);
          return;
        }
        if (l === 0) { found[index] = NONE; tail = true; return; }
        if (tail || once.subarray(index, end).every(flag => flag === 1)) { found.fill(UNSPLIT, index, end); return; }
      }
      await ask(l - 1, 2 * j);
      await ask(l - 1, 2 * j + 1);
    };
    await ask(s, 0);
  };
  for (let i = start; i < start + m;) {
    let s = 0;
    while (i % 2 ** (s + 1) === 0 && i + 2 ** (s + 1) <= start + m) s++;
    await coverSpan(s, i);
    i += 2 ** s;
  }
  return found;
}

/** Pass 1 of an establishment (§3.4 steps 1–2) over a trail's records after position `from`: each proved record's leaf
 * digest, kind, `proofHash`, position and chain value there, and whether its `proofHash` is the adopted publication's at its position
 * (`block`), in flat arrays sized by the records; and the kind-7 proofs to fetch for their length. */
function provedRecords(trail: ServedTrailOf, from: bigint, block: readonly Adopted[]) {
  // At most one proved record a record after `from`, each in flat arrays: about 107 bytes, plus 32 while its spans are asked.
  const records = trail.length - from;
  if (records < 0n || records > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("a trail past the safe integer range");
  const capacity = Number(records), digests = new Uint8Array(32 * capacity), hashes = new Uint8Array(32 * capacity);
  const kinds = new Uint8Array(capacity), adopted = new Uint8Array(capacity), positions = new BigUint64Array(capacity), chains = new Uint8Array(32 * capacity);
  const requests: { readonly proofHash: Uint8Array; readonly at: RecordAt }[] = [];
  // Each record's chain value, carried forward from the trail's value at `from`: a fetch names the one record it fixes.
  let position = from, m = 0, chain = trail.evidence(from);
  if (chain === undefined) throw new Error("a served trail without its chain value at its tip");
  for (const bytes of trail.records(from)) {
    const at = block[Number(position)];
    position++;
    const record = decodeProofFree(bytes);
    chain = POOL_V3.nextEvidence(chain, proofFreeDigests(record), position);
    // A record whose proofHash is the adopted publication's has the length of the proof the reader holds (§3.5).
    const held = at !== undefined && same(record.proofHash, decodeProofFree(at.bytes).proofHash);
    if (record.kind === 7) { if (!held) requests.push({ proofHash: record.proofHash, at: { segment: trail.segment, position, evidence: chain } }); continue; }
    if (!provedKind(record.kind)) continue;
    if (m === capacity) throw new Error("a served trail holding more records than its length");
    digests.set(fieldToBytes(leafDigest(record)), 32 * m); hashes.set(record.proofHash, 32 * m);
    kinds[m] = record.kind; adopted[m] = held ? 1 : 0; positions[m] = position; chains.set(chain, 32 * m); m++;
  }
  return { capacity, m, digests, hashes, kinds, adopted, positions, chains, requests };
}

/** A pool-v3 reader's construction over proof-free trails, under check set `set` with proofs and check proofs from
 * `supply`. A reader keeping an evidence store across reads passes the same construction (package-reader.ts); it holds
 * only which trails it established, not proof bytes. */
export function succinctPoolV3(options: { readonly set: CheckSet; readonly supply: CheckSupply }): Construction<ProofFreeRecord> {
  const { set, supply } = options;
  if (!(set.identity instanceof Uint8Array) || set.identity.length !== 32 || typeof set.verify !== "function" ||
      supply === null || typeof supply !== "object" || typeof supply.cover !== "function" || typeof supply.proof !== "function") {
    throw new TypeError("a succinct read needs a check set and a supply");
  }
  const identity = copyBytes(set.identity), test = set.test === true;
  /** A publication's proof, carried from its full bytes to the proof-free form the reader reads it as (§3.6), and to the
   * record decoded from that form: held while either is, as the complete read holds the publication itself, so a
   * publication's native check reads the bytes the reader holds and nothing outlives its read. */
  const carried = new WeakMap<object, Uint8Array>();
  const decode = (bytes: Uint8Array): ProofFreeRecord => {
    const record = decodeProofFree(bytes), proof = carried.get(bytes);
    if (proof !== undefined) carried.set(record, proof);
    return record;
  };
  /** The bytes whose SHA-256 is `proofHash` from the supply, or undefined. A supplier's answer past §5's bound is
   * stopped unhashed and its wrong bytes are no bytes: either is a withheld supply. */
  const fetchProof = async (proofHash: Uint8Array, at?: RecordAt): Promise<Uint8Array | undefined> => {
    const answer: unknown = await supply.proof(copyBytes(proofHash), at === undefined ? undefined :
      { segment: copyBytes(at.segment), position: at.position, evidence: copyBytes(at.evidence) });
    if (!(answer instanceof Uint8Array) || answer.length > MAX_PROOF) return undefined;
    const bytes = copyBytes(answer);
    return same(sha256(bytes), proofHash) ? bytes : undefined;
  };
  /** A proof the reader verifies natively when replay reaches its check: held, else fetched; withheld leaves the read unresolved. */
  const proofOf = async (record: ProofFreeRecord, held?: Uint8Array, at?: RecordAt): Promise<Uint8Array> => {
    const bytes = held ?? await fetchProof(record.proofHash, at);
    if (bytes === undefined || !proofLengthHolds(record.kind, bytes.length)) throw new UnestablishedTrail();
    return bytes;
  };
  const native = async (verifier: ProofCheck, record: ProofFreeRecord, held?: Uint8Array, at?: RecordAt): Promise<boolean> =>
    await verifier.verify(record.kind, [...record.publicInputs], await proofOf(record, held, at)) === true;

  /** §3.4 step 4: the replay's statement check, from the trail's establishment where the verifier carries one, else
   * natively (a publication's force, §3.6). */
  const check = async (record: ProofFreeRecord, verifier: ProofCheck): Promise<void> => {
    const established = ESTABLISHED.get(verifier);
    if (established === undefined) { requireReplay(await native(verifier, record, carried.get(record)), "PROOF"); return; }
    // Replay asks in position order, so the record is the next proved record with its digest.
    const digest = fieldToBytes(leafDigest(record)), count = established.kinds.length;
    let i = established.cursor;
    while (i < count && !same(established.digests.subarray(32 * i, 32 * i + 32), digest)) i++;
    if (i === count) throw new Error("a record its trail's establishment did not reach");
    established.cursor = i + 1;
    if (established.covered[i] === 1) return;
    requireReplay(await native(verifier, record, established.held.get(i), { segment: established.segment, position: established.positions[i]!, evidence: established.chains.slice(32 * i, 32 * i + 32) }), "PROOF");
  };

  /** The segment's partition (§3.4) from proved record `start` on: the one kept where it starts at or before it (a
   * record past its end, as on a longer fork, is partitioned with its own trail), else one made over the latest served
   * trail the walk names for the segment (`trail.latest`), from `start` on. Undefined where there is none longer than
   * this trail, which is then partitioned on its own. */
  const partitionOf = async (trail: ServedTrailOf, from: bigint, start: number, end: number, block: readonly Adopted[]): Promise<Partition | undefined> => {
    const latest = trail.latest;
    if (start === end || latest === undefined || !same(latest.segment, trail.segment)) return undefined;
    const kept = partitions.get(latest);
    if (kept !== undefined && kept.start <= start) return kept;
    if (latest.length <= trail.length) return undefined;
    const top = latest.evidence(latest.length);
    if (top === undefined) return undefined;
    const wide = provedRecords(latest, from, block);
    const found = await partition(set, supply, wide.digests, wide.kinds, start, wide.m);
    const made = { start, digests: wide.digests.slice(0, 32 * wide.m), found, top: copyBytes(top) };
    partitions.set(latest, made);
    return made;
  };
  /** Each walk's partitions, by the latest trail object it names a segment's checkpoints (scope-reader.ts): kept for that
   * walk only, so a later read, or a retry, asks again what an earlier one found none for. */
  const partitions = new WeakMap<ServedTrailOf, Partition>();

  const trailChecks: TrailChecks = {
    async establish(trail, from, proved, block, verifier) {
      // Pass 1 (§3.4 steps 1–2): each proved record's digest, kind and proofHash; kind-7 proofs to fetch for their length.
      const { capacity, m, digests, hashes, kinds, adopted, positions, chains, requests } = provedRecords(trail, from, block);
      const start = Number(proved);
      if (!Number.isSafeInteger(start + m)) throw new RangeError("a trail past the safe integer range");
      // §3.4: a record the segment's partition covered at its number, with its digest, is covered, and one it asked about
      // alone and found none for has none. One it found none for only in a wider span is asked again under this trail's
      // own spans, once each and unsplit: past a gap in the covers that partition's spans can be wider than the covers
      // this trail's spans meet. The others are partitioned with this trail. The partitioned trail itself, from the same
      // record, would meet the same spans again.
      const wide = await partitionOf(trail, from, start, start + m, block);
      const itself = wide !== undefined && start === wide.start && same(trail.evidence(trail.length) ?? new Uint8Array(), wide.top);
      const known = wide === undefined ? undefined : (i: number): number => {
        const w = start + i - wide.start;
        if (w < 0 || w >= wide.found.length || !same(wide.digests.subarray(32 * w, 32 * w + 32), digests.subarray(32 * i, 32 * i + 32))) return UNKNOWN;
        return wide.found[w] === UNSPLIT && !itself ? ONCE : wide.found[w]!;
      };
      const found = await partition(set, supply, digests, kinds, start, m, known);
      const covered = found.map(state => state === COVERED ? 1 : 0);
      // Pass 2 (§3.4 step 3): every other proof's bytes, fetched for their length; verified only when replay asks (step 4).
      const held = new Map<number, Uint8Array>();
      let room = HELD_BYTES;
      for (let i = 0; i < m; i++) {
        if (covered[i] === 1 || adopted[i] === 1) continue;
        const bytes = await fetchProof(hashes.subarray(32 * i, 32 * i + 32), { segment: trail.segment, position: positions[i]!, evidence: chains.slice(32 * i, 32 * i + 32) });
        if (bytes === undefined || !proofLengthHolds(kinds[i] as Kind, bytes.length)) throw new UnestablishedTrail();
        if (bytes.length <= room) { held.set(i, bytes); room -= bytes.length; }
      }
      for (const { proofHash, at } of requests) {
        const bytes = await fetchProof(proofHash, at);
        if (bytes === undefined || !proofLengthHolds(7, bytes.length)) throw new UnestablishedTrail();
      }
      const replayCheck = relay(verifier);
      // The cursor keeps the proved records' entries alone, not buffers sized for every record after the tip.
      const own = <T extends Uint8Array | BigUint64Array>(values: T, length: number): T =>
        (m === capacity ? values.subarray(0, length) : values.slice(0, length)) as T;
      ESTABLISHED.set(replayCheck, { digests: own(digests, 32 * m), kinds: own(kinds, m), covered, held,
        segment: copyBytes(trail.segment), positions: own(positions, m), chains: own(chains, 32 * m), cursor: 0 });
      // Records before a resumed tip were established when the namespace holding them replayed them, under these rules.
      servedTrails.add(servedKey(trail));
      return replayCheck;
    },
    async served(trail, block, verifier) {
      if (!servedTrails.has(servedKey(trail))) await trailChecks.establish(trail, 0n, 0n, block, verifier);
    },
  };
  /** Trails whose every length this construction has established, each by its segment and its chain value at its length,
   * which fixes every record (pool-v3 §7.1). */
  const servedTrails = new Set<string>();
  const servedKey = (trail: ServedTrailOf): string => `${hex(trail.segment)}:${trail.length}:${hex(trail.evidence(trail.length) ?? new Uint8Array())}`;

  const v3Reader = POOL_V3.reader;
  const reader: ReaderFrames = Object.freeze({
    ...v3Reader,
    specification: `${v3Reader.specification}; ${SUCCINCT_SPECIFICATION}; ${test ? "test " : ""}set ${hex(identity)}`,
    trail: Object.freeze({ ...PROOF_FREE_TRAILS, maxRecordBytes: MAX_TRAIL_RECORD_BYTES }),
    digests: (bytes: Uint8Array) => proofFreeDigests(decodeProofFree(bytes)),
    // §3.6: a publication's record is read as its proof-free form, its proof held for its native check.
    publication: (bytes: Uint8Array): PublicationView => {
      const p = decodePublication(bytes);
      if (p.kind === 2) return { domain: p.domain, backing: p.backing, kind: p.kind, record: undefined };
      const form = encodeProofFree(proofFreeOf(p.record));
      carried.set(form, copyBytes(p.record.proof));
      return { domain: p.domain, backing: p.backing, kind: p.kind, record: form };
    },
    request: (bytes: Uint8Array): RequestView => {
      const record = decode(bytes);
      if (record.kind !== 7) throw new EncodingError("not a request");
      const p = record.publicInputs, anchor = p[4]!;
      return { identity: hex(statementHash(record)), tag: p[5]!, reads: state => state.hasAnchor(anchor),
        // A withheld request proof leaves the count unresolved, never "does not hold" (§2 rule 3).
        holds: verifier => native(verifier, record, carried.get(record)) };
    },
  });
  return Object.freeze({
    ...POOL_V3,
    decode,
    kind: (record: ProofFreeRecord) => record.kind,
    view: (record: ProofFreeRecord) => v3View(record, proofFreeDigests(record), verifier => check(record, verifier)),
    settledDemand: (bytes: Uint8Array) => recoveryEffect(decodeProofFree(bytes)).ended!,
    scanOutput: POOL_V3.scanOutput as unknown as Construction<ProofFreeRecord>["scanOutput"],
    reader,
    journal: Object.freeze({ ...POOL_V3.journal,
      encode: () => { throw new TypeError("a succinct read keeps no journal"); },
      identity: (record: ProofFreeRecord) => statementHash(record) }) as unknown as Construction<ProofFreeRecord>["journal"],
    trailChecks,
  });
}
