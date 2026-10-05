import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIT } from "../src/lit/construction.js";
import { litConfigHash } from "../src/lit/configuration.js";
import type { Opening, Output } from "../src/lit/notes.js";
import {
  acceptanceBytes, acceptanceId, encodeRecord, encodeSettlementAuthorization, releaseBytes, statementBytes,
  statementHash, type Demand as LitDemand, type LitRecord, type Statement,
} from "../src/lit/records.js";
import { FIELD_MODULUS } from "../src/pool/field.js";
import { EMPTY_NOTE_ROOT } from "../src/pool/note-tree.js";
import { POOL_V3 } from "../src/pool/v3/construction.js";
import { ReplayRefusal } from "../src/pool/v3/refusals.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { RadixSpentSet } from "../src/pool/v3/spent-set.js";
import {
  applyForceRecord, applyJudged, applyRecord, judgeAdopted, openForceState, openSegmentState, StateHandle, type ForceContext,
  type ProofCheck, type SegmentReplay, type SegmentState,
} from "../src/pool/v3/state.js";
import type { RootTerms } from "../src/pool/v3/terms.js";

// Lit-v1 records (§§2–7) judged by the one state machine (pool/v3/state.ts) through lit's view (src/lit/construction.ts,
// slice 14 M14c). Every derived commitment, nullifier, tag and chain value below is recomputed by an independent
// node:crypto oracle from lit-v1's text; the spent root is pool-spent C1.2.8–9's set, whose contexts lit keeps.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const DOMAIN = litConfigHash(), SEGMENT = b(2), NEXT = b(5), BACKING = b(3), OTHER = b(4);
const secret = (n: number): Uint8Array => b(100 + n), pub = (s: Uint8Array): Uint8Array => ed25519.getPublicKey(s);
const K = secret(0), ALICE = secret(1), BOB = secret(2), CAROL = secret(3), PRESENTER = secret(4), MALLORY = secret(9);
const terms = { obligor: pub(K), operator: b(16) } as unknown as RootTerms;
// A proof verifier lit never asks: any call fails the test.
const NO_PROOF: ProofCheck = { verify: () => { throw new Error("a lit record has no proof"); } };

// --- Oracle -----------------------------------------------------------------------------------------
const H = (...parts: (string | Uint8Array)[]): Uint8Array =>
  new Uint8Array(createHash("sha256").update(Buffer.concat(parts.map(p => (typeof p === "string" ? Buffer.from(p, "ascii") : Buffer.from(p))))).digest());
const u64 = (v: bigint): Uint8Array => { const out = Buffer.alloc(8); out.writeBigUInt64BE(v); return out; };
const u8 = (v: number): Uint8Array => Uint8Array.of(v);
const key = (bytes: Uint8Array): bigint => BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const oracle = {
  cm: (o: Opening): Uint8Array => H("moe/lit/v1/note", DOMAIN, o.backing, u64(o.value), o.owner, o.rho),
  nf: (cm: Uint8Array): Uint8Array => H("moe/lit/v1/nullifier", cm),
  tag: (nf: Uint8Array): Uint8Array => H("moe/lit/v1/tag", nf),
  issueRho: (o: Output, nonce: Uint8Array): Uint8Array => H("moe/lit/v1/rho/issue", o.backing, u64(o.value), o.owner, nonce),
  spendRho: (nfs: Uint8Array[], j: number): Uint8Array => H("moe/lit/v1/rho/spend", u8(nfs.length), ...nfs, u8(j)),
};
const nfOf = (o: Opening): Uint8Array => oracle.nf(oracle.cm(o));

// --- Records ---------------------------------------------------------------------------------------
const sign = (s: Statement, signer: Uint8Array): Uint8Array => ed25519.sign(statementBytes(s), signer);
const record = (statement: Statement, authorization: Uint8Array): Uint8Array => encodeRecord({ statement, authorization } as LitRecord);
let nonces = 0;
function issue(quantity: bigint, owner: Uint8Array, options: { backing?: Uint8Array; segment?: Uint8Array; signer?: Uint8Array; nonce?: Uint8Array } = {}):
  { bytes: Uint8Array; note: Opening; statement: Statement } {
  const statement: Statement = { domain: DOMAIN, kind: 1, segment: options.segment ?? SEGMENT, backing: options.backing ?? BACKING, quantity,
    owner: pub(owner), nonce: options.nonce ?? b(200 + (nonces++ % 50)) };
  const out = { backing: options.backing ?? BACKING, value: quantity, owner: pub(owner) };
  const note = { ...out, rho: oracle.issueRho(out, statement.kind === 1 ? statement.nonce : b(0)) };
  return { bytes: record(statement, sign(statement, options.signer ?? K)), note, statement };
}
const signAll = (s: Statement, signers: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(signers.map(x => sign(s, x))));
/** A spend of `inputs` (owned by `signers`, in order) into `outputs`; its outputs' openings by the oracle. */
function spend(inputs: Opening[], outputs: Output[], signers: Uint8Array[], segment = SEGMENT): { bytes: Uint8Array; notes: Opening[]; statement: Statement } {
  const statement: Statement = { domain: DOMAIN, kind: 2, segment, inputs, outputs };
  const nfs = inputs.map(nfOf);
  return { bytes: record(statement, signAll(statement, signers)), notes: outputs.map((o, j) => ({ ...o, rho: oracle.spendRho(nfs, j) })), statement };
}
function burn(quantity: bigint, inputs: Opening[], outputs: Output[], signers: Uint8Array[]): { bytes: Uint8Array; notes: Opening[] } {
  const statement: Statement = { domain: DOMAIN, kind: 3, segment: SEGMENT, quantity, inputs, outputs };
  const nfs = inputs.map(nfOf);
  return { bytes: record(statement, signAll(statement, signers)), notes: outputs.map((o, j) => ({ ...o, rho: oracle.spendRho(nfs, j) })) };
}
function demand(inputs: Opening[], signers: Uint8Array[], options: { instant?: bigint; deadline?: bigint; presenter?: Uint8Array } = {}):
  { bytes: Uint8Array; statement: LitDemand; id: Uint8Array } {
  const statement: LitDemand = { domain: DOMAIN, kind: 4, segment: SEGMENT, inputs, presenter: pub(options.presenter ?? PRESENTER),
    instant: options.instant ?? 7n, deadline: options.deadline ?? 20n };
  return { bytes: record(statement, signAll(statement, signers)), statement, id: H(statementBytes(statement)) };
}
function withdraw(id: Uint8Array, signer = PRESENTER): Uint8Array {
  const statement: Statement = { domain: DOMAIN, kind: 5, segment: SEGMENT, demand: id };
  return record(statement, sign(statement, signer));
}
function settle(d: { statement: LitDemand; id: Uint8Array }, owner: Uint8Array, options: { deadline?: bigint; acceptor?: Uint8Array; releaser?: Uint8Array } = {}):
  { bytes: Uint8Array; note: Opening } {
  const deadline = options.deadline ?? 15n, statement: Statement = { domain: DOMAIN, kind: 6, segment: SEGMENT, demand: d.id, owner: pub(owner) };
  const acceptance = { domain: DOMAIN, demand: d.id, owner: pub(owner), deadline };
  const authorization = encodeSettlementAuthorization(deadline, ed25519.sign(acceptanceBytes(acceptance), options.acceptor ?? K),
    ed25519.sign(releaseBytes(DOMAIN, d.id, acceptanceId(acceptance), statementHash(statement)), options.releaser ?? PRESENTER));
  const nfs = d.statement.inputs.map(nfOf), value = d.statement.inputs.reduce((sum, input) => sum + input.value, 0n);
  return { bytes: record(statement, authorization), note: { backing: d.statement.inputs[0]!.backing, value, owner: pub(owner), rho: oracle.spendRho(nfs, 0) } };
}

// --- Harness -------------------------------------------------------------------------------------
const fresh = (store = new ReplayStore()): SegmentState => openSegmentState(store, SEGMENT, b(40), undefined, LIT);
const replay = (overrides: Partial<SegmentReplay> = {}): SegmentReplay =>
  ({ domain: DOMAIN, backing: BACKING, segment: SEGMENT, scope: undefined, terms, verifier: NO_PROOF, index: 9n, block: [], ...overrides });
async function refusal(state: SegmentState, bytes: Uint8Array, context = replay()): Promise<string> {
  const before = { position: state.position, history: hex(state.history), evidence: hex(state.evidence) };
  const error = await applyRecord(state, bytes, context).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ReplayRefusal);
  expect({ position: state.position, history: hex(state.history), evidence: hex(state.evidence) }).toEqual(before);
  return (error as ReplayRefusal).check;
}
/** The oracle's chains over a trail of record bytes, each with the nullifiers it spends. */
function chains(segment: Uint8Array, trail: { bytes: Uint8Array; spends: Uint8Array[] }[]): { history: Uint8Array; evidence: Uint8Array } {
  let history = H("moe/lit/v1/genesis", segment), evidence = H("moe/lit/v1/evidence-seed", segment);
  const spent = new RadixSpentSet();
  trail.forEach(({ bytes, spends }, i) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset), length = view.getUint32(0);
    const statement = bytes.subarray(4, 4 + length), authorization = bytes.subarray(8 + length);
    spends.forEach(nf => spent.insert(nf));
    const position = u64(BigInt(i + 1));
    history = H("moe/lit/v1/history", history, H(statement), spent.root(), position);
    evidence = H("moe/lit/v1/evidence-link", evidence, H(statement), H(authorization), position);
  });
  return { history, evidence };
}

describe("lit-v1 records at the one validity seam (M14c)", () => {
  it("issues, pays with change, burns, presents and settles: derived outputs, spent set, totals and both chains", async () => {
    const state = fresh(), context = replay(), name = hex(BACKING);
    const issued = issue(10n, ALICE);
    await applyRecord(state, issued.bytes, context);
    expect(state.hasOutput(key(oracle.cm(issued.note)))).toBe(true);
    const paid = spend([issued.note], [{ backing: BACKING, value: 6n, owner: pub(BOB) }, { backing: BACKING, value: 4n, owner: pub(ALICE) }], [ALICE]);
    await applyRecord(state, paid.bytes, context);
    expect(paid.notes.map(n => state.hasOutput(key(oracle.cm(n))))).toEqual([true, true]);
    expect(state.hasNullifier(key(nfOf(issued.note)))).toBe(true);
    const burned = burn(3n, [paid.notes[1]!], [{ backing: BACKING, value: 1n, owner: pub(ALICE) }], [ALICE]);
    await applyRecord(state, burned.bytes, context);
    expect(state.total(name)).toEqual({ issued: 10n, burned: 3n });
    const presented = demand([paid.notes[0]!], [BOB]);
    await applyRecord(state, presented.bytes, context);
    expect(state.demand(hex(presented.id))).toMatchObject({ backing: BACKING, quantity: 6n, presenter: pub(PRESENTER),
      tags: [key(oracle.tag(nfOf(paid.notes[0]!))), 0n], nullifiers: [key(nfOf(paid.notes[0]!))] });
    const settled = settle(presented, CAROL);
    await applyRecord(state, settled.bytes, context);
    expect(state.demand(hex(presented.id))).toBeUndefined();
    expect(state.hasOutput(key(oracle.cm(settled.note)))).toBe(true);
    expect(state.hasNullifier(key(nfOf(paid.notes[0]!)))).toBe(true);
    expect(state.total(name)).toEqual({ issued: 10n, burned: 3n });
    // §5's chains: the history binds the statement and the spent root; the evidence the statement and authorization.
    const expected = chains(SEGMENT, [
      { bytes: issued.bytes, spends: [] }, { bytes: paid.bytes, spends: [nfOf(issued.note)] },
      { bytes: burned.bytes, spends: [nfOf(paid.notes[1]!)] }, { bytes: presented.bytes, spends: [] },
      { bytes: settled.bytes, spends: [nfOf(paid.notes[0]!)] }]);
    expect([hex(state.history), hex(state.evidence)]).toEqual([hex(expected.history), hex(expected.evidence)]);
    expect(state.at(0n).history).toEqual(H("moe/lit/v1/genesis", SEGMENT));
    // A lit namespace keeps no note tree, anchor or witness; its outputs keep scan order.
    expect([state.noteRoot(), state.hasAnchor(EMPTY_NOTE_ROOT)]).toEqual([EMPTY_NOTE_ROOT, false]);
    expect([...state.store.outputs(state.ns, state.position)].map(o => o.leaf)).toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(() => state.scanOutput([...state.store.outputs(state.ns, state.position)][0]!)).toThrow(TypeError);
  });

  it("stores and reads keys past the pool's field: a lock on a note whose nullifier and tag exceed p holds", async () => {
    const state = fresh(), context = replay();
    let found: { bytes: Uint8Array; note: Opening } | undefined;
    for (let n = 0; found === undefined; n++) {
      const candidate = issue(5n, ALICE, { nonce: H("nonce", u64(BigInt(n))) });
      if (key(nfOf(candidate.note)) >= FIELD_MODULUS && key(oracle.tag(nfOf(candidate.note))) >= FIELD_MODULUS) found = candidate;
    }
    await applyRecord(state, found.bytes, context);
    await applyRecord(state, demand([found.note], [ALICE]).bytes, context);
    // The note under a standing demand's lock moves by no spend (C3.7, lit-v1 §7 Spend).
    expect(await refusal(state, spend([found.note], [{ backing: BACKING, value: 5n, owner: pub(BOB) }], [ALICE]).bytes, context)).toBe("LOCKED");
    expect(state.demands()[0]![1].nullifiers).toEqual([key(nfOf(found.note))]);
  });

  it("refuses by name: context, kind, scope, inputs, arithmetic, signatures, supply and uniqueness", async () => {
    const context = replay();
    const state = fresh();
    const a = issue(10n, ALICE), other = issue(10n, ALICE, { backing: OTHER });
    await applyRecord(state, a.bytes, context);
    const pay = (inputs: Opening[], outputs: Output[], signers = [ALICE]): Uint8Array => spend(inputs, outputs, signers).bytes;
    const to = (value: bigint, owner = BOB, backing = BACKING): Output => ({ backing, value, owner: pub(owner) });
    // Context: another segment or domain.
    expect(await refusal(state, spend([a.note], [to(10n)], [ALICE], NEXT).bytes, context)).toBe("CONTEXT");
    expect(await refusal(state, a.bytes, replay({ domain: b(1) }))).toBe("CONTEXT");
    // A request is never a history event (§7).
    const request: Statement = { domain: DOMAIN, kind: 7, input: a.note, refresh: 1n };
    expect(await refusal(state, record(request, sign(request, ALICE)), context)).toBe("KIND");
    // Every backing named or derived is scoped (§7 Common): an unscoped issue and a two-backing spend.
    expect(await refusal(state, other.bytes, context)).toBe("BACKING");
    expect(await refusal(state, pay([a.note, other.note], [to(10n), to(10n, BOB, OTHER)], [ALICE, ALICE]), context)).toBe("BACKING");
    // Inputs are outputs of the state (lit's anchors): a note never created.
    const ghost = { ...a.note, rho: b(77) };
    expect(await refusal(state, pay([ghost], [to(10n)]), context)).toBe("INPUT");
    expect(await refusal(state, demand([ghost], [ALICE]).bytes, context)).toBe("INPUT");
    // The statement's own arithmetic (§6), before its signatures.
    expect(await refusal(state, pay([a.note, a.note], [to(20n)], [ALICE, ALICE]), context)).toBe("ARITHMETIC");
    expect(await refusal(state, pay([a.note], [to(9n)]), context)).toBe("ARITHMETIC");
    expect(await refusal(state, pay([a.note], [to(10n, BOB, OTHER)], [MALLORY]), context)).toBe("ARITHMETIC");
    expect(await refusal(state, burn(11n, [a.note], [], [ALICE]).bytes, context)).toBe("ARITHMETIC");
    // Owner, K and the issuance supply bound.
    expect(await refusal(state, pay([a.note], [to(10n)], [MALLORY]), context)).toBe("SIGNATURE");
    expect(await refusal(state, issue(1n, ALICE, { signer: MALLORY }).bytes, context)).toBe("SIGNATURE");
    expect(await refusal(state, issue((1n << 64n) - 10n, ALICE).bytes, context)).toBe("SUPPLY");
    // Uniqueness: an exact statement again; an issuance K signs again for the same segment.
    expect(await refusal(state, a.bytes, context)).toBe("REPEATED_STATEMENT");
    await applyRecord(state, pay([a.note], [to(10n)]), context);
    expect(await refusal(state, pay([a.note], [to(10n, CAROL)]), context)).toBe("SPENT");
  });

  it("refuses mixed backings and a sum past a u64 in a burn or demand as arithmetic, under a two-backing scope", async () => {
    const scoped = replay({ scopedTerms: new Map([[hex(BACKING), terms], [hex(OTHER), terms]]) });
    const state = fresh(), a = issue(10n, ALICE), c = issue(10n, ALICE, { backing: OTHER });
    await applyRecord(state, a.bytes, scoped); await applyRecord(state, c.bytes, scoped);
    expect(await refusal(state, burn(20n, [a.note, c.note], [], [ALICE, ALICE]).bytes, scoped)).toBe("ARITHMETIC");
    expect(await refusal(state, demand([a.note, c.note], [ALICE, ALICE]).bytes, scoped)).toBe("ARITHMETIC");
    const big = { ...a.note, value: (1n << 63n) + 1n };
    expect(await refusal(state, demand([big, { ...big, rho: b(9) }], [ALICE, ALICE]).bytes, scoped)).toBe("ARITHMETIC");
    // A spend across both scoped backings balances per backing.
    await applyRecord(state, spend([a.note, c.note], [
      { backing: BACKING, value: 10n, owner: pub(BOB) }, { backing: OTHER, value: 10n, owner: pub(BOB) }], [ALICE, ALICE]).bytes, scoped);
    expect(state.position).toBe(3n);
  });

  it("refuses an issuance signed again for a successor segment: its output is the first one's (§2)", async () => {
    const store = new ReplayStore(), first = fresh(store), context = replay(), nonce = b(250);
    await applyRecord(first, issue(4n, ALICE, { nonce }).bytes, context);
    const next = openSegmentState(store, NEXT, b(41), first, LIT);
    expect(await refusal(next, issue(4n, ALICE, { nonce, segment: NEXT }).bytes, replay({ segment: NEXT }))).toBe("OUTPUT");
    // The successor imports only its own construction.
    expect(() => openSegmentState(store, NEXT, b(42), first, POOL_V3)).toThrow(TypeError);
    expect(() => new StateHandle(store, first.ns)).toThrow(TypeError);
  });

  it("holds demands, withdrawals and settlements to C3.7: locks, the spent tag, presenter, K, deadlines and the door", async () => {
    const state = fresh(), context = replay();
    const a = issue(10n, ALICE), c = issue(3n, BOB);
    await applyRecord(state, a.bytes, context); await applyRecord(state, c.bytes, context);
    const d = demand([a.note], [ALICE]);
    expect(await refusal(state, settle(d, CAROL).bytes, context)).toBe("DEMAND");
    expect(await refusal(state, withdraw(d.id), context)).toBe("DEMAND");
    expect(await refusal(state, demand([a.note], [MALLORY]).bytes, context)).toBe("SIGNATURE");
    await applyRecord(state, d.bytes, context);
    // A second demand on the locked note, and a withdrawal the presenter did not sign.
    expect(await refusal(state, demand([a.note], [ALICE], { deadline: 21n }).bytes, context)).toBe("LOCKED");
    expect(await refusal(state, withdraw(d.id, MALLORY), context)).toBe("SIGNATURE");
    // Settlement: K's acceptance, the presenter's release, the acceptance deadline within the demand's.
    expect(await refusal(state, settle(d, CAROL, { acceptor: MALLORY }).bytes, context)).toBe("SIGNATURE");
    expect(await refusal(state, settle(d, CAROL, { releaser: MALLORY }).bytes, context)).toBe("SIGNATURE");
    expect(await refusal(state, settle(d, CAROL, { deadline: 21n }).bytes, context)).toBe("DEADLINE");
    await applyRecord(state, withdraw(d.id), context);
    // Withdrawn, the note moves again; a demand on the spent note is refused by its spent tag.
    const paid = spend([a.note], [{ backing: BACKING, value: 10n, owner: pub(BOB) }], [ALICE]);
    await applyRecord(state, paid.bytes, context);
    expect(await refusal(state, demand([a.note], [ALICE], { deadline: 22n }).bytes, context)).toBe("LOCKED");
    // At the door (admission at the horizon), the instant lies within [at − 2·lag, at − lag] and the deadline after.
    const door = replay({ admission: true, lag: 2n, index: 9n });
    expect(await refusal(state, demand([c.note], [BOB], { instant: 8n }).bytes, door)).toBe("DEADLINE");
    await applyRecord(state, demand([c.note], [BOB], { instant: 6n }).bytes, door);
  });

  it("adopts an exact settlement, deriving its output from the stored demand, and refuses one whose demand does not stand", async () => {
    const state = fresh(), context = replay(), a = issue(10n, ALICE);
    await applyRecord(state, a.bytes, context);
    const d = demand([a.note], [ALICE]), settled = settle(d, CAROL);
    await applyRecord(state, d.bytes, context);
    const adoption = replay({ block: [undefined, undefined, { bytes: settled.bytes, index: 11n }] as never });
    const judged = judgeAdopted<LitRecord>(state, settled.bytes, adoption);
    expect(judged.view.outputs).toEqual([key(oracle.cm(settled.note))]);
    applyJudged(state, judged, adoption);
    expect(state.hasOutput(key(oracle.cm(settled.note)))).toBe(true);
    const other = fresh(), lone = settle(demand([a.note], [ALICE], { deadline: 30n }), CAROL);
    await applyRecord(other, a.bytes, context);
    expect(() => judgeAdopted(other, lone.bytes, replay({ block: [undefined, { bytes: lone.bytes, index: 11n }] as never })))
      .toThrow(expect.objectContaining({ check: "DEMAND" }));
  });

  it("forces demands and settlements over the snapshot's state: inputs are the snapshot's outputs, never ones forced since", async () => {
    const source = fresh(), context = replay(), a = issue(10n, ALICE);
    await applyRecord(source, a.bytes, context);
    const force = (extra: Partial<ForceContext> = {}): ForceContext =>
      ({ mode: "force", domain: DOMAIN, segment: SEGMENT, backing: BACKING, scope: undefined, issuer: pub(K), index: 9n, lag: 2n, verifier: NO_PROOF, ...extra });
    const state = openForceState(source), d = demand([a.note], [ALICE]), settled = settle(d, CAROL);
    await applyForceRecord(state, d.bytes, force(), LIT);
    await applyForceRecord(state, settled.bytes, force(), LIT);
    expect(state.outputs.has(key(oracle.cm(settled.note)))).toBe(true);
    expect(state.nullifiers.has(key(nfOf(a.note)))).toBe(true);
    // The forced settlement's output is no input of the snapshot's state (lit-v1 §7's last paragraph).
    await expect(applyForceRecord(state, demand([settled.note], [CAROL]).bytes, force(), LIT)).rejects.toMatchObject({ check: "INPUT" });
    await expect(applyForceRecord(state, demand([a.note], [ALICE], { deadline: 25n }).bytes, force(), LIT)).rejects.toMatchObject({ check: "LOCKED" });
    await expect(applyForceRecord(openForceState(source), d.bytes, force({ backing: OTHER }), LIT)).rejects.toMatchObject({ check: "BACKING" });
    await expect(applyForceRecord(openForceState(source), d.bytes, force({ segment: NEXT }), LIT)).rejects.toMatchObject({ check: "CONTEXT" });
    await expect(applyForceRecord(openForceState(source), settled.bytes, force(), LIT)).rejects.toMatchObject({ check: "DEMAND" });
  });
  it("refuses a second settlement, an exact settlement again, swapped owner signatures, an imported lock and a scope root (review)", async () => {
    const store = new ReplayStore(), state = fresh(store), context = replay();
    const a = issue(10n, ALICE), c = issue(4n, BOB);
    await applyRecord(state, a.bytes, context); await applyRecord(state, c.bytes, context);
    // Two inputs signed in the wrong order: each signature is checked under its own input's owner.
    const both = spend([a.note, c.note], [{ backing: BACKING, value: 14n, owner: pub(CAROL) }], [BOB, ALICE]);
    expect(await refusal(state, both.bytes, context)).toBe("SIGNATURE");
    expect(await refusal(state, issue(1n, ALICE).bytes, replay({ scope: 77n }))).toBe("SCOPE");
    const d = demand([a.note], [ALICE]), first = settle(d, CAROL);
    await applyRecord(state, d.bytes, context);
    // A demand standing in the predecessor locks its note in the successor, and settles there.
    const next = openSegmentState(store, NEXT, b(41), state, LIT), nextContext = replay({ segment: NEXT });
    const moved = spend([a.note], [{ backing: BACKING, value: 10n, owner: pub(BOB) }], [ALICE], NEXT);
    expect(await refusal(next, moved.bytes, nextContext)).toBe("LOCKED");
    await applyRecord(state, first.bytes, context);
    // The demand ends once: an exact settlement again and one to another owner both find no standing demand.
    expect(await refusal(state, first.bytes, context)).toBe("DEMAND");
    expect(await refusal(state, settle(d, BOB).bytes, context)).toBe("DEMAND");
  });

  it("forces only recovery kinds, by the presenter and before the acceptance deadline, leaving a refused overlay as it was", async () => {
    const source = fresh(), context = replay(), a = issue(10n, ALICE);
    await applyRecord(source, a.bytes, context);
    const force = (extra: Partial<ForceContext> = {}): ForceContext =>
      ({ mode: "force", domain: DOMAIN, segment: SEGMENT, backing: BACKING, scope: undefined, issuer: pub(K), index: 9n, lag: 2n, verifier: NO_PROOF, ...extra });
    const state = openForceState(source), d = demand([a.note], [ALICE]);
    await applyForceRecord(state, d.bytes, force(), LIT);
    const overlay = (): unknown => [[...state.nullifiers], [...state.outputs], [...state.added.keys()], [...state.ended], [...state.effective], [...state.spentTags]];
    const before = overlay();
    await expect(applyForceRecord(state, spend([a.note], [{ backing: BACKING, value: 10n, owner: pub(BOB) }], [ALICE]).bytes, force(), LIT))
      .rejects.toMatchObject({ status: "unsupported-scope" });
    await expect(applyForceRecord(state, withdraw(d.id, MALLORY), force(), LIT)).rejects.toMatchObject({ check: "SIGNATURE" });
    await expect(applyForceRecord(state, settle(d, CAROL, { deadline: 8n }).bytes, force(), LIT)).rejects.toMatchObject({ check: "DEADLINE" });
    expect(overlay()).toEqual(before);
    await applyForceRecord(state, withdraw(d.id), force(), LIT);
    expect(state.demand(hex(d.id))).toBeUndefined();
  });
});

