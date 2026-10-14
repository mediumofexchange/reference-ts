// A replica (slice 12 M12b): a reader's kept, verified evidence served through the one wire. It signs nothing and admits
// nothing. For each backing it serves the latest selection its own read found canonical, with that read's own package
// (the configuration, the operator-signed commitment and any faults), and what its evidence file indexed after the sequence a reader
// names (`EvidenceStore.served`): a reader served through one of its selections is served everything kept since. The
// selections are kept in that file. A reader authenticates everything it keeps and judges at its own index, as with any
// source (pool-v3 §14).
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "../../bytes.js";
import { decodeCommitment, verifyCommitment } from "../../venue-records.js";
import { POOL_V3, type Construction } from "./construction.js";
import { EvidenceStore, formServes, type EvidenceBatch, type StoredTrail, type TrailForm } from "./evidence-store.js";
import { fieldToBytes } from "../field.js";
import type { V3EvidenceSource } from "./service-http.js";
import { V3StoreError, type ServedEvidence, type ServedPackage } from "./store.js";
import { coverTrail, recordProof, type CoverWalk, type RecordAt, type SpanProver } from "./succinct.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
/** Walk positions a replica keeps a segment: an operator's equivocation leaves at most a few forks among its own reads. */
const WALKS = 4;
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

  /** Where the last walks of each segment stood, by set identity and segment, most recent first (at most WALKS, so forks
   * of one segment keep their own): the position and chain value each had read through, and its covers pending. */
  readonly #walks = new Map<string, readonly { readonly position: bigint; readonly evidence: Uint8Array; readonly walk: CoverWalk }[]>();

  /** The served trails of the selections this replica's own read kept: for each, every snapshot its directory names, by
   * its segment and chain value; and back from each segment, the trail of the checkpoint each scoped entry's opening
   * names (the earlier segment it imports, pool-v3 §8), so a segment a rescope or a succession left behind stays
   * covered. All are named by commitments the operator signed: a trail a supplier's answer alone brought (a fork, a
   * lengthened trail) is none of them. */
  #selectedTrails(batch: EvidenceBatch): StoredTrail[] {
    const construction = this.#evidence.construction, trails = new Map<string, StoredTrail>();
    const named: { readonly root: Uint8Array; readonly backing?: Uint8Array }[] = [...this.#selections.values()].map(served => ({ root: served.selection.root }));
    const roots = new Set<string>();
    for (let next = named.pop(); next !== undefined; next = named.pop()) {
      const key = `${bytesToHex(next.root)}:${next.backing === undefined ? "" : bytesToHex(next.backing)}`;
      if (roots.has(key)) continue;
      roots.add(key);
      for (const entry of batch.directory(next.root) ?? []) {
        if (next.backing !== undefined && !same(entry.name, next.backing)) continue;
        const bytes = batch.snapshot(entry.digest);
        if (bytes === undefined) continue;
        let snapshot, header;
        try { snapshot = construction.reader.snapshot.decode(bytes); } catch (error) { if (error instanceof EncodingError) continue; throw error; }
        const trail = batch.trail(snapshot.segment, snapshot.evidenceHash);
        if (trail === undefined) continue;
        const id = `${bytesToHex(snapshot.segment)}:${bytesToHex(snapshot.evidenceHash)}`;
        if (trails.has(id)) continue;
        trails.set(id, trail);
        try { header = construction.reader.header.decodeSegmentHeader(trail.header); } catch (error) { if (error instanceof EncodingError) continue; throw error; }
        for (const scoped of header.entries) if (scoped.opening !== undefined) named.push({ root: scoped.opening.root, backing: scoped.backing });
      }
    }
    // Each segment's furthest first, so a shorter one it reaches is walked with it.
    return [...trails.values()].sort((a, b) => compareBytes(a.segment, b.segment) || (a.length > b.length ? -1 : a.length < b.length ? 1 : 0));
  }

  /**
   * Prove covers (succinct-read §§2 rule 6, 3.2) over the served trails of the selections this replica kept, with
   * `prover`, keeping each in the replica's file under the prover's set identity, which serves them. Each segment's
   * trails are walked from their furthest, and one a walked trail reaches is walked with it; a span already kept is not
   * proved again. A walk goes on from where this replica's last walk of the segment stood, where the trail still passes
   * through it, so a long trail is read once, not every time; `stop` ends the walk before its next record, and the next
   * call goes on. `read` counts the records this call read.
   */
  async prove(prover: SpanProver, options: { readonly stop?: () => boolean } = {}):
    Promise<{ readonly trails: number; readonly proved: number; readonly made: number; readonly read: number; readonly stopped: boolean }> {
    // Covers are of pool-v3 statement proofs (§3.2): a replica of proof-free trails, or of another construction, has none to cover.
    const construction = this.#evidence.construction;
    if (construction.trailChecks !== undefined || construction.namespace.name !== POOL_V3.namespace.name) {
      throw new V3StoreError("UNSUPPORTED", "the replica holds no pool-v3 proofs to cover");
    }
    const set: unknown = prover?.identity;
    if (!(set instanceof Uint8Array) || set.length !== 32) throw new TypeError("a prover of a set with a 32-byte identity");
    const own = copyBytes(set), batch = this.#evidence.retained(), walked: StoredTrail[] = [];
    let proved = 0, made = 0, read = 0, stopped = false;
    try {
      for (const trail of this.#selectedTrails(batch)) {
        if (stopped) break;
        let reached = false;
        const top = trail.evidence(trail.length)!;
        for (const other of walked) {
          if (same(other.segment, trail.segment) && other.length >= trail.length && await other.reaches(trail.length, top) !== undefined) { reached = true; break; }
        }
        if (reached) continue;
        walked.push(trail);
        // The furthest earlier walk this trail passes through.
        const key = `${bytesToHex(own)}:${bytesToHex(trail.segment)}`, walks = this.#walks.get(key) ?? [];
        let from: typeof walks[number] | undefined;
        for (const kept of walks) {
          if (kept.position <= trail.length && (from === undefined || kept.position > from.position) && await trail.reaches(kept.position, kept.evidence) !== undefined) from = kept;
        }
        // The chain value is carried over each record the walk reads (pool-v3 §7), so a stopped walk records where it
        // stood without walking the trail back from its top.
        const after = from?.position ?? 0n;
        let position = after, value = from?.evidence ?? construction.genesisEvidence(trail.segment);
        const records = (async function* () {
          for await (const bytes of trail.stream(after)) {
            const next = construction.nextEvidence(value, construction.reader.digests(bytes), position + 1n);
            yield bytes;
            value = next; position++;
          }
        })();
        const done = await coverTrail(prover, records, digest => this.#evidence.cover(own, fieldToBytes(digest)),
          cover => this.#evidence.keepCover(own, fieldToBytes(cover.digest), cover.proof), { ...(from === undefined ? {} : { from: from.walk }),
            ...(options.stop === undefined ? {} : { stop: options.stop }) });
        if (position !== after + BigInt(done.read)) throw new Error("a walk's position and its records read disagree");
        this.#walks.set(key, [{ position, evidence: value, walk: done.walk }, ...walks.filter(kept => kept !== from)].slice(0, WALKS));
        proved += done.proved; made += done.made; read += done.read; stopped = done.stopped;
      }
      // A whole round walked every segment it proves: the positions of segments it no longer proves are dropped.
      if (!stopped) {
        const prefix = `${bytesToHex(own)}:`, live = new Set(walked.map(trail => `${prefix}${bytesToHex(trail.segment)}`));
        for (const key of [...this.#walks.keys()]) if (key.startsWith(prefix) && !live.has(key)) this.#walks.delete(key);
      }
    } finally { batch.release(); }
    return { trails: walked.length, proved, made, read, stopped };
  }

  /** A succinct reader's fetch (succinct-read §3.5): the proof of a record kept at `at` whose SHA-256 is `proofHash`. */
  proof(proofHash: Uint8Array, at: RecordAt): Uint8Array | undefined {
    return this.#evidence.construction.trailChecks !== undefined ? undefined : recordProof(this.#evidence.recordAt(at.segment, at.position, at.evidence), proofHash);
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
