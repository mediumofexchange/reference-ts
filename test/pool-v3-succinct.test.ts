import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { ByteWriter, compareBytes } from "../src/bytes.js";
import { SUCCINCT_TRAIL_CONTEXT } from "../src/contexts.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { poseidon2Hash } from "../src/pool/poseidon2.js";
import { ScopeTree } from "../src/pool/scope.js";
import { snapshotBytes } from "../src/pool/v3/commitments.js";
import { adoptedConfiguration, configurationBytes, configurationHash } from "../src/pool/v3/configuration.js";
import { POOL_V3 } from "../src/pool/v3/construction.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import {
  decodeProofFree, decodeRecord, deliveryHash, encodeProofFree, encodePublication, encodeRecord, evidenceHashes, hashEvidenceFields, proofFreeDigests, proofFreeOf,
  statementBytes, statementHash, type ProofFreeRecord, type Record,
} from "../src/pool/v3/records.js";
import { EvidenceRefusal, ReplayRefusal } from "../src/pool/v3/refusals.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState } from "../src/pool/v3/state.js";
import {
  COVER_PROOF_BYTES, coverTrail, leafDigest, nodeDigest, PROOF_FREE_TRAILS, succinctPoolV3, T_CHECK_LEAF, T_CHECK_NODE, testCheckSet, testProver, type CheckSupply,
} from "../src/pool/v3/succinct.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";

// Succinct reading (succinct-read §§2–3) against the complete read on hostile trails and supplies. Proofs are oracle
// proofs: the reader's verifier accepts a proof whose first byte is its kind. The broad agreement over the fixture
// suites is test/succinct-differential.ts's.
const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), operatorSecret = b(4);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const configuration = adoptedConfiguration(), domain = configurationHash(configuration), label = b(2), lag = 2n;
const reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
const SET = testCheckSet("succinct test");
const proofOf = (first: number, length = COVER_PROOF_BYTES) => new Uint8Array(length).fill(first);

/** One operator, one backing, one segment; records the operator applies, and raw records it commits without judging. */
function oneBacking() {
  const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore();
  const fields = { configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n,
    payout: { thing: "succinct test", quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(b(6)) };
  const terms = encodeRootTerms(fields), name = rootTermsName(terms);
  const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
  const header: SegmentHeader = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing: name, link: name }] };
  const id = segmentIdentity(header), scope = new ScopeTree(header.entries).root();
  const state = openSegmentState(operatorStore, id, b(90), undefined);
  const permissive = { verify: () => true, identities: configuration.circuits };
  const records: Uint8Array[] = [], free: Uint8Array[] = [], digests: ReturnType<typeof evidenceHashes>[] = [];
  const items: EvidenceItem[] = [], trails: Uint8Array[] = [], freeTrails: Uint8Array[] = [];
  const replay = { domain, backing: name, segment: id, scope, terms: fields, verifier: permissive, index: 2n, block: [] };
  let raw = false;
  function issueRecord(value: bigint, output: bigint, proof: Uint8Array): Record {
    const capsules = [new Uint8Array(89).fill(1)], outputs = [output];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(id), scope, ...limbsOf(name),
      value, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof, authorization: new Uint8Array(64), capsules };
    return { ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) };
  }
  async function issue(value: bigint, output: bigint, proof = proofOf(1)) {
    const bytes = encodeRecord(issueRecord(value, output, proof));
    await applyRecord(state, bytes, replay);
    records.push(bytes); free.push(encodeProofFree(proofFreeOf(decodeRecord(bytes)))); digests.push(evidenceHashes(decodeRecord(bytes)));
  }
  /** Commit bytes the operator never judged: the complete record, its proof-free form and its evidence digests. */
  function commitRaw(bytes: Uint8Array, form: Uint8Array, evidence: ReturnType<typeof evidenceHashes>) {
    records.push(bytes); free.push(form); digests.push(evidence); raw = true;
  }
  function checkpoint(sequence: bigint, index: bigint) {
    let evidence = POOL_V3.genesisEvidence(id);
    digests.forEach((d, i) => { evidence = POOL_V3.nextEvidence(evidence, d, BigInt(i + 1)); });
    const total = state.total(hex(name));
    // After raw records the history is the operator's last judged one: replay refuses at the raw record first.
    const snapshot = { backing: name, segment: id, historyHash: state.history, evidenceHash: evidence, ...total };
    void raw;
    const directory = [{ name, digest: sha256(snapshotBytes(snapshot)) }];
    const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
    items.push({ kind: 4, payload: snapshotBytes(snapshot) }, { kind: 3, payload: encodeEvidenceDirectory(directory) });
    venue.witness(1, operator, index, encodeCommitment(commitment));
    const trail = { header: segmentBytes(header), terms: [signed], records: [...records] };
    trails.push(encodeTrail(trail)); freeTrails.push(PROOF_FREE_TRAILS.encodeTrail({ ...trail, records: [...free] }));
    return { commitment, trail, free: [...free] };
  }
  const pack = (extra: readonly EvidenceItem[]) => {
    const all = [...items, ...extra, { kind: 1, payload: configurationBytes(configuration) }];
    const unique = all.filter((item, i) => all.findIndex(o => o.kind === item.kind && compareBytes(o.payload, item.payload) === 0) === i);
    return encodeEvidencePackage(unique.sort((a, z) => a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
  };
  const selection = (c: ReturnType<typeof checkpoint>) => ({ mode: "current-fixture" as const, domain, venue: venue.id, backing: name, operator,
    sequence: c.commitment.sequence, root: c.commitment.root, judgingIndex: venue.witnessedIndex() });
  /** Each read's outcome: a refusal by status or check, or the valid state's position and supply. */
  const outcome = async (read: Promise<{ readonly state?: { readonly position: bigint; readonly issued: bigint } | undefined }>) => {
    try { const r = await read; return { valid: r.state?.position, issued: r.state?.issued }; } catch (error) {
      if (error instanceof ReplayRefusal) return { check: error.check };
      if (error instanceof EvidenceRefusal) return { status: error.status };
      throw error;
    }
  };
  const complete = (c: ReturnType<typeof checkpoint>) => outcome(readPackage(pack([{ kind: 2, payload: encodeCommitment(c.commitment) },
    ...trails.map(payload => ({ kind: 6, payload }))]), selection(c), { verifier, reference, venue }));
  const succinct = (c: ReturnType<typeof checkpoint>, supply: CheckSupply) => outcome(readPackage(pack([{ kind: 2, payload: encodeCommitment(c.commitment) },
    ...freeTrails.map(payload => ({ kind: 6, payload }))]), selection(c),
  { verifier, reference, venue, construction: succinctPoolV3({ set: SET, supply }) }));
  /** Keep only the first `n` records: the operator's next trail forks there. */
  const truncate = (n: number) => { records.length = n; free.length = n; digests.length = n; };
  return { id, scope, name, issue, issueRecord, commitRaw, truncate, checkpoint, complete, succinct };
}

/** A supply over the complete trail's proofs, covers made for the proved records (by the caller's rule), and counts. */
function supplyOf(records: readonly Uint8Array[], options: { cover?: (digests: bigint[], kinds: number[]) => Map<bigint, Uint8Array>;
  withhold?: (proof: Uint8Array) => boolean; wrong?: boolean } = {}) {
  const proofs = new Map<string, Uint8Array>(), digests: bigint[] = [], kinds: number[] = [];
  for (const bytes of records) {
    let record;
    try { record = decodeRecord(bytes); } catch { continue; }
    if (record.proof.length) proofs.set(hex(sha256(record.proof)), record.proof);
    if ([1, 2, 3, 4, 6].includes(record.kind)) { digests.push(leafDigest(proofFreeOf(record))); kinds.push(record.kind); }
  }
  const covers = options.cover?.(digests, kinds) ?? new Map<bigint, Uint8Array>(), asked = { covers: 0, proofs: 0 };
  const supply: CheckSupply & { asked: typeof asked; add(proof: Uint8Array): void } = {
    asked,
    add: proof => { proofs.set(hex(sha256(proof)), proof); },
    cover: digest => { asked.covers++; return covers.get(digest); },
    proof: hash => {
      asked.proofs++;
      const proof = proofs.get(hex(hash));
      if (proof === undefined || options.withhold?.(proof) === true) return undefined;
      return options.wrong === true ? proofOf(9) : proof;
    },
  };
  return supply;
}
/** Covers for every aligned span whose proofs the oracle accepts, as an honest prover makes them. */
function honest(digests: bigint[], kinds: number[]): Map<bigint, Uint8Array> {
  const covers = new Map<bigint, Uint8Array>();
  let level = digests.map((digest, i) => ({ digest, ok: true, kind: kinds[i] as number | undefined }));
  for (const leaf of level) covers.set(leaf.digest, SET.cover(leaf.kind, leaf.digest));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const digest = nodeDigest(level[i]!.digest, level[i + 1]!.digest);
      covers.set(digest, SET.cover(undefined, digest)); next.push({ digest, ok: true, kind: undefined });
    }
    level = next;
  }
  return covers;
}

describe("succinct reading: the proof-free form and digests (succinct-read §§3.2–3.3)", () => {
  it("replaces the proof field by its proofHash, 603 bytes for an issue, and refuses a sentinel on the wrong kind", () => {
    const f = oneBacking(), record = f.issueRecord(5n, 101n, proofOf(1));
    const form = encodeProofFree(proofFreeOf(record));
    expect(form.length).toBe(603);
    expect(encodeRecord(record).length).toBe(603 - 32 + 4 + COVER_PROOF_BYTES);
    expect(decodeProofFree(form)).toEqual(proofFreeOf(record));
    expect(proofFreeDigests(decodeProofFree(form))).toEqual(evidenceHashes(record));
    // Kind 1 with the zero sentinel, a changed capsule (delivery association) and a trailing byte do not decode.
    const zero = { ...proofFreeOf(record), proofHash: new Uint8Array(32) };
    expect(() => encodeProofFree(zero)).toThrow("wrong proof digest sentinel");
    const altered = Uint8Array.from(form); altered[form.length - 1] = altered[form.length - 1]! ^ 1;
    expect(() => decodeProofFree(altered)).toThrow();
    expect(() => decodeProofFree(Uint8Array.of(...form, 0))).toThrow();
  });

  it("frames a proof-free trail under its own context with 33 fixed bytes, and digests by the spec's tags", () => {
    const f = oneBacking(), c = f.checkpoint(1n, 1n);
    const bytes = PROOF_FREE_TRAILS.encodeTrail(c.trail);
    expect(compareBytes(bytes.subarray(0, SUCCINCT_TRAIL_CONTEXT.length), SUCCINCT_TRAIL_CONTEXT)).toBe(0);
    expect(bytes.length).toBe(33 + c.trail.header.length + 68 + c.trail.terms[0]!.terms.length);
    const form = proofFreeOf(f.issueRecord(5n, 101n, proofOf(1))), [hi, lo] = limbsOf(form.proofHash);
    expect(leafDigest(form)).toBe(poseidon2Hash([T_CHECK_LEAF, 1n, ...form.publicInputs, hi, lo]));
    expect(nodeDigest(1n, 2n)).toBe(poseidon2Hash([T_CHECK_NODE, 1n, 2n]));
    expect(nodeDigest(1n, 2n)).not.toBe(nodeDigest(2n, 1n));
  });
});

describe("succinct reading against the complete read (succinct-read §§2–3)", () => {
  async function issued(count: number, proof = (i: number) => proofOf(1)) {
    const f = oneBacking();
    f.checkpoint(1n, 1n);
    for (let i = 0; i < count; i++) await f.issue(BigInt(i + 1), BigInt(100 + i), proof(i));
    return { f, c: f.checkpoint(2n, 3n) };
  }

  it("covers five proved records with two spans (the canonical partition) and fetches none; with no covers fetches all five", async () => {
    const { f, c } = await issued(5);
    expect(await f.complete(c)).toEqual({ valid: 5n, issued: 15n });
    const covered = supplyOf(c.trail.records, { cover: honest });
    expect(await f.succinct(c, covered)).toEqual({ valid: 5n, issued: 15n });
    expect(covered.asked).toEqual({ covers: 2, proofs: 0 });
    const none = supplyOf(c.trail.records);
    expect(await f.succinct(c, none)).toEqual({ valid: 5n, issued: 15n });
    // Spans of four and two, then the first record: none covers it, so the rest is the tail and no cover is asked
    // again (provers cover a prefix; audit 34). Before, 8 asks.
    expect(none.asked).toEqual({ covers: 3, proofs: 5 });
  });

  it("excludes a failing proof natively where an honest prover leaves it uncovered, and reads what follows it as the tail", async () => {
    const { f, c } = await issued(4, i => proofOf(i === 2 ? 7 : 1));
    expect(await f.complete(c)).toEqual({ check: "PROOF" });
    const supply = supplyOf(c.trail.records, { cover: (digests, kinds) => {
      const covers = honest(digests, kinds);
      // The prover checks each proof first (§3.5): no leaf over record 2, so no node above it.
      covers.delete(digests[2]!); covers.delete(nodeDigest(digests[2]!, digests[3]!)); covers.delete(nodeDigest(nodeDigest(digests[0]!, digests[1]!), nodeDigest(digests[2]!, digests[3]!)));
      return covers;
    } });
    expect(await f.succinct(c, supply)).toEqual({ check: "PROOF" });
    // Spans of four and of two (the first two records' node), then record 2, which none covers; record 3 is the tail,
    // its proof fetched for its length though a cover exists (an invalid trail's cost alone).
    expect(supply.asked).toEqual({ covers: 4, proofs: 2 });
  });

  it("asks no cover past the first record none covers: a long tail costs its proofs, not two asks a record (audit 34)", async () => {
    const { f, c } = await issued(12);
    const complete = await f.complete(c);
    // A prover reached the first five records: leaves 0-4 and the nodes over 0-1, 2-3 and 0-3.
    const supply = supplyOf(c.trail.records, { cover: (digests, kinds) => honest(digests.slice(0, 5), kinds.slice(0, 5)) });
    expect(await f.succinct(c, supply)).toEqual(complete);
    // The span of eight (none), its first four (covered), its last four and records 4-5 (none), record 4 (covered) and
    // record 5 (none): 6 asks, where splitting every span down to single records asked 16. Records 5-11 are fetched.
    expect(supply.asked).toEqual({ covers: 6, proofs: 7 });
  });

  it("takes a cover as the set attests it: a test cover over a failing proof reads valid, the disagreement §2 rule 7 names", async () => {
    const { f, c } = await issued(2, i => proofOf(i === 1 ? 7 : 1));
    expect(await f.complete(c)).toEqual({ check: "PROOF" });
    expect(await f.succinct(c, supplyOf(c.trail.records, { cover: honest }))).toEqual({ valid: 2n, issued: 3n });
  });

  it("refuses covers of another set, a wrong kind or a wrong digest, and checks those records natively", async () => {
    const { f, c } = await issued(2);
    const other = testCheckSet("another");
    for (const forge of [
      (digests: bigint[]) => new Map(digests.map(d => [d, other.cover(1, d)] as const)),
      (digests: bigint[]) => new Map(digests.map(d => [d, SET.cover(2, d)] as const)),
      (digests: bigint[]) => new Map(digests.map(d => [d, SET.cover(1, d + 1n)] as const)),
      (digests: bigint[]) => new Map([[nodeDigest(digests[0]!, digests[1]!), SET.cover(1, nodeDigest(digests[0]!, digests[1]!))]]),
    ]) {
      const supply = supplyOf(c.trail.records, { cover: digests => forge(digests) });
      expect(await f.succinct(c, supply)).toEqual({ valid: 2n, issued: 3n });
      expect(supply.asked.proofs).toBe(2);
    }
  });

  it("leaves the read unresolved where an uncovered proof is withheld or answered with other bytes", async () => {
    const { f, c } = await issued(3);
    expect(await f.succinct(c, supplyOf(c.trail.records, { withhold: () => true }))).toEqual({ status: "unresolved-evidence" });
    expect(await f.succinct(c, supplyOf(c.trail.records, { wrong: true }))).toEqual({ status: "unresolved-evidence" });
    // Covered, nothing is fetched, so nothing withheld matters.
    expect(await f.succinct(c, supplyOf(c.trail.records, { cover: honest, withhold: () => true }))).toEqual({ valid: 3n, issued: 6n });
  });

  it("fetches a committed kind-7 record's proof for its length: KIND where it decodes, unresolved where withheld (pool-v3 §10.1)", async () => {
    const f = oneBacking();
    f.checkpoint(1n, 1n);
    await f.issue(5n, 101n);
    const request: Record = { domain, kind: 7, publicInputs: [...limbsOf(domain), ...limbsOf(f.id), 1n, 2n, 3n], proof: proofOf(7),
      authorization: new Uint8Array(), capsules: [] };
    const bytes = encodeRecord(request);
    f.commitRaw(bytes, encodeProofFree(proofFreeOf(request)), evidenceHashes(request));
    const c = f.checkpoint(2n, 3n);
    expect(await f.complete(c)).toEqual({ check: "KIND" });
    expect(await f.succinct(c, supplyOf(c.trail.records, { cover: honest }))).toEqual({ check: "KIND" });
    expect(await f.succinct(c, supplyOf(c.trail.records, { cover: honest, withhold: proof => proof[0] === 7 }))).toEqual({ status: "unresolved-evidence" });
  });

  it("reads a committed proof field §5 cannot decode as unresolved, never an exclusion, whatever comes before it", async () => {
    for (const before of ["valid", "failing"] as const) {
      const f = oneBacking();
      f.checkpoint(1n, 1n);
      await f.issue(5n, 101n, before === "valid" ? proofOf(1) : proofOf(7));
      // An issue whose committed proof is 33 bytes: its evidence digests hash the actual field (§7.1).
      const record = f.issueRecord(6n, 102n, proofOf(1)), proof = proofOf(1, 33);
      const w = new ByteWriter();
      w.context(statementBytes(record)); w.lengthPrefixed(proof); w.lengthPrefixed(record.authorization);
      w.u32(1); w.fixed(record.capsules[0]!, 89, "capsule");
      const form: ProofFreeRecord = { ...proofFreeOf(record), proofHash: sha256(proof) };
      f.commitRaw(w.finish(), encodeProofFree(form), hashEvidenceFields(statementHash(record), proof, record.authorization));
      const c = f.checkpoint(2n, 3n), supply = supplyOf(c.trail.records, { cover: honest });
      supply.add(proof);
      expect(await f.complete(c)).toEqual({ status: "unresolved-evidence" });
      expect(await f.succinct(c, supply)).toEqual({ status: "unresolved-evidence" });
    }
  });

  it("establishes a non-extending trail's proof lengths before its non-extension: CONTINUITY, or unresolved where a proof is withheld", async () => {
    const f = oneBacking();
    f.checkpoint(1n, 1n);
    await f.issue(5n, 101n);
    const first = f.checkpoint(2n, 3n);
    // The next trail replaces the first record by another and goes on: it does not extend the valid checkpoint (§7.1).
    f.truncate(0);
    // Its proof differs from the first record's, so withholding it withholds nothing the valid checkpoint needs.
    const distinct = proofOf(1); distinct[1] = 2;
    const other = f.issueRecord(6n, 102n, distinct);
    f.commitRaw(encodeRecord(other), encodeProofFree(proofFreeOf(other)), evidenceHashes(other));
    const forked = f.checkpoint(3n, 4n), records = [...first.trail.records, ...forked.trail.records];
    expect(await f.complete(forked)).toEqual({ check: "CONTINUITY" });
    expect(await f.succinct(forked, supplyOf(records))).toEqual({ check: "CONTINUITY" });
    const otherProof = (proof: Uint8Array) => compareBytes(sha256(proof), sha256(other.proof)) === 0;
    expect(await f.succinct(forked, supplyOf(records, { withhold: otherProof }))).toEqual({ status: "unresolved-evidence" });
  });

  it("establishes a served trail before a header-only refusal: an opening's undecodable proof is unresolved, not OPENING (review)", async () => {
    const f = oneBacking();
    const record = f.issueRecord(6n, 102n, proofOf(1)), proof = proofOf(1, 33);
    const w = new ByteWriter();
    w.context(statementBytes(record)); w.lengthPrefixed(proof); w.lengthPrefixed(record.authorization);
    w.u32(1); w.fixed(record.capsules[0]!, 89, "capsule");
    f.commitRaw(w.finish(), encodeProofFree({ ...proofFreeOf(record), proofHash: sha256(proof) }),
      hashEvidenceFields(statementHash(record), proof, record.authorization));
    const c = f.checkpoint(1n, 1n), supply = supplyOf(c.trail.records, { cover: honest });
    supply.add(proof);
    expect(await f.complete(c)).toEqual({ status: "unresolved-evidence" });
    expect(await f.succinct(c, supply)).toEqual({ status: "unresolved-evidence" });
    // The same opening with a decodable proof is excluded by both.
    const g = oneBacking(), good = g.issueRecord(6n, 102n, proofOf(1));
    g.commitRaw(encodeRecord(good), encodeProofFree(proofFreeOf(good)), evidenceHashes(good));
    const d = g.checkpoint(1n, 1n);
    expect(await g.complete(d)).toEqual({ check: "OPENING" });
    expect(await g.succinct(d, supplyOf(d.trail.records))).toEqual({ check: "OPENING" });
  });

  it("numbers a resumed checkpoint's proved records from the kept ones, asking only the canonical spans", async () => {
    const f = oneBacking();
    f.checkpoint(1n, 1n);
    for (let i = 0; i < 3; i++) await f.issue(BigInt(i + 1), BigInt(100 + i));
    f.checkpoint(2n, 3n);
    for (let i = 3; i < 5; i++) await f.issue(BigInt(i + 1), BigInt(100 + i));
    const c = f.checkpoint(3n, 5n), supply = supplyOf(c.trail.records, { cover: honest });
    expect(await f.succinct(c, supply)).toEqual({ valid: 5n, issued: 15n });
    // Records 0–2 as spans (1, 0) and (0, 2); records 3 and 4, after the kept three, as (0, 3) and (0, 4).
    expect(supply.asked).toEqual({ covers: 4, proofs: 0 });
  });
  it("fetches nothing again when a resumed replay refuses: its kept prefix and its own records were established (review)", async () => {
    const f = oneBacking();
    f.checkpoint(1n, 1n);
    for (let i = 0; i < 4; i++) { const proof = proofOf(1); proof[1] = i + 1; if (i === 3) f.checkpoint(2n, 3n); await f.issue(BigInt(i + 1), BigInt(100 + i), proof); }
    // A record with a failing proof the operator never judged, after the resumed tip.
    const bad = f.issueRecord(5n, 104n, proofOf(7));
    f.commitRaw(encodeRecord(bad), encodeProofFree(proofFreeOf(bad)), evidenceHashes(bad));
    const c = f.checkpoint(3n, 5n), base = supplyOf(c.trail.records), seen = new Map<string, number>();
    // Each proof is given once: a second ask would be withheld.
    const supply: CheckSupply = { cover: base.cover, proof: hash => {
      const key = hex(hash), n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return n > 1 ? undefined : base.proof(hash);
    } };
    expect(await f.complete(c)).toEqual({ check: "PROOF" });
    expect(await f.succinct(c, supply)).toEqual({ check: "PROOF" });
    expect([...seen.values()].every(n => n === 1)).toBe(true);
  });
});

describe("succinct reading: a prover's walk over a trail (succinct-read §§3.2, 3.5; slice 37)", () => {
  it("covers each aligned span once, none holding a record whose proof fails, and proves nothing again on a second walk", async () => {
    const f = oneBacking();
    // Six proved records; the third's proof fails the native check, and the fourth has no cover's length.
    const records = [1, 1, 7, 1, 1, 1].map((first, i) => f.issueRecord(BigInt(i + 1), BigInt(200 + i), i === 3 ? proofOf(first, 64) : proofOf(first)));
    const digests = records.map(r => leafDigest(proofFreeOf(r)));
    const kept = new Map<bigint, Uint8Array>(), prover = testProver(SET, verifier);
    const walk = () => coverTrail(prover, records.map(encodeRecord), digest => kept.get(digest), cover => {
      expect(SET.verify(cover.kind, cover.digest, cover.proof)).toBe(true); kept.set(cover.digest, cover.proof);
    });
    expect(await walk()).toEqual({ proved: 6, made: 6 });
    // Leaves 0, 1, 4, 5 and the nodes over (0, 1) and (4, 5): (2, 3) and every span above them hold a record without one.
    expect(new Set(kept.keys())).toEqual(new Set([digests[0], digests[1], digests[4], digests[5],
      nodeDigest(digests[0]!, digests[1]!), nodeDigest(digests[4]!, digests[5]!)]));
    expect(await walk()).toEqual({ proved: 6, made: 0 });
  });
});

describe("succinct reading: publications (succinct-read §3.6)", () => {
  it("holds every publication's proof for its native check, and leaves a withheld request proof unresolved, never false", async () => {
    const segment = b(9);
    const requestOf = (i: number): Record => ({ domain, kind: 7, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 1n, BigInt(i + 2), 3n],
      proof: (() => { const p = proofOf(7, 64); p[1] = i & 255; p[2] = i >> 8; return p; })(), authorization: new Uint8Array(), capsules: [] });
    const publication = (r: Record) => encodePublication({ domain, backing: segment, kind: 5, record: r });
    const construction = succinctPoolV3({ set: SET, supply: { cover: () => undefined, proof: () => undefined } });
    const first = construction.reader.publication(publication(requestOf(0)));
    for (let i = 1; i <= 300; i++) construction.reader.publication(publication(requestOf(i)));
    expect(await construction.reader.request(first.record!).holds(verifier)).toBe(true);
    // A request read only in its proof-free form, whose proof no supplier gives: unresolved.
    const unseen = encodeProofFree(proofFreeOf(requestOf(400)));
    await expect(construction.reader.request(unseen).holds(verifier)).rejects.toMatchObject({ status: "unresolved-evidence" });
  });
});
