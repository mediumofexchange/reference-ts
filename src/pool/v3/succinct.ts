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
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import { SUCCINCT_TRAIL_CONTEXT, V3_SEGMENT_CONTEXT } from "../../contexts.js";
import { bytesToField, fieldToBytes, limbsOf } from "../field.js";
import { poseidon2Hash } from "../poseidon2.js";
import { POOL_V3, v3View, type Construction, type PublicationView, type ReaderFrames, type RequestView, type ServedTrailOf, type TrailChecks } from "./construction.js";
import {
  decodeProofFree, decodePublication, decodeRecord, encodeProofFree, proofFreeDigests, proofFreeOf, proofLengthHolds, statementHash,
  type ProofFreeRecord,
} from "./records.js";
import { recoveryEffect } from "./recovery.js";
import { requireReplay, UnestablishedTrail } from "./refusals.js";
import type { Adopted, ProofCheck } from "./state.js";
import { MAX_ROOT_TERMS_BYTES } from "./terms.js";
import { MAX_TRAIL_RECORD_BYTES, trailCodec, type ServedTrail } from "./trail.js";

/** The revision of succinct-read.md these rules implement; it names kept state with the set identity (§2 rule 8). */
export const SUCCINCT_SPECIFICATION = "succinct-read cb84f04";
export const T_CHECK_LEAF = 1008n;
export const T_CHECK_NODE = 1009n;
/** The proof length a cover fixes (§3.2): 458 field elements. */
export const COVER_PROOF_BYTES = 14656;
/** Kinds with a proof check, whose records are the trail's proved records (§3.2). */
const PROVED = new Set([1, 2, 3, 4, 6]);
/** Fetched proof bytes a trail's establishment holds for its replay; past it, replay fetches a proof again. */
const HELD_BYTES = 64 << 20;
/** Pool-v3 §5's bound on a proof field: a supplier's longer answer is stopped unhashed, a withheld supply (§3.4 step 3). */
const MAX_PROOF = 131072;

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** The proof-free trail (§3.3): pool-v3 §10's frame and bounds under its own context. */
export const PROOF_FREE_TRAILS = trailCodec({ context: SUCCINCT_TRAIL_CONTEXT, headerContext: V3_SEGMENT_CONTEXT,
  maxRecordBytes: MAX_TRAIL_RECORD_BYTES, maxTermsBytes: MAX_ROOT_TERMS_BYTES });

/** A complete trail's proof-free trail, which any holder of it derives (§3.3). EncodingError where a record does not
 * decode under §5: it has no proof-free form. */
export function proofFreeTrail(trail: ServedTrail): ServedTrail {
  return { header: copyBytes(trail.header), terms: trail.terms.map(t => ({ terms: copyBytes(t.terms), signature: copyBytes(t.signature) })),
    records: trail.records.map(bytes => encodeProofFree(proofFreeOf(decodeRecord(bytes)))) };
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
  /** A check proof whose digest is `digest` (§3.2). */
  cover(digest: bigint): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  /** The bytes whose SHA-256 is `proofHash` (§3.5). */
  proof(proofHash: Uint8Array): Promise<Uint8Array | undefined> | Uint8Array | undefined;
}

/** A test set (§1): its check proof for a span is SHA-256 over a fixed context, the circuit and the digest. Anyone makes
 * them, so they attest nothing; `cover` makes one, as a prover would after checking the span's proofs natively. */
export function testCheckSet(label: string): CheckSet & { cover(kind: number | undefined, digest: bigint): Uint8Array } {
  const encoder = new TextEncoder(), name = encoder.encode(label);
  const frame = (parts: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0)), view = new DataView(out.buffer);
    let at = 0;
    for (const part of parts) { view.setUint32(at, part.length); out.set(part, at + 4); at += 4 + part.length; }
    return out;
  };
  const identity = sha256(frame([encoder.encode("moe/succinct/v1/set"), encoder.encode("test"), name]));
  const cover = (kind: number | undefined, digest: bigint): Uint8Array =>
    sha256(frame([encoder.encode("moe/succinct/v1/test-cover"), identity, Uint8Array.of(kind ?? 0), fieldToBytes(digest)]));
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
  readonly hashes: Uint8Array;
  readonly kinds: Uint8Array;
  cursor: number;
}
const ESTABLISHED = new WeakMap<ProofCheck, Established>();

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
  const fetchProof = async (proofHash: Uint8Array): Promise<Uint8Array | undefined> => {
    const answer: unknown = await supply.proof(copyBytes(proofHash));
    if (!(answer instanceof Uint8Array) || answer.length > MAX_PROOF) return undefined;
    const bytes = copyBytes(answer);
    return same(sha256(bytes), proofHash) ? bytes : undefined;
  };
  /** A proof the reader verifies natively when replay reaches its check: held, else fetched; withheld leaves the read unresolved. */
  const proofOf = async (record: ProofFreeRecord, held?: Uint8Array): Promise<Uint8Array> => {
    const bytes = held ?? await fetchProof(record.proofHash);
    if (bytes === undefined || !proofLengthHolds(record.kind, bytes.length)) throw new UnestablishedTrail();
    return bytes;
  };
  const native = async (verifier: ProofCheck, record: ProofFreeRecord, held?: Uint8Array): Promise<boolean> =>
    await verifier.verify(record.kind, [...record.publicInputs], await proofOf(record, held)) === true;

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
    requireReplay(await native(verifier, record, established.held.get(i)), "PROOF");
  };

  const trailChecks: TrailChecks = {
    async establish(trail, from, proved, block, verifier) {
      const records = trail.records(from);
      // Pass 1 (§3.4 steps 1–2): each proved record's digest, kind and proofHash; kind-7 proofs to fetch for their length.
      const digests: Uint8Array[] = [], hashes: Uint8Array[] = [], kinds: number[] = [], adopted: boolean[] = [], requests: Uint8Array[] = [];
      let position = from;
      for (const bytes of records) {
        const at = block[Number(position)];
        position++;
        const record = decodeProofFree(bytes);
        // A record whose proofHash is the adopted publication's has the length of the proof the reader holds (§3.5).
        const held = at !== undefined && same(record.proofHash, decodeProofFree(at.bytes).proofHash);
        if (record.kind === 7) { if (!held) requests.push(record.proofHash); continue; }
        if (!PROVED.has(record.kind)) continue;
        digests.push(fieldToBytes(leafDigest(record))); hashes.push(record.proofHash); kinds.push(record.kind); adopted.push(held);
      }
      const m = kinds.length, start = Number(proved);
      if (!Number.isSafeInteger(start + m)) throw new RangeError("a trail past the safe integer range");
      const covered = new Uint8Array(m);
      // §3.2, §3.4 step 2: aligned spans over proved-record numbers, each asked for a cover, split where none verifies.
      const spanDigest = (s: number, first: number, memo: Map<string, bigint>): bigint => {
        const key = `${s}:${first}`;
        let value = memo.get(key);
        if (value === undefined) {
          value = s === 0 ? bytesToField(digests[first - start]!) :
            nodeDigest(spanDigest(s - 1, first, memo), spanDigest(s - 1, first + 2 ** (s - 1), memo));
          memo.set(key, value);
        }
        return value;
      };
      const cover = async (s: number, first: number, memo: Map<string, bigint>): Promise<void> => {
        const digest = spanDigest(s, first, memo), answer: unknown = await supply.cover(digest);
        if (answer instanceof Uint8Array && await set.verify(s === 0 ? kinds[first - start] : undefined, digest, copyBytes(answer)) === true) {
          covered.fill(1, first - start, first - start + 2 ** s);
          return;
        }
        if (s === 0) return;
        await cover(s - 1, first, memo);
        await cover(s - 1, first + 2 ** (s - 1), memo);
      };
      for (let i = start; i < start + m;) {
        let s = 0;
        while (i % 2 ** (s + 1) === 0 && i + 2 ** (s + 1) <= start + m) s++;
        await cover(s, i, new Map());
        i += 2 ** s;
      }
      // Pass 2 (§3.4 step 3): every other proof's bytes, fetched for their length; verified only when replay asks (step 4).
      const held = new Map<number, Uint8Array>();
      let room = HELD_BYTES;
      for (let i = 0; i < m; i++) {
        if (covered[i] === 1 || adopted[i] === true) continue;
        const bytes = await fetchProof(hashes[i]!);
        if (bytes === undefined || !proofLengthHolds(kinds[i] as 1, bytes.length)) throw new UnestablishedTrail();
        if (bytes.length <= room) { held.set(i, bytes); room -= bytes.length; }
      }
      for (const proofHash of requests) {
        const bytes = await fetchProof(proofHash);
        if (bytes === undefined || !proofLengthHolds(7, bytes.length)) throw new UnestablishedTrail();
      }
      const flat = (parts: readonly Uint8Array[]): Uint8Array => {
        const out = new Uint8Array(32 * parts.length);
        parts.forEach((part, i) => out.set(part, 32 * i));
        return out;
      };
      const replayCheck: ProofCheck = { verify: (kind, inputs, proof) => verifier.verify(kind, inputs, proof) };
      ESTABLISHED.set(replayCheck, { digests: flat(digests), hashes: flat(hashes), kinds: Uint8Array.from(kinds), covered, held, cursor: 0 });
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
