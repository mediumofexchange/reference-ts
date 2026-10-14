// A replica (slice 12 M12b): a reader's kept, verified evidence served through the one wire. It signs nothing and admits
// nothing. For each backing it serves the latest selection its own read found canonical, with that read's own package
// (the configuration, the operator-signed commitment and any faults), and what its evidence file indexed after the sequence a reader
// names (`EvidenceStore.served`): a reader served through one of its selections is served everything kept since. The
// selections are kept in that file. A reader authenticates everything it keeps and judges at its own index, as with any
// source (pool-v3 §14).
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes } from "../../bytes.js";
import { decodeCommitment, verifyCommitment } from "../../venue-records.js";
import type { Construction } from "./construction.js";
import { EvidenceStore, formServes, type StoredTrail, type TrailForm } from "./evidence-store.js";
import { fieldToBytes } from "../field.js";
import type { V3EvidenceSource } from "./service-http.js";
import { V3StoreError, type ServedEvidence, type ServedPackage } from "./store.js";
import { coverTrail, proofAmong, type RecordAt, type SpanProver } from "./succinct.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const copied = (served: ServedPackage): ServedPackage => ({ selection: { ...served.selection, domain: copyBytes(served.selection.domain),
  venue: copyBytes(served.selection.venue), backing: copyBytes(served.selection.backing), operator: copyBytes(served.selection.operator),
  root: copyBytes(served.selection.root) }, package: copyBytes(served.package) });

/** The selection a read's own package names: its one commitment, which the operator signed. Undefined for a package
 * that carries no single valid commitment. */
export function selectionOf(ownPackage: Uint8Array, construction: Construction, context: { readonly venue: Uint8Array; readonly backing: Uint8Array }):
  ServedPackage | undefined {
  let signed;
  try {
    signed = construction.reader.package.decodeEvidencePackage(ownPackage).filter(item => item.kind === 2).map(item => decodeCommitment(item.payload));
  } catch { return undefined; }
  if (signed.length !== 1 || !verifyCommitment(signed[0]!) || signed[0]!.sequence >= 1n << 63n) return undefined;
  const c = signed[0]!;
  return copied({ selection: { domain: construction.reader.domain(), venue: context.venue, backing: context.backing, operator: c.operator,
    sequence: c.sequence, root: c.root }, package: ownPackage });
}

export class V3Replica implements V3EvidenceSource {
  readonly #path: string;
  readonly #evidence: EvidenceStore;
  readonly #selections = new Map<string, ServedPackage>();

  /** `evidence` is the replica's own store, opened `shared` on the file at `path`; the selections it kept are served
   * again, read under `venue` (the replica's venue identity). */
  constructor(path: string, evidence: EvidenceStore, venue: Uint8Array) {
    this.#path = path; this.#evidence = evidence;
    for (const kept of evidence.selections()) {
      const served = selectionOf(kept.package, evidence.construction, { venue, backing: kept.backing });
      if (served !== undefined) this.#selections.set(bytesToHex(kept.backing), served);
    }
  }

  /** The selection served for `backing`, if any. */
  selection(backing: Uint8Array): ServedPackage | undefined {
    const kept = this.#selections.get(bytesToHex(backing));
    return kept === undefined ? undefined : copied(kept);
  }

  /** Serve `served` for its backing from now on: a selection the replica's own read over its evidence file found
   * canonical at its witnessed index, so the file holds what a read of it needs. What the file kept of that operator's
   * evidence since is indexed under it where it is above every selection of that operator served before
   * (`EvidenceStore.keepSelection`); one below is kept out (false). A backing whose operator changed is served by the new
   * operator's selections. */
  keep(served: ServedPackage): boolean {
    const key = bytesToHex(served.selection.backing), held = this.#selections.get(key);
    if (held !== undefined && same(held.selection.operator, served.selection.operator) && held.selection.sequence > served.selection.sequence) return false;
    const own = copied(served);
    if (!this.#evidence.keepSelection(own.selection.backing, own.package, own.selection.operator, own.selection.sequence)) return false;
    this.#selections.set(key, own);
    return true;
  }

  /**
   * Prove covers (succinct-read §§2 rule 6, 3.2) over the replica's kept trails with `prover`, keeping each in the
   * replica's file under the prover's set identity, which serves them. Each segment's trails are walked from their
   * furthest top, and a top a walked trail reaches is walked with it; a span already kept is not proved again.
   */
  async prove(prover: SpanProver): Promise<{ readonly trails: number; readonly proved: number; readonly made: number }> {
    if (this.#evidence.construction.trailChecks !== undefined) throw new V3StoreError("UNSUPPORTED", "the replica holds no proofs to cover");
    const set: unknown = prover?.identity;
    if (!(set instanceof Uint8Array) || set.length !== 32) throw new TypeError("a prover of a set with a 32-byte identity");
    const own = copyBytes(set), batch = this.#evidence.retained(), walked: StoredTrail[] = [];
    let proved = 0, made = 0;
    try {
      for (const top of this.#evidence.keptTops()) {
        let reached = false;
        for (const trail of walked) {
          if (same(trail.segment, top.segment) && trail.length >= top.position && await trail.reaches(top.position, top.evidence) !== undefined) { reached = true; break; }
        }
        const trail = reached ? undefined : batch.trail(top.segment, top.evidence);
        if (trail === undefined) continue;
        walked.push(trail);
        const done = await coverTrail(prover, trail.stream(), digest => this.#evidence.cover(own, fieldToBytes(digest)),
          cover => this.#evidence.keepCover(own, fieldToBytes(cover.digest), cover.proof));
        proved += done.proved; made += done.made;
      }
    } finally { batch.release(); }
    return { trails: walked.length, proved, made };
  }

  /** A succinct reader's fetch (succinct-read §3.5): the proof of a record kept at `at` whose SHA-256 is `proofHash`. */
  proof(proofHash: Uint8Array, at: RecordAt): Uint8Array | undefined {
    return this.#evidence.construction.trailChecks !== undefined ? undefined : proofAmong(this.#evidence.recordsAt(at.segment, at.position), proofHash);
  }
  /** A check proof a prover kept in the replica's file for `digest` under set `set` (§3.2). */
  cover(set: Uint8Array, digest: Uint8Array): Uint8Array | undefined { return this.#evidence.cover(set, digest); }

  /** `form` asks for the kept trails in that form (succinct-read §3.3's proof-free form): a replica whose own evidence
   * is proof-free serves its trails as kept, and refuses the complete form it does not hold. */
  async serve(backing: Uint8Array, after: bigint, form?: TrailForm): Promise<ServedEvidence> {
    const kept = this.#selections.get(bytesToHex(backing));
    if (kept === undefined) throw new V3StoreError("STALE", "the replica holds no read of this backing");
    const construction = this.#evidence.construction, proofFree = construction.trailChecks !== undefined;
    if (proofFree && form === undefined) throw new V3StoreError("UNSUPPORTED", "the replica holds proof-free trails only");
    if (!formServes(form, construction)) throw new V3StoreError("UNSUPPORTED", "the replica's records have no such form");
    const served = copied(kept);
    return { ...served, parts: EvidenceStore.served(this.#path, construction, served.selection.operator, served.selection.sequence, after,
      proofFree ? undefined : form) };
  }
}
