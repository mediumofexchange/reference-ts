// pool-v3 §10.1 and §12.1 over decoded trails: a trail's evidence chain, and
// a checkpoint's served trail as the prefix of any supplied trail of its
// segment that reproduces the checkpoint's evidence hash.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "./commitments.js";
import { decodeSegmentHeader } from "./headers.js";
import { decodeRecord, evidenceHashes, type Record } from "./records.js";
import type { ServedTrail } from "./trail.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** A checkpoint's expected snapshot: its backing, its segment and the digest its directory names. */
export interface ExpectedSnapshot {
  readonly backing: Uint8Array;
  readonly segment: Uint8Array;
  readonly digest: Uint8Array;
}

interface Chain {
  readonly chain: readonly Uint8Array[];
  positions?: Map<string, number>;
  prefixes?: Map<number, ServedTrail>;
}
// A decoded trail's evidence chain depends only on its own header and records
// (pool-v3 §7), so one read computes it once per trail object.
const chains = new WeakMap<ServedTrail, Chain>();

/** Position i holds evidenceHash_i, over the longest prefix whose records decode under §5. */
export function trailEvidenceChain(trail: ServedTrail): readonly Uint8Array[] {
  const cached = chains.get(trail);
  if (cached !== undefined) return cached.chain;
  const chain = [genesisEvidenceHash(sha256(trail.header))];
  for (const [i, bytes] of trail.records.entries()) {
    let record: Record;
    try { record = decodeRecord(bytes); } catch (error) {
      if (!(error instanceof EncodingError)) throw error;
      break;
    }
    chain.push(nextEvidenceHash(chain[i]!, evidenceHashes(record), BigInt(i) + 1n));
  }
  chains.set(trail, { chain });
  return chain;
}

function positionOf(trail: ServedTrail, evidenceHash: Uint8Array): number | undefined {
  trailEvidenceChain(trail);
  const entry = chains.get(trail)!;
  entry.positions ??= new Map(entry.chain.map((value, i) => [hex(value), i]));
  return entry.positions.get(hex(evidenceHash));
}

/** The trail cut at n: its header and terms with its first n records (§10). */
function prefixOf(trail: ServedTrail, n: number): ServedTrail {
  if (n === trail.records.length) return trail;
  const entry = chains.get(trail)!;
  entry.prefixes ??= new Map();
  let prefix = entry.prefixes.get(n);
  if (prefix === undefined) {
    prefix = Object.freeze({ header: trail.header, terms: trail.terms, records: Object.freeze(trail.records.slice(0, n)) });
    chains.set(prefix, { chain: entry.chain.slice(0, n + 1) });
    entry.prefixes.set(n, prefix);
  }
  return prefix;
}

/** pool-v3 §12.1: a checkpoint's served trail is the prefix of any supplied
 * trail of its segment whose decodable first n records reproduce the
 * snapshot's evidence hash (at n = 0, the seed); later records are not its
 * evidence. Matching prefixes share header and records, so the first one is
 * the dependency. §10.1's recurrence is the cached chain; the remaining §10.1
 * checks bind the snapshot to the expected digest and the header scope to the
 * backing. Terms are resolved separately, by backing name. */
export function servedTrail(expected: ExpectedSnapshot, snapshot: Snapshot, trails: readonly ServedTrail[]): ServedTrail | undefined {
  if (!same(snapshot.backing, expected.backing) || !same(snapshot.segment, expected.segment) ||
      !same(snapshotDigest(snapshot), expected.digest)) return undefined;
  for (const trail of trails) {
    // Another segment's trail fails §10.1 before any record is decoded.
    if (!same(sha256(trail.header), expected.segment)) continue;
    if (!decodeSegmentHeader(trail.header).entries.some(entry => same(entry.backing, expected.backing))) continue;
    const n = positionOf(trail, snapshot.evidenceHash);
    if (n !== undefined) return prefixOf(trail, n);
  }
  return undefined;
}
