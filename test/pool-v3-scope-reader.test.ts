import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, encodeReplacement, replacementMessage, ROLE_OPERATOR, signCommitment, type Commitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { decodeSnapshot, encodeReceipt, receiptBytes, snapshotBytes } from "../src/pool/v3/commitments.js";
import { configurationBytes, configurationHash, RELATIONS, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { mergeFinalizedPrefixes } from "../src/pool/v3/scope-reader.js";
import { ReplayResult } from "../src/pool/v3/reader.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type SegmentState } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage, type RootTerms } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";

// Oracle proofs isolate the scope reader's evidence contract; real-proof
// scope groups run in scripts/pool/v3/local-check.mjs through readPackage.
const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), operatorSecret = b(4);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), label = b(2), lag = 2n;
const reference = { context: LOCAL_REFERENCE, label, lag } as const, verifier = { verify: () => true, identities: configuration.circuits };
const stateOf = <T extends { readonly receipt?: unknown }>(result: T): Exclude<T, { readonly receipt: object }> => {
  if (result.receipt !== undefined) throw new Error("a receipt verdict");
  return result as Exclude<T, { readonly receipt: object }>;
};
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));

/** One operator opens a segment scoping two backings and issues into the first;
 * a successor segment may then import the first backing alone. */
async function twoBackings(silence?: bigint, witnessed = 10n, link?: Uint8Array) {
  const venue = FixtureVenue.reference(label, lag, witnessed), operatorStore = new ReplayStore();
  const termsOf = (thing: string): RootTerms => ({ configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n,
    payout: { thing, quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(b(6)),
    ...(silence === undefined ? {} : { silence: { noCommitmentDuration: silence, challengeWindow: 5n } }) });
  const backings = ["scope test x", "scope test y"].map(thing => {
    const fields = termsOf(thing), terms = encodeRootTerms(fields);
    return { fields, name: rootTermsName(terms), signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) } };
  }).sort((a, z) => compareBytes(a.name, z.name));
  const [x, y] = backings as [typeof backings[0], typeof backings[0]];
  const open = (scoped: typeof backings, sequence: bigint, predecessor?: Commitment, imported?: SegmentState) => {
    const header: SegmentHeader = { domain, venue: venue.id, operator, sequence,
      entries: scoped.map(item => ({ backing: item.name, link: link ?? item.name, ...(predecessor === undefined ? {} : { opening: predecessor }) })) };
    const id = segmentIdentity(header);
    return { header, id, scoped, scope: new ScopeTree(header.entries).root(), records: [] as Uint8Array[],
      scopedTerms: new Map(scoped.map(item => [hex(item.name), item.fields])),
      state: openSegmentState(operatorStore, id, b(90), imported) };
  };
  let current = open(backings, 1n);
  const items: EvidenceItem[] = [];
  const add = (kind: number, payload: Uint8Array) => {
    if (!items.some(item => item.kind === kind && compareBytes(item.payload, payload) === 0)) items.push({ kind, payload });
  };
  /** Commit the current state, witnessed at `index` (none: signed and served, never witnessed); `alter` may drop
   * or change the directory's snapshots, and `preimage` give a snapshot's committed bytes. */
  function checkpoint(sequence: bigint, index: bigint | undefined, alter = (snapshots: ReturnType<typeof snapshotsNow>) => snapshots,
    preimage: (snapshot: ReturnType<typeof snapshotsNow>[number]) => Uint8Array = snapshotBytes): Commitment {
    const snapshots = alter(snapshotsNow());
    const directory = snapshots.map(snapshot => ({ name: snapshot.backing, digest: sha256(preimage(snapshot)) }));
    for (const snapshot of snapshots) add(4, preimage(snapshot));
    add(3, encodeEvidenceDirectory(directory));
    add(6, encodeTrail({ header: segmentBytes(current.header), terms: current.scoped.map(item => item.signed), records: current.records }));
    const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
    if (index !== undefined) venue.witness(1, operator, index, encodeCommitment(commitment));
    return commitment;
  }
  function snapshotsNow() {
    const { id, state } = current;
    return current.scoped.map(item => ({ backing: item.name, segment: id, historyHash: state.history, evidenceHash: state.evidence,
      ...state.total(hex(item.name)) }));
  }
  function issued(value: bigint, output: bigint, id = current.id): Uint8Array {
    const { scope } = current, capsules = [new Uint8Array(89).fill(1)], outputs = [output];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(id), scope, ...limbsOf(x.name),
      value, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
    return encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
  }
  const replayOf = (id: Uint8Array) => ({ domain, backing: x.name, segment: id, scope: current.scope, terms: x.fields,
    scopedTerms: current.scopedTerms, verifier, index: 2n, block: [] });
  async function issue(value: bigint, output: bigint) {
    const bytes = issued(value, output);
    await applyRecord(current.state, bytes, replayOf(current.id));
    current.records.push(bytes);
  }
  /** A reader's replay of `records` for segment `id` in `store`, under its own identity. */
  async function replayInto(store: ReplayStore, identity: Uint8Array, records: Uint8Array[], id = current.id): Promise<ReplayResult> {
    const state = openSegmentState(store, id, identity, undefined);
    for (const bytes of records) await applyRecord(state, bytes, replayOf(id));
    const { issued: total, burned } = state.total(hex(x.name));
    return new ReplayResult(store, state.ns, state.position, { issued: total, burned, adoptionIndices: new Map(), identity });
  }
  const selection = (backing: Uint8Array, commitment: Commitment) => ({ mode: "current-fixture" as const, domain, venue: venue.id,
    backing, operator, sequence: commitment.sequence, root: commitment.root, judgingIndex: venue.witnessedIndex() });
  const read = (backing: Uint8Array, commitment: Commitment, extra: readonly EvidenceItem[] = [], carrying?: boolean) => readPackage(pack([...items, ...extra,
    { kind: 1, payload: configurationBytes(configuration) }, { kind: 2, payload: encodeCommitment(commitment) }]),
  selection(backing, commitment), { verifier, reference, venue, ...(carrying === undefined ? {} : { carrying }) });
  /** The operator's receipt for the current segment's latest record, given after sequence `after`. */
  function receipt(after: bigint): Uint8Array {
    const bytes = current.records.at(-1)!, digests = evidenceHashes(decodeRecord(bytes));
    const fields = { domain, segment: current.id, scopeRoot: current.scope, position: BigInt(current.records.length),
      statementHash: digests.statementHash, historyHash: current.state.history, proofHash: digests.proofHash, signatureHash: digests.signatureHash, after };
    return encodeReceipt({ ...fields, operator, signature: ed25519.sign(receiptBytes(fields), operatorSecret) });
  }
  /** An empty successor opening scoping the first backing alone, importing `predecessor`. */
  const successor = (sequence: bigint, predecessor: Commitment) => { current = open([x], sequence, predecessor, current.state); };
  /** An empty opening scoping both backings that imports nothing: a repair where no checkpoint is valid. */
  const fresh = (sequence: bigint) => { current = open(backings, sequence); };
  /** Witness at `index` the replacement of `x`'s first operator, effective from `effective`. */
  const replaceX = (index: bigint, effective: bigint) => {
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(b(9)), predecessor: x.name, effective,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(x.name, fields);
    venue.witness(2, x.name, index, encodeReplacement(x.name, { ...fields, signature: ed25519.sign(message, b(6)), successorSignature: ed25519.sign(message, b(9)) }));
  };
  return { venue, x, y, items, checkpoint, issue, issued, replayInto, successor, fresh, replaceX, selection, read, receipt };
}

describe("multi-backing scope reader", () => {
  it("reads each scoped backing's totals from one shared history through the runtime entry", async () => {
    const f = await twoBackings();
    const opening = f.checkpoint(1n, 1n);
    await f.issue(5n, 101n);
    const latest = f.checkpoint(2n, 3n);
    const [readX, readY] = [stateOf(await f.read(f.x.name, latest)), stateOf(await f.read(f.y.name, latest))];
    expect(readX.state.issued).toBe(5n); expect(readY.state.issued).toBe(0n);
    expect(readX.state.history).toEqual(readY.state.history);
    expect(readX.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["2", "valid"]]);
    expect(readX.ranges.heldBefore).toBe(1);
    // A read asking for no listing (the journal's own, M11b10) judges the same state, clock and ranges and lists nothing.
    const unlisted = stateOf(await f.read(f.x.name, latest, [], false));
    expect({ ...unlisted, carrying: readX.carrying }).toEqual(readX);
    expect(unlisted.carrying).toEqual([]);
    await expect(f.read(f.x.name, opening)).rejects.toMatchObject({ status: "superseded-selection" });
  });

  it("reads a single-backing successor whose predecessor scoped two backings through the scope reader", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, 1n); await f.issue(5n, 101n);
    const predecessor = f.checkpoint(2n, 3n);
    f.successor(3n, predecessor);
    const opening = f.checkpoint(3n, 4n);
    const read = stateOf(await f.read(f.x.name, opening));
    expect(read.state.issued).toBe(5n); expect(read.state.position).toBe(0n);
    expect(read.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["2", "valid"], ["3", "valid"]]);
    // The successor must import the scoped predecessor, not the segment's older opening.
    const stale = await twoBackings();
    const first = stale.checkpoint(1n, 1n); await stale.issue(5n, 101n); stale.checkpoint(2n, 3n);
    stale.successor(3n, first);
    await expect(stale.read(stale.x.name, stale.checkpoint(3n, 4n))).rejects.toMatchObject({ check: "IMPORT" });
  });

  it("excludes a checkpoint whose directory omits a scoped backing or misstates its supply", async () => {
    const omitted = await twoBackings();
    omitted.checkpoint(1n, 1n); await omitted.issue(5n, 101n);
    const partial = omitted.checkpoint(2n, 3n, snapshots => snapshots.filter(s => compareBytes(s.backing, omitted.x.name) === 0));
    await expect(omitted.read(omitted.x.name, partial)).rejects.toMatchObject({ check: "SCOPE" });
    const misstated = await twoBackings();
    misstated.checkpoint(1n, 1n); await misstated.issue(5n, 101n);
    const wrong = misstated.checkpoint(2n, 3n, snapshots => snapshots.map(s =>
      compareBytes(s.backing, misstated.y.name) === 0 ? { ...s, issued: 5n } : s));
    await expect(misstated.read(misstated.x.name, wrong)).rejects.toMatchObject({ check: "SNAPSHOT" });
  });

  it("reads one class for a checkpoint whichever scoped backing is read, where the opening omits or misplaces one (C2.10.11-12)", async () => {
    const cases = [
      // The opening carries the first backing alone: excluded for its scope, it still founds the segment.
      { check: "SCOPE", alter: (f: Awaited<ReturnType<typeof twoBackings>>) => (snapshots: ReturnType<Parameters<typeof f.checkpoint>[2] & {}>) =>
        snapshots.filter(s => compareBytes(s.backing, f.x.name) === 0) },
      // The opening's second snapshot names another segment: judged in the first one's segment, it fails there.
      { check: "SNAPSHOT", alter: (f: Awaited<ReturnType<typeof twoBackings>>) => (snapshots: ReturnType<Parameters<typeof f.checkpoint>[2] & {}>) =>
        snapshots.map(s => compareBytes(s.backing, f.y.name) === 0 ? { ...s, segment: b(77) } : s) },
    ];
    for (const { check, alter } of cases) {
      const f = await twoBackings();
      f.checkpoint(1n, 1n, alter(f)); await f.issue(5n, 101n);
      const latest = f.checkpoint(2n, 3n);
      const [readX, readY] = [stateOf(await f.read(f.x.name, latest)), stateOf(await f.read(f.y.name, latest))];
      // Each read lists its own backing's carrying checkpoints: where the opening omits y, y's read classifies it
      // (one class, the segment's opening) without listing it.
      expect(readX.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "excluded", check], ["2", "valid", undefined]]);
      expect(readY.carrying.map(item => [item.sequence, item.class, item.check])).toEqual(check === "SCOPE" ?
        [["2", "valid", undefined]] : [["1", "excluded", check], ["2", "valid", undefined]]);
      expect([readX.state.issued, readY.state.issued]).toEqual([5n, 0n]);
    }
  });

  it("finds no opening at a sequence whose first entry the segment does not scope, from the directory alone (C2.10.12)", async () => {
    const f = await twoBackings();
    // The operator's sequence 1 carries another backing only, and that backing's snapshot preimage is not supplied.
    f.checkpoint(1n, 1n, snapshots => [{ ...snapshots[0]!, backing: b(88) }]);
    f.items.splice(f.items.findIndex(item => item.kind === 4), 1);
    await f.issue(5n, 101n);
    const latest = f.checkpoint(2n, 3n);
    for (const backing of [f.x.name, f.y.name]) await expect(f.read(backing, latest)).rejects.toMatchObject({ check: "OPENING" });
  });

  it("reads a receipt final where a valid checkpoint includes it, in a segment whose opening is excluded (C2.10.12, C2.10.9c)", async () => {
    const f = await twoBackings();
    // The opening misstates a supply: excluded, it still founds the segment.
    f.checkpoint(1n, 1n, snapshots => snapshots.map(s => ({ ...s, issued: s.issued + 1n })));
    await f.issue(5n, 101n);
    const receipt = f.receipt(1n), latest = f.checkpoint(2n, 3n);
    const read = await f.read(f.x.name, latest, [{ kind: 10, payload: receipt }]);
    expect(read.receipt).toMatchObject({ status: "final", includedAt: [{ sequence: "2" }] });
  });

  it("reads a receipt whose `after` names a checkpoint with a misplaced snapshot alike for every scoped backing (C2.10.9c)", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, 1n);
    // Checkpoint 2's second snapshot names another segment: judged in the first one's, it is excluded.
    f.checkpoint(2n, 2n, snapshots => snapshots.map(s => compareBytes(s.backing, f.y.name) === 0 ? { ...s, segment: b(77) } : s));
    await f.issue(5n, 101n);
    const receipt = f.receipt(2n), latest = f.checkpoint(3n, 4n);
    for (const backing of [f.x.name, f.y.name]) {
      expect((await f.read(backing, latest, [{ kind: 10, payload: receipt }])).receipt).toMatchObject({ status: "final", includedAt: [{ sequence: "3" }] });
    }
  });

  it("excludes a continuation whose segment opening the record moved past, so a repair opening reads (C2.3.3, C2.10.11)", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, undefined); // the opening: signed and served, never witnessed
    await f.issue(5n, 101n);
    const continuation = f.checkpoint(2n, 3n);
    for (const backing of [f.x.name, f.y.name]) await expect(f.read(backing, continuation)).rejects.toMatchObject({ check: "OPENING" });
    // The record is complete, so this is a verdict and the operator's repair opening reads past it.
    f.fresh(3n);
    const repair = stateOf(await f.read(f.x.name, f.checkpoint(3n, 4n)));
    expect(repair.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["2", "excluded", "OPENING"], ["3", "valid", undefined]]);
    expect([repair.state.issued, repair.state.position]).toEqual([0n, 0n]);
  });

  it("lapses an unopened continuation witnessed while a scoped gap is open, judging lapse before validity (C2.10.11)", async () => {
    for (const [silence, expected] of [[4n, { status: "lapsed-selection", clock: { duration: "4", snapshotIndex: "1", gap: "11", open: true } }],
      [20n, { check: "OPENING" }]] as const) {
      const f = await twoBackings(silence, 20n);
      f.checkpoint(1n, 1n);
      f.fresh(2n); f.checkpoint(2n, undefined); // a second segment's opening, never witnessed
      await f.issue(5n, 101n);
      const continuation = f.checkpoint(3n, 12n); // c(12) = 1: the gap is open under a duration of 4, not of 20
      await expect(f.read(f.x.name, continuation)).rejects.toMatchObject(expected);
    }
  });

  it("lapses a receipt whose `after` the record moved past without holding it (C2.10.9b, C2b.4)", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, undefined);
    await f.issue(5n, 101n);
    const receipt = f.receipt(1n);
    f.fresh(2n);
    const repair = f.checkpoint(2n, 3n);
    for (const backing of [f.x.name, f.y.name]) {
      expect((await f.read(backing, repair, [{ kind: 10, payload: receipt }])).receipt).toMatchObject({ status: "lapsed", sequence: "moved-past",
        lapse: { kind: "moved-past" } });
    }
  });

  it("abandons a receipt on a continuation of a segment that never opened at the operator's next scope change (C2.10.9b)", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, undefined);
    await f.issue(5n, 101n);
    f.checkpoint(2n, 3n); // held, and excluded: its opening was never held
    const receipt = f.receipt(2n);
    f.fresh(3n);
    const next = f.checkpoint(3n, 4n);
    expect((await f.read(f.x.name, next, [{ kind: 10, payload: receipt }])).receipt).toMatchObject({ status: "abandoned", sequence: "held",
      abandonedAt: { sequence: "3" } });
  });

  it("lapses a receipt of a segment whose opening was witnessed after a scoped term ended (C2.10.9b)", async () => {
    const f = await twoBackings();
    f.replaceX(1n, 6n); // effective at the lead floor, index + 2·lag + 1
    const opening = f.checkpoint(1n, 7n); // lapsed for its whole scope: x's first term ended at 6
    await f.issue(5n, 101n);
    const receipt = f.receipt(1n);
    expect((await f.read(f.x.name, opening, [{ kind: 10, payload: receipt }])).receipt).toMatchObject({ status: "lapsed",
      lapse: { kind: "scope-boundary", at: "6" } });
    await expect(f.read(f.x.name, opening)).rejects.toMatchObject({ status: "lapsed-selection" });
  });

  it("rolls back a checkpoint excluded for a sibling's totals, so the next one resumes without extra work", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, 1n); await f.issue(5n, 101n); f.checkpoint(2n, 3n);
    await f.issue(1n, 102n);
    // Its records replay, then the other scoped backing's snapshot misstates supply: excluded after the records applied.
    f.checkpoint(3n, 4n, snapshots => snapshots.map(s => compareBytes(s.backing, f.y.name) === 0 ? { ...s, issued: 9n } : s));
    await f.issue(1n, 103n);
    const last = f.checkpoint(4n, 5n), read = await f.read(f.x.name, last);
    if (read.receipt !== undefined) throw new Error("a receipt verdict");
    expect(read.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "valid", undefined], ["2", "valid", undefined],
      ["3", "excluded", "SNAPSHOT"], ["4", "valid", undefined]]);
    const state = read.state;
    expect([state.position, state.store.tip(state.ns).position, state.leaves]).toEqual([3n, 3n, 3n]);
    // One namespace carried 1, 2 and 4, and 4 resumed at 2's tip.
    expect(state.store.namespaces(state.identity)).toEqual([state.ns]);
  });

  it("merges imported prefixes once per parent state and refuses a conflicting identity", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, 1n); await f.issue(5n, 101n);
    const read = await f.read(f.x.name, f.checkpoint(2n, 3n));
    const store = read.state!.store;
    // A parent state named twice is merged once.
    const merged = mergeFinalizedPrefixes(store, [{ state: read.state! }, { state: read.state! }, undefined]);
    expect([...merged.frontier.segments.values()]).toEqual([{ ns: read.state!.ns, upto: 1n }]);
    expect(merged.frontier.totals.get(hex(f.x.name))).toEqual({ issued: 5n, burned: 0n });
    // Another replay of the same segment agreeing on the shared prefix merges into the longer one.
    const longer = await f.replayInto(store, b(91), [f.issued(5n, 101n), f.issued(1n, 103n)]);
    const joined = mergeFinalizedPrefixes(store, [{ state: read.state! }, { state: longer }]);
    expect([...joined.frontier.segments.values()]).toEqual([{ ns: longer.ns, upto: 2n }]);
    expect(joined.frontier.totals.get(hex(f.x.name))).toEqual({ issued: 6n, burned: 0n });
    // Two replays of one segment disagreeing at a shared position are conflicting histories.
    const conflicting = await f.replayInto(store, b(92), [f.issued(5n, 102n)]);
    expect(() => mergeFinalizedPrefixes(store, [{ state: read.state! }, { state: conflicting }])).toThrow(expect.objectContaining({ check: "CONTINUITY" }));
    // A distinct event repeating an imported output is a conflicting history.
    const repeated = await f.replayInto(store, b(93), [f.issued(5n, 101n, b(94))], b(94));
    expect(() => mergeFinalizedPrefixes(store, [{ state: read.state! }, { state: repeated }])).toThrow(expect.objectContaining({ check: "OUTPUT" }));
  });

  it("reads a committed snapshot preimage that does not decode as unresolved, never a verdict (pool-v3 §7, C2.10.11)", async () => {
    for (const odd of ["first", "second"] as const) {
      const f = await twoBackings();
      f.checkpoint(1n, 1n); await f.issue(5n, 101n);
      const target = odd === "first" ? f.x.name : f.y.name;
      // The preimage hashes to the signed digest, but a trailing byte leaves it undecodable under §7's strict codec.
      const odds = f.checkpoint(2n, 3n, snapshots => snapshots, snapshot => compareBytes(snapshot.backing, target) === 0 ?
        new Uint8Array([...snapshotBytes(snapshot), 0]) : snapshotBytes(snapshot));
      for (const backing of [f.x.name, f.y.name]) await expect(f.read(backing, odds)).rejects.toMatchObject({ status: "unresolved-evidence" });
    }
  });

  it("lapses a checkpoint witnessed after a scoped term ended whose own snapshot preimage is withheld (C2.10.11)", async () => {
    const f = await twoBackings();
    f.replaceX(1n, 6n); // x's first term ends at 6
    const opening = f.checkpoint(1n, 7n);
    // y's preimage is withheld; the first snapshot (x's) authenticates the header and scope that term lapse reads.
    f.items.splice(f.items.findIndex(item => item.kind === 4 && compareBytes(decodeSnapshot(item.payload).backing, f.y.name) === 0), 1);
    await expect(f.read(f.y.name, opening)).rejects.toMatchObject({ status: "lapsed-selection" });
  });

  it("judges a continuation's silence lapse before a scope term not in force (C2.10.11)", async () => {
    for (const [silence, expected] of [[4n, { status: "lapsed-selection", clock: { duration: "4", open: true } }],
      [20n, { check: "TERMS_SCOPE" }]] as const) {
      const f = await twoBackings(silence, 20n, b(55)); // every scoped link names a term the replacement chain does not hold
      f.checkpoint(1n, 1n); // excluded TERMS_SCOPE: no valid checkpoint closes either backing's interval
      await f.issue(5n, 101n);
      const continuation = f.checkpoint(2n, 12n); // c(12) = 0: the gap is open under a duration of 4, not of 20
      await expect(f.read(f.x.name, continuation)).rejects.toMatchObject(expected);
    }
  });

  it("reads a selected checkpoint whose own snapshot names another segment in the first snapshot's segment (pool-v3 §7.1)", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, 1n); await f.issue(5n, 101n);
    const misplaced = f.checkpoint(2n, 3n, snapshots => snapshots.map(s => compareBytes(s.backing, f.y.name) === 0 ? { ...s, segment: b(77) } : s));
    for (const backing of [f.x.name, f.y.name]) await expect(f.read(backing, misplaced)).rejects.toMatchObject({ check: "SNAPSHOT" });
  });
});
