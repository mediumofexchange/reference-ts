import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIT } from "../src/lit/construction.js";
import { litConfigHash } from "../src/lit/configuration.js";
import type { Opening, Output } from "../src/lit/notes.js";
import {
  acceptanceBytes, acceptanceId, encodeRecord, encodeSettlementAuthorization, releaseBytes, statementBytes,
  statementHash, type Demand as LitDemand, type LitRecord, type Statement,
} from "../src/lit/records.js";
import { FIELD_MODULUS } from "../src/pool/field.js";
import { ReplayRefusal } from "../src/pool/v3/refusals.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { RadixSpentSet } from "../src/pool/v3/spent-set.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentReplay, type SegmentState } from "../src/pool/v3/state.js";
import type { RootTerms } from "../src/pool/v3/terms.js";

// Language-neutral replay vectors for lit-v1 §7 (conformance/README.md): sequences of records judged one by one against
// one segment's state, each admitted with the state after it or refused with the rule it breaks. The reference judges
// every step below and must reach the verdict written beside it; chains, spent roots, outputs and supply are recomputed
// by a node:crypto oracle from lit-v1's text (the spent root by pool-spent's set, vectored with pool-v3). The records'
// bytes come from the codec that test/lit-records.test.ts holds to its own oracle. CONFORMANCE_VECTORS=write rewrites
// conformance/lit-v1-replay.json.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const DOMAIN = litConfigHash(), SEGMENT = b(2), NEXT = b(5), BACKING = b(3), OTHER = b(4);
const secret = (n: number): Uint8Array => b(100 + n), pub = (s: Uint8Array): Uint8Array => ed25519.getPublicKey(s);
const K = secret(0), ALICE = secret(1), BOB = secret(2), CAROL = secret(3), PRESENTER = secret(4), MALLORY = secret(9);
const PARTIES = { K, ALICE, BOB, CAROL, PRESENTER, MALLORY };
const INDEX = 9n;
const NO_PROOF: ProofCheck = { verify: () => { throw new Error("a lit record has no proof"); } };

// --- Oracle -----------------------------------------------------------------------------------------
const H = (...parts: (string | Uint8Array)[]): Uint8Array =>
  new Uint8Array(createHash("sha256").update(Buffer.concat(parts.map(p => (typeof p === "string" ? Buffer.from(p, "ascii") : Buffer.from(p))))).digest());
const u64 = (v: bigint): Uint8Array => { const out = Buffer.alloc(8); out.writeBigUInt64BE(v); return out; };
const u8 = (v: number): Uint8Array => Uint8Array.of(v);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const key = (bytes: Uint8Array): bigint => BigInt(`0x${hex(bytes)}`);
const cmOf = (o: Opening): Uint8Array => H("moe/lit/v1/note", DOMAIN, o.backing, u64(o.value), o.owner, o.rho);
const nfOf = (o: Opening): Uint8Array => H("moe/lit/v1/nullifier", cmOf(o));
const issueRho = (o: Output, nonce: Uint8Array): Uint8Array => H("moe/lit/v1/rho/issue", o.backing, u64(o.value), o.owner, nonce);
const spendRho = (nfs: Uint8Array[], j: number): Uint8Array => H("moe/lit/v1/rho/spend", u8(nfs.length), ...nfs, u8(j));

// --- Records: each carries what the oracle needs to follow an admitted step ---------------------------
interface Built { bytes: Uint8Array; spends: Uint8Array[]; creates: Opening[]; issued?: [Uint8Array, bigint]; burned?: [Uint8Array, bigint] }
const sign = (s: Statement, signer: Uint8Array): Uint8Array => ed25519.sign(statementBytes(s), signer);
const signAll = (s: Statement, signers: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(signers.map(x => sign(s, x))));
const record = (statement: Statement, authorization: Uint8Array): Uint8Array => encodeRecord({ statement, authorization } as LitRecord);
const to = (value: bigint, owner: Uint8Array, backing = BACKING): Output => ({ backing, value, owner: pub(owner) });
let nonces = 0;
function issue(quantity: bigint, owner: Uint8Array, options: { backing?: Uint8Array; signer?: Uint8Array; nonce?: Uint8Array; domain?: Uint8Array } = {}):
  Built & { note: Opening } {
  const backing = options.backing ?? BACKING, nonce = options.nonce ?? b(200 + (nonces++ % 50));
  const statement: Statement = { domain: options.domain ?? DOMAIN, kind: 1, segment: SEGMENT, backing, quantity, owner: pub(owner), nonce };
  const out = to(quantity, owner, backing), note = { ...out, rho: issueRho(out, nonce) };
  return { bytes: record(statement, sign(statement, options.signer ?? K)), spends: [], creates: [note], issued: [backing, quantity], note };
}
function spend(inputs: Opening[], outputs: Output[], signers: Uint8Array[], segment = SEGMENT): Built & { notes: Opening[] } {
  const statement: Statement = { domain: DOMAIN, kind: 2, segment, inputs, outputs }, nfs = inputs.map(nfOf);
  const notes = outputs.map((o, j) => ({ ...o, rho: spendRho(nfs, j) }));
  return { bytes: record(statement, signAll(statement, signers)), spends: nfs, creates: notes, notes };
}
function burn(quantity: bigint, inputs: Opening[], outputs: Output[], signers: Uint8Array[]): Built & { notes: Opening[] } {
  const statement: Statement = { domain: DOMAIN, kind: 3, segment: SEGMENT, quantity, inputs, outputs }, nfs = inputs.map(nfOf);
  const notes = outputs.map((o, j) => ({ ...o, rho: spendRho(nfs, j) }));
  return { bytes: record(statement, signAll(statement, signers)), spends: nfs, creates: notes, burned: [inputs[0]!.backing, quantity], notes };
}
function demand(inputs: Opening[], signers: Uint8Array[], options: { deadline?: bigint } = {}): Built & { statement: LitDemand; id: Uint8Array } {
  const statement: LitDemand = { domain: DOMAIN, kind: 4, segment: SEGMENT, inputs, presenter: pub(PRESENTER), instant: 7n, deadline: options.deadline ?? 20n };
  return { bytes: record(statement, signAll(statement, signers)), spends: [], creates: [], statement, id: H(statementBytes(statement)) };
}
function withdraw(id: Uint8Array, signer = PRESENTER): Built {
  const statement: Statement = { domain: DOMAIN, kind: 5, segment: SEGMENT, demand: id };
  return { bytes: record(statement, sign(statement, signer)), spends: [], creates: [] };
}
function settle(d: { statement: LitDemand; id: Uint8Array }, owner: Uint8Array,
  options: { deadline?: bigint; acceptor?: Uint8Array; ownerSigner?: Uint8Array; releaser?: Uint8Array } = {}): Built & { note: Opening } {
  const deadline = options.deadline ?? 15n, statement: Statement = { domain: DOMAIN, kind: 6, segment: SEGMENT, demand: d.id, owner: pub(owner) };
  const acceptance = { domain: DOMAIN, demand: d.id, owner: pub(owner), deadline };
  const authorization = encodeSettlementAuthorization(deadline, ed25519.sign(acceptanceBytes(acceptance), options.acceptor ?? K),
    ed25519.sign(acceptanceBytes(acceptance), options.ownerSigner ?? owner),
    ed25519.sign(releaseBytes(DOMAIN, d.id, acceptanceId(acceptance), statementHash(statement)), options.releaser ?? PRESENTER));
  const nfs = d.statement.inputs.map(nfOf), value = d.statement.inputs.reduce((sum, input) => sum + input.value, 0n);
  const note = { backing: d.statement.inputs[0]!.backing, value, owner: pub(owner), rho: spendRho(nfs, 0) };
  return { bytes: record(statement, authorization), spends: nfs, creates: [note], note };
}
function request(input: Opening, signer: Uint8Array): Built {
  const statement: Statement = { domain: DOMAIN, kind: 7, input, refresh: 1n };
  return { bytes: record(statement, sign(statement, signer)), spends: [], creates: [] };
}

// --- Sequences --------------------------------------------------------------------------------------
type Step =
  | { description: string; record: string; verdict: "admitted"; after: Record<string, unknown> }
  | { description: string; record: string; verdict: "refused"; rule: string; intrinsic: boolean; reference: string };

/** One segment judged from empty: the reference applies each step, the oracle follows each admitted one. */
class Sequence {
  readonly steps: Step[] = [];
  private readonly state: SegmentState = openSegmentState(new ReplayStore(), SEGMENT, b(40), undefined, LIT);
  private readonly context: SegmentReplay;
  private history = H("moe/lit/v1/genesis", SEGMENT);
  private evidence = H("moe/lit/v1/evidence-seed", SEGMENT);
  private readonly spent = new RadixSpentSet();
  private readonly supply = new Map<string, { issued: bigint; burned: bigint }>();
  constructor(readonly name: string, readonly scope: Uint8Array[] = [BACKING]) {
    const terms = { obligor: pub(K), operator: b(16) } as unknown as RootTerms;
    for (const backing of scope) this.supply.set(hex(backing), { issued: 0n, burned: 0n });
    this.context = { domain: DOMAIN, backing: scope[0]!, segment: SEGMENT, scope: undefined, terms, verifier: NO_PROOF, index: INDEX, block: [],
      ...(scope.length > 1 ? { scopedTerms: new Map(scope.map(s => [hex(s), terms])) } : {}) };
  }
  async admit(description: string, built: Built): Promise<void> {
    await applyRecord(this.state, built.bytes, this.context);
    const position = this.state.position, length = new DataView(built.bytes.buffer, built.bytes.byteOffset).getUint32(0);
    const statement = built.bytes.subarray(4, 4 + length), authorization = built.bytes.subarray(8 + length);
    for (const nf of built.spends) this.spent.insert(nf);
    this.history = H("moe/lit/v1/history", this.history, H(statement), this.spent.root(), u64(position));
    this.evidence = H("moe/lit/v1/evidence-link", this.evidence, H(statement), H(authorization), u64(position));
    if (built.issued !== undefined) this.supply.get(hex(built.issued[0]))!.issued += built.issued[1];
    if (built.burned !== undefined) this.supply.get(hex(built.burned[0]))!.burned += built.burned[1];
    expect([hex(this.state.history), hex(this.state.evidence)]).toEqual([hex(this.history), hex(this.evidence)]);
    for (const [backing, totals] of this.supply) expect(this.state.total(backing)).toEqual(totals);
    for (const note of built.creates) expect(this.state.hasOutput(key(cmOf(note)))).toBe(true);
    for (const nf of built.spends) expect(this.state.hasNullifier(key(nf))).toBe(true);
    this.steps.push({ description, record: hex(built.bytes), verdict: "admitted", after: {
      position: `${position}`, historyHash: hex(this.history), evidenceHash: hex(this.evidence), spentRoot: hex(this.spent.root()),
      outputs: built.creates.map(n => hex(cmOf(n))), nullifiers: built.spends.map(hex),
      supply: Object.fromEntries([...this.supply].map(([backing, t]) => [backing, { issued: `${t.issued}`, burned: `${t.burned}` }])) } });
  }
  async refuse(description: string, built: Built, reference: string, rule: string, intrinsic = false): Promise<void> {
    const before = [this.state.position, hex(this.state.history), hex(this.state.evidence)];
    const error = await applyRecord(this.state, built.bytes, this.context).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(ReplayRefusal);
    expect((error as ReplayRefusal).check).toBe(reference);
    expect([this.state.position, hex(this.state.history), hex(this.state.evidence)]).toEqual(before);
    this.steps.push({ description, record: hex(built.bytes), verdict: "refused", rule, intrinsic, reference });
  }
  toJSON(): unknown {
    return { name: this.name, context: { segment: hex(SEGMENT), scope: this.scope.map(hex), index: `${INDEX}` }, steps: this.steps };
  }
}

async function sequences(): Promise<Sequence[]> {
  nonces = 0;
  const all: Sequence[] = [];

  // A note's whole life: issued, paid with change, burned in part, presented and settled.
  {
    const s = new Sequence("issue, pay with change, burn, present and settle"); all.push(s);
    const a = issue(10n, ALICE);
    await s.admit("K issues 10 to Alice", a);
    const paid = spend([a.note], [to(6n, BOB), to(4n, ALICE)], [ALICE]);
    await s.admit("Alice pays Bob 6 with 4 change", paid);
    await s.admit("Alice burns 3 of her change, keeping 1", burn(3n, [paid.notes[1]!], [to(1n, ALICE)], [ALICE]));
    const d = demand([paid.notes[0]!], [BOB]);
    await s.admit("Bob presents his 6", d);
    await s.admit("K settles Bob's demand to Carol", settle(d, CAROL));
  }

  // One issued note and every refusal of a record that names it or K, then a spend and the same note spent again.
  {
    const s = new Sequence("refusals around one issued note"); all.push(s);
    const a = issue(10n, ALICE), other = issue(10n, ALICE, { backing: OTHER });
    await s.admit("K issues 10 to Alice", a);
    await s.refuse("a spend naming another segment", spend([a.note], [to(10n, BOB)], [ALICE], NEXT), "CONTEXT",
      "lit-v1 §7 Common: the segment is this one");
    await s.refuse("an issue under another configuration's domain", issue(1n, ALICE, { domain: b(1) }), "CONTEXT",
      "lit-v1 §7 Common: the domain is the configuration's");
    await s.refuse("a request in the history", request(a.note, ALICE), "KIND", "lit-v1 §7 Request: never admitted");
    await s.refuse("an issue of a backing outside the scope", other, "BACKING",
      "lit-v1 §7 Common: every backing named or derived is in the segment's scope");
    await s.refuse("a spend of a note never created", spend([{ ...a.note, rho: b(77) }], [to(10n, BOB)], [ALICE]), "INPUT",
      "lit-v1 §7 Spend: every input is live (Common: its cm is in the output set)");
    await s.refuse("a demand on a note never created", demand([{ ...a.note, rho: b(77) }], [ALICE]), "INPUT",
      "lit-v1 §7 Demand: every input is live (Common: its cm is in the output set)");
    await s.refuse("a spend of one note twice in one statement", spend([a.note, a.note], [to(20n, BOB)], [ALICE, ALICE]), "ARITHMETIC",
      "lit-v1 §7 Common: the inputs' nullifiers are distinct", true);
    await s.refuse("a spend whose outputs sum below its inputs", spend([a.note], [to(9n, BOB)], [ALICE]), "ARITHMETIC",
      "lit-v1 §7 Spend: per input backing, the inputs' widened sum equals the outputs'", true);
    await s.refuse("a spend whose outputs sum above its inputs", spend([a.note], [to(11n, BOB)], [ALICE]), "ARITHMETIC",
      "lit-v1 §7 Spend: per input backing, the inputs' widened sum equals the outputs'", true);
    await s.refuse("a burn destroying more than the quantity it reports", burn(3n, [a.note], [], [ALICE]), "ARITHMETIC",
      "lit-v1 §7 Burn: the inputs' sum equals quantity plus the output's value", true);
    await s.refuse("a burn of 4 from 10 with 7 change", burn(4n, [a.note], [to(7n, ALICE)], [ALICE]), "ARITHMETIC",
      "lit-v1 §7 Burn: the inputs' sum equals quantity plus the output's value", true);
    await s.refuse("a spend Mallory signs for Alice's note", spend([a.note], [to(10n, BOB)], [MALLORY]), "SIGNATURE",
      "lit-v1 §7 Spend: owner signatures verify", true);
    await s.refuse("an issue Mallory signs in K's place", issue(1n, ALICE, { signer: MALLORY }), "SIGNATURE",
      "lit-v1 §7 Issue: K's signature verifies over statementBytes", true);
    await s.refuse("an issue taking the backing's issued total to 2^64", issue((1n << 64n) - 10n, ALICE), "SUPPLY",
      "lit-v1 §7 Issue: issued(backing) + quantity < 2^64");
    await s.refuse("the first issue again, byte for byte", a, "REPEATED_STATEMENT",
      "lit-v1 §7 Common: each derived output's cm is absent from the output set (at admission, an exact resubmission returns the original receipt instead)");
    await s.admit("Alice pays Bob 10", spend([a.note], [to(10n, BOB)], [ALICE]));
    await s.refuse("Alice's spent note paid again, to Carol", spend([a.note], [to(10n, CAROL)], [ALICE]), "SPENT",
      "lit-v1 §7 Spend: every input is live (Common: its nf is not in the spent set)");
  }

  // C3.7's lock, release and settlement as lit-v1 §7 reads them.
  {
    const s = new Sequence("demand, withdrawal and settlement"); all.push(s);
    const a = issue(10n, ALICE);
    await s.admit("K issues 10 to Alice", a);
    const d = demand([a.note], [ALICE]);
    await s.refuse("a settlement of a demand never made", settle(d, CAROL), "DEMAND", "lit-v1 §7 Settle: the demand stands");
    await s.refuse("a withdrawal of a demand never made", withdraw(d.id), "DEMAND", "lit-v1 §7 Withdraw: C3.7, the demand stands");
    await s.refuse("a demand Mallory signs for Alice's note", demand([a.note], [MALLORY]), "SIGNATURE",
      "lit-v1 §7 Demand: owner signatures verify", true);
    await s.admit("the presenter demands Alice's 10", d);
    await s.refuse("a second demand on the locked note", demand([a.note], [ALICE], { deadline: 21n }), "LOCKED",
      "lit-v1 §7 Demand: every input's tag is under no standing lock");
    await s.refuse("a spend of the locked note", spend([a.note], [to(10n, BOB)], [ALICE]), "LOCKED",
      "lit-v1 §7 Spend: every input's tag is under no standing lock (C3.7)");
    await s.refuse("a withdrawal Mallory signs", withdraw(d.id, MALLORY), "SIGNATURE",
      "lit-v1 §7 Withdraw: the presenter's signature is over the withdraw statement's bytes");
    await s.refuse("a settlement whose acceptance Mallory signs in K's place", settle(d, CAROL, { acceptor: MALLORY }), "SIGNATURE",
      "lit-v1 §7 Settle: the acceptance verifies under K");
    await s.refuse("a settlement to Carol whose owner signature is K's", settle(d, CAROL, { ownerSigner: K }), "SIGNATURE",
      "lit-v1 §7 Settle: the acceptance verifies under this owner");
    await s.refuse("a settlement back to Alice, the holder, without her owner signature", settle(d, ALICE, { ownerSigner: K }), "SIGNATURE",
      "lit-v1 §7 Settle: the acceptance verifies under this owner");
    await s.refuse("a settlement to the presenter's key signed by Mallory", settle(d, PRESENTER, { ownerSigner: MALLORY }), "SIGNATURE",
      "lit-v1 §7 Settle: the acceptance verifies under this owner");
    await s.refuse("a settlement whose release Mallory signs", settle(d, CAROL, { releaser: MALLORY }), "SIGNATURE",
      "lit-v1 §7 Settle: the release verifies under the presenter key");
    await s.refuse("a settlement whose acceptance deadline passes the demand's", settle(d, CAROL, { deadline: 21n }), "DEADLINE",
      "pool-recovery C3.4, read by lit-v1 §7 Settle: an acceptance's deadline is at or before the demand's");
    await s.admit("the presenter withdraws the demand", withdraw(d.id));
    const paid = spend([a.note], [to(10n, BOB)], [ALICE]);
    await s.admit("Alice, released, pays Bob 10", paid);
    await s.refuse("a demand on the spent note", demand([a.note], [ALICE], { deadline: 22n }), "LOCKED",
      "lit-v1 §7 Demand: every input is live, its tag neither locked nor spent");
  }

  // A demand ends once; signatures bind each input's own owner.
  {
    const s = new Sequence("one settlement per demand"); all.push(s);
    const a = issue(10n, ALICE), c = issue(4n, BOB);
    await s.admit("K issues 10 to Alice", a);
    await s.admit("K issues 4 to Bob", c);
    await s.refuse("a two-input spend signed in the wrong order", spend([a.note, c.note], [to(14n, CAROL)], [BOB, ALICE]), "SIGNATURE",
      "lit-v1 §7 Spend: owner signatures verify, each under its own input's owner", true);
    const d = demand([a.note], [ALICE]), first = settle(d, CAROL);
    await s.admit("the presenter demands Alice's 10", d);
    await s.admit("K settles the demand to Carol", first);
    await s.refuse("the same settlement again", first, "DEMAND",
      "lit-v1 §7 Settle: the demand stands (at admission, an exact resubmission returns the original receipt instead)");
    await s.refuse("a settlement of the settled demand to Bob", settle(d, BOB), "DEMAND", "lit-v1 §7 Settle: the demand stands");
  }

  // A scope of two backings: sums are per backing and widened.
  {
    const s = new Sequence("a two-backing scope", [BACKING, OTHER]); all.push(s);
    const a = issue(10n, ALICE), c = issue(10n, ALICE, { backing: OTHER });
    await s.admit("K issues 10 of the first backing to Alice", a);
    await s.admit("K issues 10 of the second backing to Alice", c);
    await s.refuse("a burn over both backings", burn(20n, [a.note, c.note], [], [ALICE, ALICE]), "ARITHMETIC",
      "lit-v1 §7 Burn: one input backing", true);
    await s.refuse("a demand over both backings", demand([a.note, c.note], [ALICE, ALICE]), "ARITHMETIC",
      "lit-v1 §7 Demand: the inputs share one backing", true);
    const big = { ...a.note, value: (1n << 63n) + 1n };
    // No two live notes of one backing can sum past a u64 (issued < 2^64), so these inputs are not live either: the case
    // fixes the failure's intrinsic class (lit-v1 §6), which compact exclusion reads without state.
    await s.refuse("a demand whose inputs sum past a u64 (inputs not live either; this fixes the intrinsic class)", demand([big, { ...big, rho: b(9) }], [ALICE, ALICE]), "ARITHMETIC",
      "lit-v1 §7 Demand: the inputs' summed value is a u64", true);
    await s.refuse("a spend adding an output of a backing no input names", spend([a.note], [to(10n, BOB), to(5n, BOB, OTHER)], [ALICE]), "ARITHMETIC",
      "lit-v1 §7 Spend: every output's backing is an input's", true);
    await s.admit("Alice pays Bob both, balanced per backing", spend([a.note, c.note], [to(10n, BOB), to(10n, BOB, OTHER)], [ALICE, ALICE]));
  }

  // Keys are 32-byte strings, not field elements: a note whose nullifier and tag exceed the pool's field still locks.
  {
    const s = new Sequence("keys past the pool's field"); all.push(s);
    let found: Built & { note: Opening } | undefined;
    for (let n = 0; found === undefined; n++) {
      const candidate = issue(5n, ALICE, { nonce: H("nonce", u64(BigInt(n))) });
      if (key(nfOf(candidate.note)) >= FIELD_MODULUS && key(H("moe/lit/v1/tag", nfOf(candidate.note))) >= FIELD_MODULUS) found = candidate;
    }
    await s.admit("K issues 5 to Alice, a note whose nullifier and tag both exceed the BN254 scalar field", found);
    await s.admit("the presenter demands it", demand([found.note], [ALICE]));
    await s.refuse("a spend of the locked note", spend([found.note], [to(5n, BOB)], [ALICE]), "LOCKED",
      "lit-v1 §7 Spend: every input's tag is under no standing lock (C3.7)");
  }
  return all;
}

describe("lit-v1 replay conformance vectors", () => {
  const path = new URL("../conformance/lit-v1-replay.json", import.meta.url);
  it("judges every step as written, and matches the committed vectors", async () => {
    const vectors = {
      about: "lit-v1 §7 replay vectors: each sequence judges its records in order against one segment's state from empty; see conformance/README.md.",
      specification: `money-from-first-principles ${LIT.reader.specification.replace(" ", ".md at ")} (adopted)`,
      configHash: hex(DOMAIN),
      obligor: hex(pub(K)),
      parties: Object.fromEntries(Object.entries(PARTIES).map(([name, s]) => [name, { secret: hex(s), public: hex(pub(s)) }])),
      sequences: (await sequences()).map(s => s.toJSON()),
    };
    if (process.env.CONFORMANCE_VECTORS === "write") writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(vectors)));
  });
});
