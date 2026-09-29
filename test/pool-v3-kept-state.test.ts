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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment, type Commitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentState, type WitnessPredicate } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";
import { describeState } from "./pool-v3-state-description.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), operatorSecret = b(4), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), label = b(2), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
/** A verifier that names itself by circuit identities, as a ProofVerifier does, and counts its checks. */
const counting = (name = b(40)) => {
  const verifier = { checks: 0, identities: { spend: { bytecode: name, vk: b(50) } },
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
  const read = (verifier: ProofCheck, store?: ReplayStore, options: { at?: bigint; witness?: WitnessPredicate; withoutTrails?: boolean } = {}) =>
    readFrontier(pack(options.withoutTrails === true ? items.filter(item => item.kind !== 6) : items), signed, options.at ?? venue.witnessedIndex(),
      { configuration, verifier, reference, venue, ...(store === undefined ? {} : { store }), ...(options.witness === undefined ? {} : { witness: options.witness }) });
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
  return { venue, segment, checkpoint, issue, read, first };
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
  return { path: join(dir, "replay.sqlite"), digest: join(dir, "replay.sha256") };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

  it("reuses kept classes only under the same verifier identities", async () => {
    const f = fixture(), kept = files();
    await f.first();
    const store = opened(kept.path, kept);
    await f.read(counting(), store);
    const other = counting(b(41)), again = await f.read(other, store);
    expect(outcome(again)).toEqual(outcome(await f.read(counting())));
    expect(other.checks).toBe(4);
    // The old context's namespaces went with its classes.
    expect(namespaceCount(kept.path)).toBe(1);
    // A verifier or witness predicate that declares no name could never be reused across processes.
    await expect(f.read({ verify: () => true }, store)).rejects.toThrow("a kept store needs");
    const anonymous: WitnessPredicate = () => true;
    await expect(f.read(counting(), store, { witness: anonymous })).rejects.toThrow("a kept store needs");
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

  it("gives a witnessing read at a lower index the paths a fresh read gives", async () => {
    const f = fixture(), kept = files(), witness: WitnessPredicate = Object.assign(() => true, { identity: b(77) });
    await f.first();
    f.venue.advance(12n); await f.issue(107n); await f.issue(108n); f.checkpoint(f.segment, 6n, 11n);
    const store = opened(kept.path, kept);
    await f.read(counting(), store, { witness });
    const lower = await f.read(counting(), store, { at: 10n, witness }), fresh = await f.read(counting(), undefined, { at: 10n, witness });
    expect(outcome(lower)).toEqual(outcome(fresh));
    const path = lower.canonical!.state.path(106n), expected = fresh.canonical!.state.path(106n);
    expect(path).toBeDefined();
    expect(path).toEqual(expected);
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

  it("refuses a kept store without a file or its own digest path", () => {
    expect(() => new ReplayStore(":memory:", { digest: "x" })).toThrow(TypeError);
    expect(() => new ReplayStore("same", { digest: "same" })).toThrow(TypeError);
    expect(() => new ReplayStore("file", { digest: "d", every: 0 })).toThrow(TypeError);
  });
});
