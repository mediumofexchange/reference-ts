// pool-v3 §14 kept classes and kept state across reads (storage decision item 6, M5b.4): a reader's kept
// file gives the verdicts a fresh read gives, replays only records it has not replayed, and falls back
// to a full read when the file or a kept row fails a check.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { FixtureVenue, LOCAL_REFERENCE, type RecordVenue } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment, type Commitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { decodeSnapshot, encodeReceipt, genesisEvidenceHash, nextEvidenceHash, receiptBytes, snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { configurationBytes, configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readFrontier, readPackage } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { KeptStateMismatch, ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentState, type WitnessPredicate } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail, encodeTrail } from "../src/pool/v3/trail.js";
import { describeState } from "./pool-v3-state-description.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), operatorSecret = b(4), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), label = b(2), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
/** A verifier that names itself by circuit identities, as a ProofVerifier does, and counts its checks. */
const counting = (identities: CandidateConfiguration["circuits"] = configuration.circuits) => {
  const verifier = { checks: 0, identities,
    verify(_kind: number, _inputs: bigint[], proof: Uint8Array) { verifier.checks++; return proof[0] !== 99; } };
  return verifier;
};
interface Segment { header: SegmentHeader; id: Uint8Array; state: SegmentState; records: Uint8Array[]; evidence?: Uint8Array }

function fixture() {
  const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore(), accept: ProofCheck = { verify: () => true };
  const fields = { configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n,
    payout: { thing: "kept state test", quantumExponent: 0, perUnit: 1n } };
  const terms = encodeRootTerms(fields), backing = rootTermsName(terms);
  const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
  const items: EvidenceItem[] = [];
  const add = (kind: number, payload: Uint8Array) => {
    if (!items.some(item => item.kind === kind && compareBytes(item.payload, payload) === 0)) items.push({ kind, payload });
  };
  const header: SegmentHeader = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] };
  const id = segmentIdentity(header), segment: Segment = { header, id, state: openSegmentState(operatorStore, id, b(90), undefined), records: [] };
  const chain = (records: readonly Uint8Array[]): Uint8Array => records.reduce((previous, bytes, i) =>
    nextEvidenceHash(previous, evidenceHashes(decodeRecord(bytes)), BigInt(i + 1)), genesisEvidenceHash(id));
  function checkpoint(target: Segment, sequence: bigint, index: bigint): Commitment {
    const total = target.state.total(hex(backing));
    const snapshot = { backing, segment: id, historyHash: target.state.history, evidenceHash: target.evidence ?? target.state.evidence, ...total };
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }];
    const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
    add(3, encodeEvidenceDirectory(directory)); add(4, snapshotBytes(snapshot));
    add(6, encodeTrail({ header: segmentBytes(header), terms: [signed], records: target.records }));
    venue.witness(1, operator, index, encodeCommitment(commitment));
    return commitment;
  }
  function issued(output: bigint, signer = issuerSecret, proof = b(7)): Uint8Array {
    const scope = new ScopeTree(header.entries).root(), capsules = [new Uint8Array(89).fill(1)], outputs = [output];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(id), scope, ...limbsOf(backing),
      5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof, authorization: new Uint8Array(64), capsules };
    return encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), signer) });
  }
  async function issue(output: bigint) {
    const bytes = issued(output), scope = new ScopeTree(header.entries).root();
    await applyRecord(segment.state, bytes, { domain, backing, segment: id, scope, terms: fields, verifier: accept, index: 2n, block: [] });
    segment.records.push(bytes);
  }
  interface ReadOptions { at?: bigint; witness?: WitnessPredicate; withoutTrails?: boolean; evidence?: EvidenceStore; items?: EvidenceItem[]; venue?: RecordVenue }
  const own = (verifier: ProofCheck, store: ReplayStore | undefined, options: ReadOptions) => ({ configuration, verifier, reference, venue: options.venue ?? venue,
    ...(store === undefined ? {} : { store }), ...(options.witness === undefined ? {} : { witness: options.witness }),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }) });
  const read = (verifier: ProofCheck, store?: ReplayStore, options: ReadOptions = {}) =>
    readFrontier(pack(options.items ?? (options.withoutTrails === true ? items.filter(item => item.kind !== 6) : items)), signed,
      options.at ?? venue.witnessedIndex(), own(verifier, store, options));
  /** A read of the held commitment `selected` with a receipt, as a holder presents it. */
  const readReceipt = (verifier: ProofCheck, selected: Commitment, receipt: Uint8Array, store?: ReplayStore, options: ReadOptions = {}) =>
    readPackage(pack([...(options.items ?? items), { kind: 1, payload: configurationBytes(configuration) }, { kind: 2, payload: encodeCommitment(selected) },
      { kind: 10, payload: receipt }]), { mode: "historical-fixture", domain, venue: venue.id, backing, operator, sequence: selected.sequence,
      root: selected.root, judgingIndex: options.at ?? venue.witnessedIndex() }, own(verifier, store, options));
  /** The segment's trail as §14 fetches it after a kept position: its head, count included, and the records after it. */
  function fetchedAfter(after: bigint): Uint8Array {
    const full = encodeTrail({ header: segmentBytes(header), terms: [signed], records: segment.records });
    const head = encodeTrail({ header: segmentBytes(header), terms: [signed], records: [] }).length;
    const skip = segment.records.slice(0, Number(after)).reduce((n, r) => n + 4 + r.length, 0);
    const out = new Uint8Array(full.length - skip); out.set(full.subarray(0, head)); out.set(full.subarray(head + skip), head);
    return out;
  }
  /** The operator's receipt for the record at `position` of the segment, after its sequence `after`. */
  function receipt(position: number, after: bigint): Uint8Array {
    const record = decodeRecord(segment.records[position - 1]!), evidence = chain(segment.records.slice(0, position));
    const snapshot = items.filter(item => item.kind === 4).map(item => decodeSnapshot(item.payload)).find(value => compareBytes(value.evidenceHash, evidence) === 0)!;
    const fields = { domain, segment: id, scopeRoot: new ScopeTree(header.entries).root(), position: BigInt(position), historyHash: snapshot.historyHash,
      after, ...evidenceHashes(record) };
    return encodeReceipt({ ...fields, operator, signature: ed25519.sign(receiptBytes(fields), operatorSecret) });
  }
  // The first history: a valid opening and issue, a checkpoint excluded for a foreign signature, one that
  // rewrites the valid prefix (its first record carries a proof the verifier refuses), then a valid one.
  async function first() {
    checkpoint(segment, 1n, 1n);
    await issue(101n); checkpoint(segment, 2n, 2n);
    const hostile = [...segment.records, issued(102n), issued(103n, b(9))];
    checkpoint({ ...segment, records: hostile, evidence: chain(hostile) }, 3n, 3n);
    const rewritten = [issued(104n, issuerSecret, b(99)), issued(105n)];
    checkpoint({ ...segment, records: rewritten, evidence: chain(rewritten) }, 4n, 4n);
    await issue(106n); checkpoint(segment, 5n, 5n);
  }
  return { venue, segment, items, checkpoint, issue, read, readReceipt, fetchedAfter, receipt, chain, first };
}

/** A venue that lists the ranges a reader asks it for. */
function asking(venue: FixtureVenue): { venue: RecordVenue; asked: string[] } {
  const asked: string[] = [];
  return { asked, venue: { id: venue.id, lag: () => venue.lag(), witnessedIndex: () => venue.witnessedIndex(),
    range: (request, limits) => { asked.push(`${request.kind}:${request.fromIndex}-${request.toIndex}`); return venue.range(request, limits); } } };
}
/** What a read establishes, in comparable form. */
const outcome = (read: Awaited<ReturnType<typeof readFrontier>>) => ({ carrying: read.carrying, clock: read.clock, force: read.force,
  canonical: read.canonical === undefined ? undefined : { ...read.canonical, state: describeState(read.canonical.state) },
  ranges: read.ranges, faults: read.faultEvidence });

const directories: string[] = [], stores: ReplayStore[] = [];
/** Namespaces in a kept file, read once the store has committed. */
const namespaceCount = (path: string): number => {
  const db = new DatabaseSync(path, { readBigInts: true });
  try { return Number((db.prepare("SELECT count(*) AS c FROM namespace").get() as { c: bigint }).c); } finally { db.close(); }
};
/** A store closed after the test, pass or fail, so its files can be removed. */
const opened = (path: string, kept: { digest: string; every?: number }): ReplayStore => { const store = new ReplayStore(path, kept); stores.push(store); return store; };
function files() {
  const dir = mkdtempSync(join(tmpdir(), "moe-kept-")); directories.push(dir);
  return { path: join(dir, "replay.sqlite"), digest: join(dir, "replay.sha256"), evidence: join(dir, "evidence.sqlite") };
}
const evidenceStores: EvidenceStore[] = [];
/** The party's retained evidence file, closed after the test. */
const retained = (path: string): EvidenceStore => { const store = new EvidenceStore(path); evidenceStores.push(store); return store; };
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const store of evidenceStores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pool-v3 §14 kept classes across reads", () => {
  it("gives a fresh read's verdicts and state, replaying only records it has not replayed", async () => {
    const f = fixture(), kept = files();
    await f.first();
    let store = opened(kept.path, kept);
    const firstKept = counting(), firstFresh = counting();
    const first = await f.read(firstKept, store);
    expect(outcome(first)).toEqual(outcome(await f.read(firstFresh)));
    expect(first.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "valid", undefined], ["2", "valid", undefined],
      ["3", "excluded", "SIGNATURE"], ["4", "excluded", "CONTINUITY"], ["5", "valid", undefined]]);
    // §7.1: the rewritten prefix is excluded by the evidence recurrence; none of its records is verified.
    expect(firstKept.checks).toBe(firstFresh.checks);
    expect(firstKept.checks).toBe(4);
    store.close();

    // Two more records and a checkpoint; the reopened file passes its digest check and replays only them.
    f.venue.advance(12n); await f.issue(107n); await f.issue(108n); f.checkpoint(f.segment, 6n, 11n);
    store = opened(kept.path, kept);
    expect(store.keptRows()).toBeGreaterThan(0);
    const secondKept = counting(), secondFresh = counting();
    const second = await f.read(secondKept, store);
    expect(outcome(second)).toEqual(outcome(await f.read(secondFresh)));
    expect(secondKept.checks).toBe(2);
    expect(secondFresh.checks).toBe(6);

    // Nothing new: no record is replayed.
    f.venue.advance(14n);
    const thirdKept = counting(), third = await f.read(thirdKept, store);
    expect(outcome(third)).toEqual(outcome(await f.read(counting())));
    expect(thirdKept.checks).toBe(0);
    expect(store.walkRows()).toBe(0);
    store.close();
  });

  it("discards a corrupted, truncated, undigested or stale-digest file and reads in full", async () => {
    for (const damage of ["corrupt", "truncate", "undigested", "stale"] as const) {
      const f = fixture(), kept = files();
      await f.first();
      const store = opened(kept.path, kept);
      await f.read(counting(), store); store.close();
      if (damage === "corrupt") {
        const bytes = readFileSync(kept.path), at = Math.floor(bytes.length / 2); bytes[at] = bytes[at]! ^ 1; writeFileSync(kept.path, bytes);
      } else if (damage === "truncate") truncateSync(kept.path, Math.floor(statSync(kept.path).size / 2));
      else if (damage === "undigested") rmSync(kept.digest);
      else writeFileSync(kept.digest, "00".repeat(32));
      const reopened = opened(kept.path, kept);
      expect(reopened.keptRows()).toBe(0);
      const verifier = counting(), again = await f.read(verifier, reopened);
      expect(outcome(again)).toEqual(outcome(await f.read(counting())));
      expect(verifier.checks).toBe(4);
      reopened.close();
      // The read's keep point recorded a digest for the new file.
      expect(readFileSync(kept.digest, "utf8")).toBe(createHash("sha256").update(readFileSync(kept.path)).digest("hex"));
    }
  });

  it("discards kept state whose rows fail a check though the digest matches, and classifies again", async () => {
    // A row changed in place and the digest recorded again, as a faulty writer would leave it.
    const tamper = (kept: { path: string; digest: string }, sql: string) => {
      const db = new DatabaseSync(kept.path); db.exec(sql); db.close();
      writeFileSync(kept.digest, createHash("sha256").update(readFileSync(kept.path)).digest("hex"));
    };
    for (const sql of [
      // A valid class below its namespace's tip: its stored chain value is not its snapshot's.
      "UPDATE event SET history = zeroblob(32) WHERE position = 1",
      // The tip's note frontier: the recomputed root is not the snapshot's.
      "UPDATE namespace SET ommers = zeroblob(length(ommers))",
      // A segment base: not the one the opening's judgment derives.
      "UPDATE base SET adoption = '[]'",
    ]) {
      const f = fixture(), kept = files();
      await f.first();
      let store = opened(kept.path, kept);
      await f.read(counting(), store); store.close();
      tamper(kept, sql);
      store = opened(kept.path, kept);
      expect(store.keptRows()).toBeGreaterThan(0);
      const verifier = counting(), again = await f.read(verifier, store);
      expect(outcome(again)).toEqual(outcome(await f.read(counting())));
      expect(verifier.checks).toBe(4);
      store.close();
    }
  });

  it("takes a kept class's snapshot from this read's directory, not from its row", async () => {
    const f = fixture(), kept = files();
    await f.first();
    let store = opened(kept.path, kept);
    await f.read(counting(), store); store.close();
    const db = new DatabaseSync(kept.path); db.exec("UPDATE verdict SET snapshot = zeroblob(length(snapshot))"); db.close();
    writeFileSync(kept.digest, createHash("sha256").update(readFileSync(kept.path)).digest("hex"));
    store = opened(kept.path, kept);
    const verifier = counting(), again = await f.read(verifier, store);
    expect(outcome(again)).toEqual(outcome(await f.read(counting())));
    expect(verifier.checks).toBe(0);
  });

  it("reuses kept classes only under the configuration's verifier identities", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const store = opened(kept.path, kept);
    await f.read(counting(), store);
    // A verifier naming other circuits is refused before anything is read (§11.1): no class is judged or reused under another key.
    const other = counting({ ...configuration.circuits, spend: { bytecode: b(98), vk: b(99) } });
    await expect(f.read(other, store)).rejects.toThrow(new TypeError("the verifier's circuit identities are not the configuration's"));
    expect(other.checks).toBe(0);
    const same = counting(), again = await f.read(same, store);
    expect(outcome(again)).toEqual(outcome(await f.read(counting())));
    expect(same.checks).toBe(0);
    expect(namespaceCount(kept.path)).toBe(1);
    // A verifier that declares no circuit identities could never be reused across processes.
    await expect(f.read({ verify: () => true }, store)).rejects.toThrow("a kept store needs");
    await expect(f.read({ verify: () => true, identities: {} }, store)).rejects.toThrow("the verifier's circuit identities are not the configuration's");
    store.close();
  });

  it("discards kept classes and namespaces when the store is opened under another context", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const store = opened(kept.path, kept);
    await f.read(counting(), store);
    expect(namespaceCount(kept.path)).toBe(1);
    // Another configuration, venue or reader version names another context (§14): nothing kept under the old one stays.
    store.closeWalk(store.openWalk(new Uint8Array(32).fill(7)));
    expect(namespaceCount(kept.path)).toBe(0);
    const verifier = counting(), again = await f.read(verifier, store);
    expect(outcome(again)).toEqual(outcome(await f.read(counting())));
    expect(verifier.checks).toBe(4);
    store.close();
  });

  it("commits a keep point between checkpoints inside a long read", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const store = opened(kept.path, { ...kept, every: 1 });
    const seen: boolean[] = [];
    const verifier = { ...counting(), verify() {
      // By the second checkpoint's records, the first checkpoint's keep point has recorded the file's digest.
      seen.push(existsSync(kept.digest) && readFileSync(kept.digest, "utf8") === createHash("sha256").update(readFileSync(kept.path)).digest("hex"));
      return true;
    } };
    await f.read(verifier, store);
    expect(seen[0]).toBe(false);
    expect(seen.slice(1).some(Boolean)).toBe(true);
    store.close();
  });

  it("needs the evidence a fresh read needs: a kept class grounds nothing its package does not carry", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const store = opened(kept.path, kept);
    await f.read(counting(), store);
    const refusal = (read: Promise<unknown>) => read.then(() => "read", (error: Error) => error.message);
    expect(await refusal(f.read(counting(), store, { withoutTrails: true }))).toBe(await refusal(f.read(counting(), undefined, { withoutTrails: true })));
    expect(await refusal(f.read(counting(), undefined, { withoutTrails: true }))).toContain("unresolved-evidence");
  });

  it("keeps witnesses at the tips: a later read extends them to a fresh read's paths and scans only new outputs", async () => {
    const f = fixture(), kept = files();
    const scanned: bigint[] = [];
    const witness: WitnessPredicate = Object.assign((output: { cm: bigint }) => { scanned.push(output.cm); return output.cm !== 108n; }, { identity: b(77) });
    const every: WitnessPredicate = Object.assign((output: { cm: bigint }) => output.cm !== 108n, { identity: b(77) });
    await f.first();
    let store = opened(kept.path, kept);
    const first = await f.read(counting(), store, { witness }), fresh = await f.read(counting(), undefined, { witness: every });
    // 102 is an output of the excluded checkpoint's trail: scanned as it replayed, its witness rolled back with it.
    expect(scanned).toEqual([101n, 102n, 106n]);
    expect(first.canonical!.state.path(102n)).toBeUndefined();
    for (const cm of [101n, 106n]) expect(first.canonical!.state.path(cm)).toEqual(fresh.canonical!.state.path(cm));
    expect(first.canonical!.state.path(101n)).toBeDefined();
    store.close();

    // Two more outputs: the reopened file scans only them, and every kept witness moves to the new root.
    f.venue.advance(12n); await f.issue(107n); await f.issue(108n); f.checkpoint(f.segment, 6n, 11n);
    store = opened(kept.path, kept);
    const verifier = counting(), second = await f.read(verifier, store, { witness }), again = await f.read(counting(), undefined, { witness: every });
    expect(verifier.checks).toBe(2);
    expect(scanned).toEqual([101n, 102n, 106n, 107n, 108n]);
    const state = second.canonical!.state;
    for (const cm of [101n, 106n, 107n]) expect(state.path(cm)).toEqual(again.canonical!.state.path(cm));
    expect(state.path(107n)!.anchor).toBe(state.noteRoot());
    // An output the predicate passed over has no witness, kept or fresh.
    expect(state.path(108n)).toBeUndefined(); expect(again.canonical!.state.path(108n)).toBeUndefined();
    expect([...state.store.witnessedOutputs(state.ns, state.position)].map(output => output.cm)).toEqual([101n, 106n, 107n]);

    // A read below the tips cannot answer paths from kept witnesses: that is kept state to discard (§14).
    const earlier = await f.read(counting(), store, { witness, at: 10n });
    expect(earlier.canonical!.commitment.sequence).toBe(5n);
    expect(() => earlier.canonical!.state.path(101n)).toThrow(KeptStateMismatch);
    store.discardKept();
    const replayed = await f.read(counting(), store, { witness, at: 10n });
    expect(replayed.canonical!.state.path(101n)).toEqual(fresh.canonical!.state.path(101n));
    store.close();
  });

  it("names a kept witness predicate by its declared identity: an undeclared one is refused, another one's state is dropped", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const store = opened(kept.path, kept);
    await expect(f.read(counting(), store, { witness: () => true })).rejects.toThrow("a kept store needs a witness predicate that declares its identity");
    await f.read(counting(), store, { witness: Object.assign(() => true, { identity: b(77) }) });
    // Another predicate witnesses other outputs, so nothing replayed under the first is reused.
    const other = counting(), read = await f.read(other, store, { witness: Object.assign(() => false, { identity: b(78) }) });
    expect(other.checks).toBe(4);
    expect(read.canonical!.state.path(106n)).toBeUndefined();
    store.close();
    expect(namespaceCount(kept.path)).toBe(1);
  });

  it("classifies a scope's dependencies on a kept read as a fresh read does (two backings)", async () => {
    const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore();
    const backings = ["kept x", "kept y"].map(thing => {
      const fields = { configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n, payout: { thing, quantumExponent: 0, perUnit: 1n } };
      const terms = encodeRootTerms(fields);
      return { fields, name: rootTermsName(terms), signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) } };
    }).sort((a, z) => compareBytes(a.name, z.name));
    const [x, y] = backings as [typeof backings[0], typeof backings[0]];
    const items: EvidenceItem[] = [];
    const add = (kind: number, payload: Uint8Array) => {
      if (!items.some(item => item.kind === kind && compareBytes(item.payload, payload) === 0)) items.push({ kind, payload });
    };
    type Scoped = { header: SegmentHeader; id: Uint8Array; scoped: typeof backings; state: SegmentState; records: Uint8Array[] };
    function checkpoint(seg: Scoped, sequence: bigint, index: bigint): Commitment {
      const snapshots = seg.scoped.map(item => ({ backing: item.name, segment: seg.id, historyHash: seg.state.history,
        evidenceHash: seg.state.evidence, ...seg.state.total(hex(item.name)) }));
      const directory = snapshots.map(s => ({ name: s.backing, digest: snapshotDigest(s) }));
      for (const s of snapshots) add(4, snapshotBytes(s));
      add(3, encodeEvidenceDirectory(directory));
      add(6, encodeTrail({ header: segmentBytes(seg.header), terms: seg.scoped.map(item => item.signed), records: seg.records }));
      const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
      venue.witness(1, operator, index, encodeCommitment(commitment));
      return commitment;
    }
    // S0 scopes y alone, and its valid opening C is what S1's y entry imports; S1 also scopes x.
    const h0: SegmentHeader = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing: y.name, link: y.name }] };
    const s0: Scoped = { header: h0, id: segmentIdentity(h0), scoped: [y], state: openSegmentState(operatorStore, segmentIdentity(h0), b(90), undefined), records: [] };
    const c = checkpoint(s0, 1n, 1n);
    const h1: SegmentHeader = { domain, venue: venue.id, operator, sequence: 2n, entries: [x, y].map(item => ({ backing: item.name, link: item.name,
      ...(item === y ? { opening: { operator, sequence: c.sequence, root: c.root } } : {}) })) };
    const s1: Scoped = { header: h1, id: segmentIdentity(h1), scoped: [x, y], state: openSegmentState(operatorStore, segmentIdentity(h1), b(91), s0.state), records: [] };
    checkpoint(s1, 2n, 2n);
    const scope = new ScopeTree(h1.entries).root(), capsules = [new Uint8Array(89).fill(1)], outputs = [201n];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(s1.id), scope, ...limbsOf(x.name),
      5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
    const bytes = encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
    await applyRecord(s1.state, bytes, { domain, backing: x.name, segment: s1.id, scope, terms: x.fields,
      scopedTerms: new Map([x, y].map(item => [hex(item.name), item.fields])), verifier: { verify: () => true }, index: 2n, block: [] });
    s1.records.push(bytes);
    checkpoint(s1, 3n, 3n);
    const read = (store?: ReplayStore) => readFrontier(pack(items), x.signed, venue.witnessedIndex(),
      { configuration, verifier: counting(), reference, venue, ...(store === undefined ? {} : { store }) });
    const kept = files(), store = opened(kept.path, kept), fresh = outcome(await read());
    expect(fresh.carrying.map(item => item.sequence)).toEqual(["1", "2", "3"]);
    expect(outcome(await read(store))).toEqual(fresh);
    expect(outcome(await read(store))).toEqual(fresh);
  });

  it("reads a growing history from packages carrying only new objects, as a fresh read of the complete package does (§14)", async () => {
    const f = fixture(), kept = files();
    await f.first();
    let store = opened(kept.path, kept), evidence = retained(kept.evidence);
    const first = await f.read(counting(), store, { evidence });
    expect(outcome(first)).toEqual(outcome(await f.read(counting())));
    // The reader's own last valid checkpoint: a later trail is fetched after it.
    const tip = { segment: f.segment.id, position: first.canonical!.state.position, evidence: first.canonical!.state.evidence };
    expect(tip.position).toBe(2n);
    store.close(); evidence.close();

    // Two more records and a checkpoint. The package carries only the new checkpoint's directory and snapshot;
    // its trail is the head and the records after the kept checkpoint, assembled against the retained ones.
    const seen = f.items.length;
    f.venue.advance(12n); await f.issue(107n); await f.issue(108n); f.checkpoint(f.segment, 6n, 11n);
    store = opened(kept.path, kept); evidence = retained(kept.evidence);
    const added = f.items.slice(seen).filter(item => item.kind !== 6);
    expect(added.map(item => item.kind).sort()).toEqual([3, 4]);
    expect(await evidence.importTrail(f.fetchedAfter(tip.position), { after: tip })).toBe(true);
    const verifier = counting(), later = asking(f.venue);
    const second = await f.read(verifier, store, { evidence, items: added, venue: later.venue });
    expect(outcome(second)).toEqual(outcome(await f.read(counting())));
    // Only the two new records are verified, and the venue is asked only past the kept index (10).
    expect(verifier.checks).toBe(2);
    expect(later.asked.length).toBeGreaterThan(0);
    expect(later.asked.every(request => request.endsWith(":11-12"))).toBe(true);

    // Nothing new: an empty package, no record verified, and only the new index asked.
    f.venue.advance(14n);
    const idle = counting(), third = asking(f.venue);
    expect(outcome(await f.read(idle, store, { evidence, items: [], venue: third.venue }))).toEqual(outcome(await f.read(counting())));
    expect(idle.checks).toBe(0);
    expect(third.asked.every(request => request.endsWith(":13-14"))).toBe(true);
    // An earlier index reads the kept answers bounded by it, asking nothing, as a fresh read at that index does.
    const earlier = asking(f.venue);
    expect(outcome(await f.read(counting(), store, { evidence, items: [], venue: earlier.venue, at: 12n })))
      .toEqual(outcome(await f.read(counting(), undefined, { at: 12n })));
    expect(earlier.asked).toEqual([]);
  });

  it("never excludes on damaged retained evidence: the read is unresolved until the evidence is supplied again", async () => {
    const f = fixture(), kept = files();
    await f.first();
    let evidence = retained(kept.evidence);
    const fresh = outcome(await f.read(counting()));
    expect(outcome(await f.read(counting(), undefined, { evidence }))).toEqual(fresh);
    evidence.close();
    // The retained first record now carries a proof the verifier refuses: replayed, it would exclude every checkpoint after it.
    const first = f.segment.records[0]!, refused = encodeRecord({ ...decodeRecord(first), proof: b(99) });
    const db = new DatabaseSync(kept.evidence);
    db.prepare("UPDATE chain SET bytes = ? WHERE evidence = ?").run(refused, f.chain([first])); db.close();
    evidence = retained(kept.evidence);
    const verifier = counting();
    await expect(f.read(verifier, undefined, { evidence, items: [] })).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(verifier.checks).toBe(0);
    // The package supplied again repairs the retained copy.
    expect(outcome(await f.read(counting(), undefined, { evidence }))).toEqual(fresh);
    expect(outcome(await f.read(counting(), undefined, { evidence, items: [] }))).toEqual(fresh);
  });

  it("never serves another segment's chain value: a checkpoint naming one reads alike with or without that segment's trail", async () => {
    const f = fixture(), kept = files();
    await f.first();
    f.venue.advance(12n);
    // Another segment's trail with records, and a checkpoint of this segment whose snapshot names that trail's last chain value.
    const otherHeader = { ...f.segment.header, sequence: 2n }, otherId = segmentIdentity(otherHeader), otherRecords = [...f.segment.records];
    const otherTrail = encodeTrail({ header: segmentBytes(otherHeader), terms: decodeTrail(f.items.find(item => item.kind === 6)!.payload).terms, records: otherRecords });
    const otherChain = otherRecords.reduce((previous, bytes, i) => nextEvidenceHash(previous, evidenceHashes(decodeRecord(bytes)), BigInt(i + 1)),
      genesisEvidenceHash(otherId));
    f.checkpoint({ ...f.segment, evidence: otherChain }, 6n, 11n);
    const verdict = (read: Promise<unknown>) => read.then(() => "read", (error: { status?: string; check?: string }) => error.status ?? error.check);
    const withOther = [...f.items, { kind: 6, payload: otherTrail }];
    expect(await verdict(f.read(counting(), undefined, { items: withOther }))).toBe("unresolved-evidence");
    expect(await verdict(f.read(counting(), undefined, { items: [...f.items] }))).toBe("unresolved-evidence");
    // Retained, the other segment's records stay whole and still serve its own trail.
    const evidence = retained(kept.evidence);
    expect(await verdict(f.read(counting(), undefined, { evidence, items: withOther }))).toBe("unresolved-evidence");
    const batch = evidence.importBytes(pack([])), otherSnapshot = { backing: f.segment.header.entries[0]!.backing, segment: otherId,
      historyHash: b(9), evidenceHash: otherChain, issued: 0n, burned: 0n };
    expect([...batch.served({ backing: otherSnapshot.backing, segment: otherId, digest: snapshotDigest(otherSnapshot) }, otherSnapshot)!.records()])
      .toEqual(otherRecords);
    batch.release();
  });

  it("never excludes on a damaged trail length: the checkpoint's trail is absent instead", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const evidence = retained(kept.evidence);
    expect(outcome(await f.read(counting(), undefined, { evidence }))).toEqual(outcome(await f.read(counting())));
    evidence.close();
    // Checkpoint 5's snapshot names the chain value after the segment's two records; its row now claims position 0.
    const db = new DatabaseSync(kept.evidence);
    expect(db.prepare("UPDATE chain SET position = 0 WHERE evidence = ?").run(f.chain(f.segment.records)).changes).toBe(1); db.close();
    await expect(f.read(counting(), undefined, { evidence: retained(kept.evidence), items: [] })).rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("reads a receipt through kept state and retained evidence as a fresh read does", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const selected = f.checkpoint(f.segment, 7n, 7n), paid = f.receipt(1, 1n);
    const store = opened(kept.path, kept), evidence = retained(kept.evidence), fresh = await f.readReceipt(counting(), selected, paid);
    expect(fresh.receipt).toMatchObject({ status: "final" });
    expect(await f.readReceipt(counting(), selected, paid, store, { evidence })).toEqual(fresh);
    // Again with nothing but the selection and the receipt: everything else is kept or retained.
    const verifier = counting();
    expect(await f.readReceipt(verifier, selected, paid, store, { evidence, items: [] })).toEqual(fresh);
    expect(verifier.checks).toBe(0);
  });

  it("refuses a kept store without a file or its own digest path", () => {
    expect(() => new ReplayStore(":memory:", { digest: "x" })).toThrow(TypeError);
    expect(() => new ReplayStore("same", { digest: "same" })).toThrow(TypeError);
    expect(() => new ReplayStore("file", { digest: "d", every: 0 })).toThrow(TypeError);
  });
});
