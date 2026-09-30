import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { decodeReceipt, decodeSnapshot, snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { decodeSegmentHeader, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { decodeEvidencePackage, encodeEvidenceDirectory, encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodePublication, encodeRecord, type Record } from "../src/pool/v3/records.js";
import type { ServedPackage, V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import { authorizeIssue, demandTask, issueTask, spendTask, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, encodeReplacement, encodeRevocation, replacementHash, replacementMessage,
  signCommitment, signRevocation, type Replacement } from "../src/venue-records.js";

// Public-evidence succession through the runtime journal and independent reader.
// Proof bytes are explicit stand-ins; real-key acceptance is a separate gate.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), issuerSecret = b(15), aSecret = b(16), bSecret = b(17), cSecret = b(18);
const issuer = ed25519.getPublicKey(issuerSecret), aKey = ed25519.getPublicKey(aSecret), bKey = ed25519.getPublicKey(bSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(32).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });

describe.skipIf(!supported)("v3 succession from public evidence", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  const journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => { ({ V3OperatorJournal } = await import("../src/pool/v3/store.js")); });
  afterEach(() => {
    for (const j of journals.splice(0)) j.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  function fixture(silence = false) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-succession-journal-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator: aKey, replacementRule: issuer, configuration: domain,
      venue: venue.id, interval: 30n, payout: { thing: "succession units", quantumExponent: 0, perUnit: 1n },
      ...(silence ? { silence: { noCommitmentDuration: 4n, challengeWindow: 5n } } : {}) });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const header: SegmentHeader = { domain, venue: venue.id, operator: aKey, sequence: 1n, entries: [{ backing, link: backing }] };
    const context = { domain, header };
    const funded = prepareExactOutput(b(21), domain, b(31), backing, 10n), pad = prepareExactOutput(b(21), domain, b(32), backing, 0n);
    const tree = new NoteTree(); tree.append(funded.cm);
    const input = { note: funded, anchor: tree.root(), path: tree.path(0n) }, inputs = [input, { ...input, note: pad }];
    const create = (secret = aSecret, name = "a", beforeVerify = () => {}): Journal => {
      const j = new V3OperatorJournal(join(directory, `${name}.db`), { configuration, secret, venue, reference,
        verifier: { verify: (...args) => { beforeVerify(); return verifier.verify(...args); } } });
      journals.push(j); return j;
    };
    const replace = async (secret = bSecret, predecessor = backing, effective = venue.witnessedIndex() + 2n * lag + 2n,
      authority = issuerSecret, consent = secret) => {
      const unsigned: Replacement = { role: 1, successor: ed25519.getPublicKey(secret), predecessor, effective,
        signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
      const message = replacementMessage(backing, unsigned);
      const replacement = { ...unsigned, signature: ed25519.sign(message, authority), successorSignature: ed25519.sign(message, consent) };
      await venue.publishRecord(2, backing, encodeReplacement(backing, replacement));
      return { link: replacementHash(backing, replacement), effective, replacement };
    };
    const issue = (ctx = context, id = 31) => encodeRecord(authorizeIssue(record(issueTask(ctx,
      id === 31 ? funded : prepareExactOutput(b(21), domain, b(id), backing, 10n))), issuerSecret));
    const spend = (ctx: SegmentContext, offset = 60) => encodeRecord(record(spendTask(ctx, inputs,
      [10n, 0n, 0n, 0n].map((value, i) => prepareExactOutput(b(22), domain, b(offset + i), backing, value)))));
    const read = async (served: ServedPackage) => {
      const result = await readPackage(served.package,
        { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" }, { configuration, verifier, venue, reference });
      if (result.state === undefined) throw new Error("unexpected receipt verdict");
      return result;
    };
    const openingContext = async (j: Journal): Promise<SegmentContext> => {
      const served = await j.package();
      const headers = decodeEvidencePackage(served.package).filter(item => item.kind === 6)
        .map(item => decodeSegmentHeader(decodeTrail(item.payload).header));
      const selected = headers.filter(h => Buffer.from(h.operator).equals(Buffer.from(j.operatorKey)))
        .sort((x, y) => x.sequence > y.sequence ? -1 : x.sequence < y.sequence ? 1 : 0)[0];
      if (selected === undefined) throw new Error("missing active header");
      return { domain, header: selected };
    };
    return { venue, signed, backing, context, funded, input, inputs, create, replace, issue, spend, read, openingContext };
  }
  async function fundedFixture(silence = false) {
    const f = fixture(silence), a = f.create();
    await a.open("genesis", f.signed); await a.publish();
    await a.submit(f.issue()); await a.commit("issued"); await a.publish();
    return { ...f, a, held: await a.package() };
  }
  async function transferred() {
    const f = await fundedFixture(), next = await f.replace(); f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b"), opening = await successor.takeover("takeover", f.signed, f.held.package);
    await successor.publish(); await successor.adopt();
    return { ...f, next, successor, opening, successorContext: await f.openingContext(successor) };
  }

  it("imports A's finalized note into B, waits for opening adoption, and serves independently verified spending", async () => {
    const f = await fundedFixture(), next = await f.replace(); f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b"), opening = await successor.takeover("takeover", f.signed, f.held.package);
    expect(opening.sequence).toBe(1n); expect(opening.operator).toEqual(bKey);
    await expect(successor.commit("before-opening")).rejects.toMatchObject({ code: "STALE" });
    await expect(successor.adopt()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await successor.publish();
    await expect(successor.commit("before-adoption")).rejects.toMatchObject({ code: "STALE" });
    expect(await successor.adopt()).toEqual([]);
    const ctx = await f.openingContext(successor);
    expect(ctx.header.entries[0]!.link).toEqual(next.link);
    expect(ctx.header.entries[0]!.opening).toMatchObject({ operator: aKey, sequence: 2n, root: f.held.selection.root });
    expect(decodeReceipt(await successor.submit(f.spend(ctx))).position).toBe(1n);
    await successor.commit("spent"); await successor.publish();
    const result = await f.read(await successor.package());
    expect(result.state.issued).toBe(10n); expect(result.state.burned).toBe(0n);
    expect(result.state.hasNullifier(f.input.note.nf)).toBe(true);
    await expect(f.a.submit(f.issue(f.context, 75))).rejects.toMatchObject({ code: "STALE" });
  });

  it("denies pending and superseded handovers, invalid authority, and invalid successor consent", async () => {
    const f = await fundedFixture(), successor = f.create(bSecret, "b"), next = await f.replace();
    await expect(successor.takeover("pending", f.signed, f.held.package)).rejects.toMatchObject({ code: "STALE" });
    const later = await f.replace(cSecret); f.venue.advance(later.effective);
    await expect(successor.takeover("replaced", f.signed, f.held.package)).rejects.toMatchObject({ code: "STALE" });
    expect(next.effective).toBeLessThan(later.effective);
    for (const wrong of ["authority", "consent"]) {
      const g = await fundedFixture(), j = g.create(bSecret, "b");
      const invalid = await g.replace(bSecret, g.backing, undefined, wrong === "authority" ? cSecret : issuerSecret,
        wrong === "consent" ? cSecret : bSecret);
      g.venue.advance(invalid.effective);
      await expect(j.takeover("unauthorized", g.signed, g.held.package)).rejects.toMatchObject({ code: "STALE" });
    }
  });

  it("rejects a bad terms signature and lets incumbent-self replacement cancel a pending handover", async () => {
    const f = await fundedFixture(), successor = f.create(bSecret, "b"), next = await f.replace();
    await expect(successor.takeover("bad-terms", { ...f.signed, signature: new Uint8Array(64) }, f.held.package))
      .rejects.toMatchObject({ code: "REFUSED" });
    await f.replace(aSecret); f.venue.advance(next.effective);
    await expect(successor.takeover("cancelled", f.signed, f.held.package)).rejects.toMatchObject({ code: "STALE" });
    await f.a.submit(f.issue(f.context, 75));
    await f.a.commit("still-incumbent"); await f.a.publish();
    expect((await f.read(await f.a.package())).state.issued).toBe(20n);
  });

  it("opens an authorized empty book only after proving no prior carrying checkpoint", async () => {
    const f = fixture(), next = await f.replace(); f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b"), empty = encodeEvidencePackage([]);
    const opening = await successor.takeover("empty", f.signed, empty);
    expect(opening.sequence).toBe(1n);
    await expect(successor.adopt()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await successor.publish(); await successor.adopt();
    const ctx = await f.openingContext(successor);
    expect(ctx.header.entries[0]!.opening).toBeUndefined();
    expect(ctx.header.entries[0]!.link).toEqual(next.link);
    await successor.submit(f.issue(ctx)); await successor.commit("first-issue"); await successor.publish();
    expect((await f.read(await successor.package())).state.issued).toBe(10n);
  });

  it.each([3, 4, 6])("refuses unavailable predecessor evidence kind %i without consuming the command", async kind => {
    const f = await fundedFixture(), next = await f.replace(); f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b"), items = decodeEvidencePackage(f.held.package);
    const withheld = encodeEvidencePackage(items.filter(item => item.kind !== kind));
    await expect(successor.takeover("retry", f.signed, withheld)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(successor.takeover("empty-lie", f.signed, encodeEvidencePackage([])))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await successor.takeover("retry", f.signed, f.held.package)).sequence).toBe(1n);
  });

  it("keeps nothing of a refused takeover's evidence: later attempts cannot lean on it", async () => {
    const f = await fundedFixture(), next = await f.replace(); f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b"), items = decodeEvidencePackage(f.held.package);
    // Between them the three refused packages supply every kind.
    for (const kind of [3, 4, 6]) {
      await expect(successor.takeover(`missing-${kind}`, f.signed, encodeEvidencePackage(items.filter(item => item.kind !== kind))))
        .rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    expect((await successor.takeover("complete", f.signed, f.held.package)).sequence).toBe(1n);
    await successor.publish();
    // What the successor serves is complete for a fresh reader.
    expect(decodeEvidencePackage((await successor.package()).package).filter(item => item.kind === 4).length)
      .toBeGreaterThan(items.filter(item => item.kind === 4).length);
  });

  it("uses B's exact term schedule, ending service before the known B-to-C boundary", async () => {
    const f = await transferred(), third = await f.replace(cSecret, f.next.link);
    // A's old end cannot close B's current segment.
    await f.successor.submit(f.spend(f.successorContext));
    await f.successor.commit("before-cutoff"); await f.successor.publish();
    f.venue.advance(third.effective - lag);
    await expect(f.successor.submit(f.issue(f.successorContext, 75))).rejects.toMatchObject({ code: "SCHEDULE" });
    f.venue.advance(third.effective);
    await expect(f.successor.commit("after-force")).rejects.toMatchObject({ code: "STALE" });
  });

  it("refuses an incumbent takeover and signs no adoption receipt when the successor's term ends during verification", async () => {
    const f = await fundedFixture(true);
    await expect(f.a.takeover("same-term", f.signed, f.held.package)).rejects.toMatchObject({ code: "STALE" });
    const next = await f.replace(); f.venue.advance(next.effective);
    const demand = record(demandTask(f.context, f.inputs,
      { backing: f.backing, quantity: 10n, presenter: ed25519.getPublicKey(cSecret), instant: next.effective - lag, deadline: 30n }));
    await f.venue.publishRecord(4, f.backing, encodePublication({ domain, backing: f.backing, kind: 1, record: demand }));
    let duringProof = () => {};
    const successor = f.create(bSecret, "b", () => duringProof());
    await successor.takeover("takeover", f.signed, f.held.package); await successor.publish();
    expect((await f.read(await successor.package())).force.map(event => event.bytes)).toEqual([encodeRecord(demand)]);
    const third = await f.replace(cSecret, next.link);
    duringProof = () => f.venue.advance(third.effective);
    const sign = vi.spyOn(ed25519, "sign");
    try {
      await expect(successor.adopt()).rejects.toMatchObject({ code: "STALE" });
      expect(f.venue.witnessedIndex()).toBe(third.effective);
      expect(sign).not.toHaveBeenCalled();
    } finally { sign.mockRestore(); }
    await expect(successor.adopt()).rejects.toMatchObject({ code: "STALE" });
  });

  it("preserves A's own counter and spent notes when the same journal resumes after A-to-B-to-A", async () => {
    const f = await transferred();
    await f.successor.submit(f.spend(f.successorContext)); await f.successor.commit("spent"); await f.successor.publish();
    const back = await f.replace(aSecret, f.next.link), publicB = await f.successor.package(); f.venue.advance(back.effective);
    const resumed = await f.a.takeover("back-to-a", f.signed, publicB.package);
    expect(resumed.sequence).toBe(3n); expect(resumed.operator).toEqual(aKey);
    await f.a.publish(); await f.a.adopt();
    const ctx = await f.openingContext(f.a);
    expect(ctx.header.entries[0]!.link).toEqual(back.link);
    expect(ctx.header.entries[0]!.opening).toMatchObject({ operator: bKey, sequence: 2n });
    await expect(f.a.submit(f.spend(ctx, 80))).rejects.toMatchObject({ code: "REFUSED", check: "SPENT" });
    await f.a.submit(f.issue(ctx, 75)); await f.a.commit("resumed"); await f.a.publish();
    const result = await f.read(await f.a.package());
    expect(result.state.issued).toBe(20n); expect(result.state.hasNullifier(f.input.note.nf)).toBe(true);
  });

  it("preserves finalized supply across revocation while refusing new issuance at the successor", async () => {
    const f = await fundedFixture();
    await f.venue.publishRecord(3, issuer, encodeRevocation(signRevocation(issuerSecret)));
    const next = await f.replace(); f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b"); await successor.takeover("takeover", f.signed, f.held.package);
    await successor.publish(); await successor.adopt();
    const ctx = await f.openingContext(successor);
    await expect(successor.submit(f.issue(ctx, 75))).rejects.toMatchObject({ code: "REFUSED", check: "REVOKED" });
    await successor.submit(f.spend(ctx)); await successor.commit("spent"); await successor.publish();
    expect((await f.read(await successor.package())).state.issued).toBe(10n);
  });

  it("classifies a fully served invalid predecessor checkpoint and imports the earlier finalized state", async () => {
    const f = await fundedFixture(), next = await f.replace();
    const items = decodeEvidencePackage(f.held.package);
    const snapshot = items.filter(item => item.kind === 4).map(item => decodeSnapshot(item.payload)).find(value => value.issued === 10n)!;
    const invalid = { ...snapshot, issued: 20n }, directory = [{ name: f.backing, digest: snapshotDigest(invalid) }];
    const checkpoint = signCommitment(aSecret, 3n, directoryRoot(directory));
    await f.venue.publishRecord(1, aKey, encodeCommitment(checkpoint));
    const evidence = [...items, { kind: 3, payload: encodeEvidenceDirectory(directory) },
      { kind: 4, payload: snapshotBytes(invalid) }]
      .sort((a, b) => a.kind - b.kind || Buffer.compare(sha256(a.payload), sha256(b.payload)));
    f.venue.advance(next.effective);
    const successor = f.create(bSecret, "b");
    await successor.takeover("takeover", f.signed, encodeEvidencePackage(evidence));
    await successor.publish(); await successor.adopt();
    const result = await f.read(await successor.package());
    expect(result.state.issued).toBe(10n);
    expect(result.carrying).toContainEqual({ operator: bytesToHex(aKey), sequence: "3", index: "4", class: "excluded", check: "SNAPSHOT" });
    expect((await f.openingContext(successor)).header.entries[0]!.opening).toMatchObject({ operator: aKey, sequence: 2n });
  });

  it("detects same-index historical venue mutation during verification before signing an opening", async () => {
    const f = await fundedFixture(), next = await f.replace(); f.venue.advance(next.effective);
    // This creates a new historical predecessor checkpoint without moving the
    // observed clock; clock-only revalidation would miss the changed evidence.
    const extra = encodeCommitment(signCommitment(aSecret, 3n, b(99)));
    let mutated = false;
    const successor = f.create(bSecret, "b", () => {
      if (!mutated) { mutated = true; f.venue.witness(1, aKey, 2n, extra); }
    });
    const sign = vi.spyOn(ed25519, "sign");
    try {
      await expect(successor.takeover("changed-history", f.signed, f.held.package)).rejects.toMatchObject({ code: "STALE" });
      expect(mutated).toBe(true); expect(sign).not.toHaveBeenCalled();
    } finally { sign.mockRestore(); }
  });

  it("replays the exact takeover command across restart and rejects identifier reuse", async () => {
    const f = await transferred();
    expect(await f.successor.takeover("takeover", f.signed, f.held.package)).toEqual(f.opening);
    await expect(f.successor.takeover("takeover", f.signed, encodeEvidencePackage([])))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.successor.commit("takeover")).rejects.toMatchObject({ code: "CONFLICT" });
    const served = await f.successor.package(); f.successor.close();
    const restored = f.create(bSecret, "b");
    expect(await restored.takeover("takeover", f.signed, f.held.package)).toEqual(f.opening);
    expect(await restored.adopt()).toEqual([]); expect(await restored.package()).toEqual(served);
    await expect(restored.submit(f.spend(f.successorContext))).rejects.toMatchObject({ code: "SCHEDULE" });
    f.venue.advance(f.venue.witnessedIndex() + lag);
    await restored.submit(f.spend(f.successorContext)); await restored.commit("after-restart"); await restored.publish();
    expect((await f.read(await restored.package())).state.hasNullifier(f.input.note.nf)).toBe(true);
  });

  it.each(["unwitnessed publication", "silence return"])("serves past the retired reader checkpoint reservation: %s", async action => {
    const f = fixture(action === "silence return"), a = f.create();
    let previous = await a.open("genesis", f.signed); await a.publish();
    const empty = await a.package(); a.close();
    // Genuine sequential signed checkpoints over A's unchanged empty state.
    // Its directory, snapshot and trail stay identical, so the public package
    // changes only its selected commitment. B verifies the complete history.
    for (let sequence = 2; sequence <= 126; sequence++) {
      const next = signCommitment(aSecret, BigInt(sequence), previous.root);
      await f.venue.publishRecord(1, aKey, encodeCommitment(next));
      previous = next;
    }
    const publicA = encodeEvidencePackage(decodeEvidencePackage(empty.package)
      .map(item => item.kind === 2 ? { kind: 2, payload: encodeCommitment(previous) } : item));
    expect(previous.sequence).toBe(126n); expect(f.venue.witnessedIndex()).toBe(126n);
    const replacement = await f.replace(); f.venue.advance(replacement.effective);
    const successor = f.create(bSecret, "b");
    await successor.takeover("takeover", f.signed, publicA); await successor.publish(); await successor.adopt();
    expect(f.venue.export().records.filter(record => record.kind === 1)).toHaveLength(127);
    // Build the issuer's authorization before observing operator signatures.
    const issue = f.issue(await f.openingContext(successor));
    if (action === "unwitnessed publication") {
      expect((await successor.commit("last-reader-checkpoint")).sequence).toBe(2n);
      // A transport reply can precede witnessing. This signed checkpoint still
      // consumes the final reader slot, even during the venue's publication lag.
      const before = f.venue.witnessedIndex(), publish = vi.spyOn(f.venue, "publishRecord").mockResolvedValue(undefined);
      try { expect((await successor.publish()).sequence).toBe(2n); } finally { publish.mockRestore(); }
      expect(f.venue.witnessedIndex()).toBe(before);
    } else {
      f.venue.advance(f.venue.witnessedIndex() + 5n);
    }
    // Readers keep no total over checkpoints (M5b.3b), so the successor signs its next step past the old slot.
    const sign = vi.spyOn(ed25519, "sign");
    try {
      if (action === "unwitnessed publication") expect(await successor.submit(issue)).toBeInstanceOf(Uint8Array);
      else expect((await successor.return("room-for-return")).sequence).toBe(2n);
      expect(sign).toHaveBeenCalled();
    } finally { sign.mockRestore(); }
  }, 90_000);
});
