// pool-v3 §14 kept positions (slice 11 M11b4): a resumed kept walk reads as a fresh read does where its evidence
// is restored, its rows are damaged, a read is refused past the venue, or publications and non-service move.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import * as fs from "node:fs";
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
import { configurationHash, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { decodeRecord, deliveryHash, encodePublication, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { withdrawalRecord } from "../src/pool/v3/witness.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type DeclaredVerifier, type ProofCheck, type SegmentState } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage, type RootTerms } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";
import { describeState } from "./pool-v3-state-description.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), operatorSecret = b(4), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), label = b(2), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
const counting = () => { const v = { checks: 0, identities: configuration.circuits, verify(_k: number, _i: bigint[], proof: Uint8Array) { v.checks++; return proof[0] !== 99; } }; return v; };
const outcome = (read: Awaited<ReturnType<typeof readFrontier>>) => ({ carrying: read.carrying, clock: read.clock, force: read.force,
  canonical: read.canonical === undefined ? undefined : { ...read.canonical, state: describeState(read.canonical.state) },
  ranges: read.ranges, faults: read.faultEvidence });
const settled = (p: Promise<Awaited<ReturnType<typeof readFrontier>>>) => p.then(r => ({ read: outcome(r) }), (e: Error) => ({ refused: e.message }));

const dirs: string[] = [], closers: { close(): void }[] = [];
afterEach(() => { for (const c of closers.splice(0)) c.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function files() {
  const dir = mkdtempSync(join(tmpdir(), "moe-kept-walk-")); dirs.push(dir);
  return { path: join(dir, "replay.sqlite"), digest: join(dir, "replay.sha256"), evidence: join(dir, "evidence.sqlite"), dir };
}
const keptStore = (k: { path: string; digest: string }) => { const s = new ReplayStore(k.path, { digest: k.digest }); closers.push(s); return s; };
const evidenceAt = (p: string) => { const s = new EvidenceStore(p); closers.push(s); return s; };

function fixture(extra: Partial<RootTerms> = {}) {
  const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore(), accept: ProofCheck = { verify: () => true };
  const fields: RootTerms = { configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n,
    payout: { thing: "kept state test", quantumExponent: 0, perUnit: 1n }, ...extra };
  const terms = encodeRootTerms(fields), backing = rootTermsName(terms);
  const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
  const items: EvidenceItem[] = [];
  const add = (kind: number, payload: Uint8Array) => { if (!items.some(i => i.kind === kind && compareBytes(i.payload, payload) === 0)) items.push({ kind, payload }); };
  const header: SegmentHeader = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] };
  const id = segmentIdentity(header);
  const segment = { header, id, state: openSegmentState(operatorStore, id, b(90), undefined) as SegmentState, records: [] as Uint8Array[], evidence: undefined as Uint8Array | undefined };
  const chain = (records: readonly Uint8Array[]): Uint8Array => records.reduce((previous, bytes, i) =>
    nextEvidenceHash(previous, evidenceHashes(decodeRecord(bytes)), BigInt(i + 1)), genesisEvidenceHash(id));
  const commitments: Commitment[] = [];
  function checkpoint(target: typeof segment, sequence: bigint, index: bigint): Commitment {
    const total = target.state.total(hex(backing));
    const snapshot = { backing, segment: id, historyHash: target.state.history, evidenceHash: target.evidence ?? target.state.evidence, ...total };
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }];
    const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
    add(3, encodeEvidenceDirectory(directory)); add(4, snapshotBytes(snapshot));
    add(6, encodeTrail({ header: segmentBytes(header), terms: [signed], records: target.records }));
    venue.witness(1, operator, index, encodeCommitment(commitment));
    commitments.push(commitment);
    return commitment;
  }
  function issued(output: bigint, signer = issuerSecret, proof = b(7)): Uint8Array {
    const scope = new ScopeTree(header.entries).root(), capsules = [new Uint8Array(89).fill(1)], outputs = [output];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(id), scope, ...limbsOf(backing),
      5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof, authorization: new Uint8Array(64), capsules };
    return encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), signer) });
  }
  async function issue(output: bigint, proof?: ReturnType<typeof b>) {
    const bytes = issued(output, issuerSecret, proof), scope = new ScopeTree(header.entries).root();
    await applyRecord(segment.state, bytes, { domain, backing, segment: id, scope, terms: fields, verifier: accept, index: 2n, block: [] });
    segment.records.push(bytes);
  }
  const read = (verifier: DeclaredVerifier, store?: ReplayStore, options: { evidence?: EvidenceStore; items?: EvidenceItem[]; at?: bigint } = {}) =>
    readFrontier(pack(options.items ?? items), signed, options.at ?? venue.witnessedIndex(), { verifier, reference, venue,
      ...(store === undefined ? {} : { store }), ...(options.evidence === undefined ? {} : { evidence: options.evidence }) });
  async function first() {
    checkpoint(segment, 1n, 1n);
    await issue(101n); checkpoint(segment, 2n, 2n);
    const hostile = [...segment.records, issued(102n), issued(103n, b(9))];
    checkpoint({ ...segment, records: hostile, evidence: chain(hostile) }, 3n, 3n);
    const rewritten = [issued(104n, issuerSecret, b(99)), issued(105n)];
    checkpoint({ ...segment, records: rewritten, evidence: chain(rewritten) }, 4n, 4n);
    await issue(106n); checkpoint(segment, 5n, 5n);
  }
  return { venue, backing, header, segment, items, commitments, checkpoint, issue, read, first };
}

describe("pool-v3 §14 kept walk: evidence lineage", () => {
  it("begins again on evidence restored to before a read at the same judging index", async () => {
    const f = fixture(), k = files();
    await f.first();
    const store = keptStore(k);
    const dir4 = f.items.filter(i => i.kind === 3)[3]!;          // checkpoint 4's directory (excluded, CONTINUITY)
    const without4 = f.items.filter(i => i !== dir4);
    let ev = evidenceAt(k.evidence);
    // Read 1 at t=10 lacks checkpoint 4's directory: refused, kept walk made (mark n1), cursor after 3.
    expect(await settled(f.read(counting(), store, { evidence: ev, items: without4 }))).toEqual({ refused: expect.stringContaining("") });
    ev.close(); copyFileSync(k.evidence, `${k.evidence}.backup`); ev = evidenceAt(k.evidence);
    // Read 2 at t=10 with all evidence: resumes (through equal: mark stays n1) and classifies 4 and 5.
    const full = await settled(f.read(counting(), store, { evidence: ev }));
    expect("read" in full).toBe(true);
    // Restore the evidence file to the copy taken before read 2: it lacks checkpoint 4's directory.
    ev.close(); copyFileSync(`${k.evidence}.backup`, k.evidence); ev = evidenceAt(k.evidence);
    const resumed = await settled(f.read(counting(), store, { evidence: ev, items: without4 }));
    // A fresh read over the same evidence (restored store + same package) refuses.
    copyFileSync(`${k.evidence}.backup`, join(k.dir, "fresh-ev2.sqlite"));
    const freshEv = evidenceAt(join(k.dir, "fresh-ev2.sqlite"));
    const fresh = await settled(f.read(counting(), undefined, { evidence: freshEv, items: without4 }));
    expect(fresh).toEqual({ refused: expect.any(String) });
    expect(resumed).toEqual(fresh);
  });

  it("begins again on evidence restored to before a read interrupted after a keep point", async () => {
    const f = fixture(), k = files();
    await f.first();
    f.venue.advance(12n); await f.issue(107n, b(97)); f.checkpoint(f.segment, 6n, 11n);
    const dir4 = f.items.filter(i => i.kind === 3)[3]!, without4 = f.items.filter(i => i !== dir4);
    let store = new ReplayStore(k.path, { digest: k.digest, every: 1 }); closers.push(store);
    let ev = evidenceAt(k.evidence);
    expect(await settled(f.read(counting(), store, { evidence: ev, items: without4 }))).toHaveProperty("refused");
    ev.close(); copyFileSync(k.evidence, k.evidence + ".backup"); ev = evidenceAt(k.evidence);
    const crash = join(k.dir, "crash"); fs.mkdirSync(crash); let copied = false;
    const v = { identities: configuration.circuits, verify(_k: number, _i: bigint[], proof: Uint8Array) {
      if (proof[0] === 97 && !copied) { for (const n of ["replay.sqlite", "replay.sqlite-journal", "replay.sha256"]) { const fr = join(k.dir, n); if (fs.existsSync(fr)) copyFileSync(fr, join(crash, n)); } copied = true; }
      return proof[0] !== 99; } };
    expect(await settled(f.read(v, store, { evidence: ev }))).toHaveProperty("read");
    expect(copied).toBe(true);
    // The process "crashed" at the copy; the evidence file is then restored to before read 2.
    copyFileSync(k.evidence + ".backup", join(crash, "evidence.sqlite"));
    const s2 = new ReplayStore(join(crash, "replay.sqlite"), { digest: join(crash, "replay.sha256") }); closers.push(s2);
    const e2 = evidenceAt(join(crash, "evidence.sqlite"));
    const resumed = await settled(f.read(counting(), s2, { evidence: e2, items: without4 }));
    copyFileSync(k.evidence + ".backup", join(k.dir, "fresh.sqlite"));
    const fresh = await settled(f.read(counting(), undefined, { evidence: evidenceAt(join(k.dir, "fresh.sqlite")), items: without4 }));
    expect(s2.keptRows()).toBeGreaterThan(0);
    expect(fresh).toEqual({ refused: expect.stringContaining("unresolved-evidence") });
    expect(resumed).toEqual(fresh);
  });
});

describe("pool-v3 §14 kept walk: publications", () => {
  it("reads force, publications and the non-service count as fresh reads do at each index", async () => {
    const f = fixture({ silence: { noCommitmentDuration: 8n, challengeWindow: 5n }, nonService: { duration: 2n, count: 1n, window: 5n } }), k = files();
    await f.first();
    const store = keptStore(k), ev = evidenceAt(k.evidence);
    const publish = (index: bigint, n: number) => f.venue.witness(4, f.backing, index, encodePublication({ domain, backing: f.backing, kind: 4,
      record: withdrawalRecord({ domain, header: f.header }, b(70 + n), b(71)) }));
    const both = async () => {
      const kept = await settled(f.read(counting(), store, { evidence: ev })), fresh = await settled(f.read(counting()));
      expect(kept).toEqual(fresh);
    };
    await both();
    f.venue.advance(12n); publish(11n, 0); await both();
    f.venue.advance(14n); publish(13n, 1); await both();
    f.venue.advance(16n); await f.issue(107n); f.checkpoint(f.segment, 6n, 15n); await both();
    f.venue.advance(19n); publish(17n, 2); publish(17n, 3); await both();
    f.venue.advance(30n); publish(29n, 4); await both();
  });
});

describe("pool-v3 §14 kept walk: interrupted and damaged", () => {
  it("resumes from a kept file copied mid-walk, after keep points, as a fresh read does", async () => {
    const f = fixture(), k = files();
    await f.first();
    f.venue.advance(12n); await f.issue(107n, b(97)); await f.issue(108n); f.checkpoint(f.segment, 6n, 11n);
    f.venue.advance(16n); await f.issue(109n); f.checkpoint(f.segment, 7n, 15n);
    const store = new ReplayStore(k.path, { digest: k.digest, every: 1 }); closers.push(store);
    const ev = evidenceAt(k.evidence);
    const crash = join(k.dir, "crash"); fs.mkdirSync(crash);
    let copied = false;
    const snap = () => { for (const name of ["replay.sqlite", "replay.sqlite-journal", "replay.sha256", "evidence.sqlite"]) {
      const from = join(k.dir, name); if (fs.existsSync(from)) fs.copyFileSync(from, join(crash, name)); } copied = true; };
    const v = { identities: configuration.circuits, verify(_k: number, _i: bigint[], proof: Uint8Array) { if (proof[0] === 97 && !copied) snap(); return proof[0] !== 99; } };
    const kept = outcome(await f.read(v, store, { evidence: ev }));
    expect(copied).toBe(true);
    const fresh = outcome(await f.read(counting()));
    expect(kept).toEqual(fresh);
    const s2 = new ReplayStore(join(crash, "replay.sqlite"), { digest: join(crash, "replay.sha256") }); closers.push(s2);
    expect(s2.keptRows()).toBeGreaterThan(0);
    const e2 = evidenceAt(join(crash, "evidence.sqlite"));
    expect(outcome(await f.read(counting(), s2, { evidence: e2 }))).toEqual(fresh);
    expect(outcome(await f.read(counting(), s2, { evidence: e2 }))).toEqual(fresh);
  });

  for (const sql of ["UPDATE walk_cursor SET link = zeroblob(32)", "UPDATE verdict SET snapshot = zeroblob(length(snapshot)) WHERE class = 'valid'",
    "UPDATE walk_cursor SET term = 5", "DELETE FROM verdict WHERE class = 'valid'"]) {
    it(`discards damaged kept-walk rows and reads again: ${sql}`, async () => {
      const f = fixture(), k = files();
      await f.first();
      let store = keptStore(k); const ev = evidenceAt(k.evidence);
      const fresh = await settled(f.read(counting()));
      expect(await settled(f.read(counting(), store, { evidence: ev }))).toEqual(fresh);
      store.close();
      const db = new DatabaseSync(k.path); db.exec(sql); db.close();
      writeFileSync(k.digest, createHash("sha256").update(readFileSync(k.path)).digest("hex"));
      store = keptStore(k);
      const again = await settled(f.read(counting(), store, { evidence: ev }));
      expect(again).toEqual(fresh);
      store.close();
      const d = new DatabaseSync(k.path, { readBigInts: true });
      const rows = (t: string) => Number((d.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: bigint }).c);
      expect([rows("kept_walk"), Number((d.prepare("SELECT count(*) AS c FROM walk_verdict WHERE walk NOT IN (SELECT walk FROM kept_walk)").get() as { c: bigint }).c)]).toEqual([1, 0]);
      d.close();
    });
  }

  it("keeps resuming after a read refused past the venue's index", async () => {
    const f = fixture(), k = files();
    await f.first();
    const store = keptStore(k), ev = evidenceAt(k.evidence);
    const judged = { n: 0 }; const orig = store.putVerdict.bind(store); store.putVerdict = (w, v) => { judged.n++; orig(w, v); };
    await f.read(counting(), store, { evidence: ev }); expect(judged.n).toBe(5); judged.n = 0;
    expect(await settled(f.read(counting(), store, { evidence: ev, at: 1_000_000n }))).toEqual({ refused: expect.stringContaining("unresolved-evidence") });
    await f.read(counting(), store, { evidence: ev }); expect(judged.n).toBe(0);
  });

  it("records no new digest for a read that changes nothing, and reopens to resume", async () => {
    const f = fixture({ silence: { noCommitmentDuration: 8n, challengeWindow: 5n } }), k = files();
    await f.first();
    let store = keptStore(k); const ev = evidenceAt(k.evidence);
    await f.read(counting(), store, { evidence: ev });
    const h = () => createHash("sha256").update(readFileSync(k.path)).digest("hex");
    const d0 = readFileSync(k.digest, "utf8"), m0 = fs.statSync(k.digest).mtimeMs;
    expect(d0).toBe(h());
    await f.read(counting(), store, { evidence: ev });
    expect(fs.statSync(k.digest).mtimeMs).toBe(m0);
    // A temporary walk at a lower index writes and drops rows of its own: the digest is recorded again, and holds.
    await f.read(counting(), store, { evidence: ev, at: 8n });
    expect(readFileSync(k.digest, "utf8")).toBe(h());
    store.close(); store = keptStore(k);
    expect(store.keptRows()).toBeGreaterThan(0);
    const judged = { n: 0 }; const orig = store.putVerdict.bind(store); store.putVerdict = (w, v) => { judged.n++; orig(w, v); };
    await f.read(counting(), store, { evidence: ev }); expect(judged.n).toBe(0);
  });

  it("discards kept classes whose snapshot no longer decodes, and reads again", async () => {
    const f = fixture(), k = files();
    await f.first();
    let store = keptStore(k); const ev = evidenceAt(k.evidence);
    await f.read(counting(), store, { evidence: ev }); store.close();
    const db = new DatabaseSync(k.path); db.exec("UPDATE verdict SET snapshot = zeroblob(length(snapshot))"); db.close();
    writeFileSync(k.digest, createHash("sha256").update(readFileSync(k.path)).digest("hex"));
    store = keptStore(k);
    const fresh = await settled(f.read(counting()));
    for (let i = 0; i < 2; i++) expect(await settled(f.read(counting(), store, { evidence: ev }))).toEqual(fresh);
    expect(await settled(f.read(counting(), store))).toEqual(fresh);
  });
});

describe("pool-v3 §14 kept walk: scope changes", () => {
  for (const next of ["x leaves the joint scope", "the joint segment continues"] as const) it(`lists what a fresh read lists where ${next} after a read around it`, async () => {
    const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore();
    const silence = { noCommitmentDuration: 50n, challengeWindow: 5n };
    const backings = ["walk x", "walk y"].map(thing => {
      const fields = { configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n, payout: { thing, quantumExponent: 0, perUnit: 1n }, silence };
      const terms = encodeRootTerms(fields);
      return { fields, name: rootTermsName(terms), signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) } };
    }).sort((a, z) => compareBytes(a.name, z.name));
    const [x, y] = backings as [typeof backings[0], typeof backings[0]];
    const items: EvidenceItem[] = [];
    const add = (kind: number, payload: Uint8Array) => { if (!items.some(i => i.kind === kind && compareBytes(i.payload, payload) === 0)) items.push({ kind, payload }); };
    type Scoped = { header: SegmentHeader; id: Uint8Array; scoped: typeof backings; state: SegmentState; records: Uint8Array[] };
    function checkpoint(seg: Scoped, sequence: bigint, index: bigint): Commitment {
      const snapshots = seg.scoped.map(item => ({ backing: item.name, segment: seg.id, historyHash: seg.state.history, evidenceHash: seg.state.evidence, ...seg.state.total(hex(item.name)) }));
      const directory = snapshots.map(s => ({ name: s.backing, digest: snapshotDigest(s) }));
      for (const s of snapshots) add(4, snapshotBytes(s));
      add(3, encodeEvidenceDirectory(directory));
      add(6, encodeTrail({ header: segmentBytes(seg.header), terms: seg.scoped.map(item => item.signed), records: seg.records }));
      const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
      venue.witness(1, operator, index, encodeCommitment(commitment));
      return commitment;
    }
    const seg = (sequence: bigint, scoped: typeof backings, openings: Map<string, Commitment>, from?: Scoped): Scoped => {
      const header: SegmentHeader = { domain, venue: venue.id, operator, sequence, entries: scoped.map(item => ({ backing: item.name, link: item.name,
        ...(openings.has(hex(item.name)) ? { opening: { operator, sequence: openings.get(hex(item.name))!.sequence, root: openings.get(hex(item.name))!.root } } : {}) })) };
      const id = segmentIdentity(header);
      return { header, id, scoped, state: openSegmentState(operatorStore, id, b(Number(90n + sequence)), from?.state), records: [] };
    };
    // S0 scopes x and y (opening at 1); Sy scopes y alone (opening at 2, importing S0's y).
    const s0 = seg(1n, [x, y], new Map());
    const c1 = checkpoint(s0, 1n, 1n);
    const sy = seg(2n, [y], new Map([[hex(y.name), c1]]), s0);
    checkpoint(sy, 2n, 2n);
    const read = (store?: ReplayStore, evidence?: EvidenceStore) => readFrontier(pack(items), x.signed, venue.witnessedIndex(),
      { verifier: counting(), reference, venue, ...(store === undefined ? {} : { store }), ...(evidence === undefined ? {} : { evidence }) });
    const dir = mkdtempSync(join(tmpdir(), "moe-kept-walk-")); dirs.push(dir);
    const store = new ReplayStore(join(dir, "r.sqlite"), { digest: join(dir, "r.sha256") }); closers.push(store);
    const evidence = new EvidenceStore(join(dir, "e.sqlite")); closers.push(evidence);
    const fresh1 = outcome(await read()), kept1 = outcome(await read(store, evidence));
    expect(kept1).toEqual(fresh1);
    // Either Sx scopes x alone (opening at 11, importing S0's x), so x's canonical leaves the joint scope; or S0
    // continues at 11, whose judgment reads y's latest valid checkpoint before it (Sy@2), which the earlier read
    // reached only around its canonical checkpoint.
    venue.advance(12n);
    if (next === "x leaves the joint scope") checkpoint(seg(3n, [x], new Map([[hex(x.name), c1]]), s0), 3n, 11n); else checkpoint(s0, 3n, 11n);
    venue.advance(13n);
    const fresh2 = outcome(await read()), kept2 = outcome(await read(store, evidence));
    // x's own checkpoints only: Sy@2 scopes y alone, whichever read classified it.
    expect(fresh2.carrying.map(c => c.sequence)).toEqual(["1", "3"]);
    expect(kept2).toEqual(fresh2);
    // A kept read asking for no listing reads the same frontier and lists nothing (M11b10).
    const unlisted = outcome(await readFrontier(pack(items), x.signed, venue.witnessedIndex(), { verifier: counting(), reference, venue, store, evidence, carrying: false }));
    expect(unlisted).toEqual({ ...kept2, carrying: [] });
  });

  it("lists what a fresh read lists where a backing's excluded checkpoint was passed around the canonical checkpoint", async () => {
    const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore();
    const silence = { noCommitmentDuration: 50n, challengeWindow: 5n };
    const backings = ["walk x", "walk y"].map(thing => {
      const fields = { configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n, payout: { thing, quantumExponent: 0, perUnit: 1n }, silence };
      const terms = encodeRootTerms(fields);
      return { fields, name: rootTermsName(terms), signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) } };
    }).sort((a, z) => compareBytes(a.name, z.name));
    const [x, y] = backings as [typeof backings[0], typeof backings[0]];
    const items: EvidenceItem[] = [];
    const add = (kind: number, payload: Uint8Array) => { if (!items.some(i => i.kind === kind && compareBytes(i.payload, payload) === 0)) items.push({ kind, payload }); };
    type Scoped = { header: SegmentHeader; id: Uint8Array; scoped: typeof backings; state: SegmentState; records: Uint8Array[] };
    function checkpoint(seg: Scoped, sequence: bigint, index: bigint): Commitment {
      const snapshots = seg.scoped.map(item => ({ backing: item.name, segment: seg.id, historyHash: seg.state.history, evidenceHash: seg.state.evidence, ...seg.state.total(hex(item.name)) }));
      const directory = snapshots.map(s => ({ name: s.backing, digest: snapshotDigest(s) }));
      for (const s of snapshots) add(4, snapshotBytes(s));
      add(3, encodeEvidenceDirectory(directory));
      add(6, encodeTrail({ header: segmentBytes(seg.header), terms: seg.scoped.map(item => item.signed), records: seg.records }));
      const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
      venue.witness(1, operator, index, encodeCommitment(commitment));
      return commitment;
    }
    const seg = (sequence: bigint, scoped: typeof backings, openings: Map<string, Commitment>, from?: Scoped): Scoped => {
      const header: SegmentHeader = { domain, venue: venue.id, operator, sequence, entries: scoped.map(item => ({ backing: item.name, link: item.name,
        ...(openings.has(hex(item.name)) ? { opening: { operator, sequence: openings.get(hex(item.name))!.sequence, root: openings.get(hex(item.name))!.root } } : {}) })) };
      const id = segmentIdentity(header);
      return { header, id, scoped, state: openSegmentState(operatorStore, id, b(Number(90n + sequence)), from?.state), records: [] };
    };
    // S0 scopes x and y (opening at 1); Sy scopes y alone (opening at 2, importing S0's y).
    const s0 = seg(1n, [x, y], new Map());
    const c1 = checkpoint(s0, 1n, 1n);
    const sy = seg(2n, [y], new Map([[hex(y.name), c1]]), s0);
    checkpoint(sy, 2n, 2n);
    // Sy2: a y-only opening importing C1 though Sy@2 is y's latest valid (excluded, IMPORT); then Sy continues at 4.
    const sy2 = seg(3n, [y], new Map([[hex(y.name), c1]]), s0);
    checkpoint(sy2, 3n, 3n);
    checkpoint(sy, 4n, 4n);
    const read = (store?: ReplayStore, evidence?: EvidenceStore) => readFrontier(pack(items), x.signed, venue.witnessedIndex(),
      { verifier: counting(), reference, venue, ...(store === undefined ? {} : { store }), ...(evidence === undefined ? {} : { evidence }) });
    const dir = mkdtempSync(join(tmpdir(), "moe-kept-walk-")); dirs.push(dir);
    const store = new ReplayStore(join(dir, "r.sqlite"), { digest: join(dir, "r.sha256") }); closers.push(store);
    const evidence = new EvidenceStore(join(dir, "e.sqlite")); closers.push(evidence);
    const fresh1 = outcome(await read()), kept1 = outcome(await read(store, evidence));
    expect(kept1).toEqual(fresh1);
    // S0 continues at 11: its judgment reads y's latest valid before it (Sy@2), which the earlier read reached only around C1.
    venue.advance(12n); checkpoint(s0, 5n, 11n); venue.advance(13n);
    const fresh2 = outcome(await read()), kept2 = outcome(await read(store, evidence));
    expect(kept2).toEqual(fresh2);

  });
});
