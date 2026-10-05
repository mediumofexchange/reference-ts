import { createHash, createHmac, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { EncodingError } from "../src/bytes.js";
import * as config from "../src/lit/configuration.js";
import * as notes from "../src/lit/notes.js";
import * as codec from "../src/lit/records.js";
import * as frames from "../src/lit/commitments.js";
import * as wallet from "../src/lit/wallet-keys.js";

// Independent byte oracle for lit-v1 §§2–5, 8, 9: Node Buffer and node:crypto
// only, no ByteWriter or production helper. Domains, segments and keys are
// synthetic; nothing here claims admission, state or finality.
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
const join = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const int = (v: bigint | number, bytes: number): Buffer => Buffer.from(BigInt(v).toString(16).padStart(bytes * 2, "0"), "hex");
const u8 = (n: number): Buffer => int(n, 1), u32 = (n: number): Buffer => int(n, 4), u64 = (n: bigint): Buffer => int(n, 8);
const hash = (...b: Uint8Array[]): Buffer => createHash("sha256").update(join(...b)).digest();
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const id = (n: number): Buffer => Buffer.alloc(32, n);
const MAX = (1n << 64n) - 1n;
const secretOf = (n: number): Uint8Array => hash(ascii("lit test secret"), u8(n));
const keyOf = (n: number): Uint8Array => ed25519.getPublicKey(secretOf(n));
const sign = (n: number, message: Uint8Array): Uint8Array => ed25519.sign(message, secretOf(n));

const DOMAIN = hash(ascii("moe/lit/v1/config"), u8(2), u8(4));
const SEGMENT = id(19), OTHER_SEGMENT = id(23), BACKING = id(31), BACKING_2 = id(37), NONCE = id(41);
const K = 1, OPERATOR = 9;

const oOpening = (o: notes.Opening): Buffer => join(o.backing, u64(o.value), o.owner, o.rho);
const oOutput = (o: notes.Output): Buffer => join(o.backing, u64(o.value), o.owner);
const oCm = (o: notes.Opening): Buffer => hash(ascii("moe/lit/v1/note"), DOMAIN, oOpening(o));
const oNf = (cm: Uint8Array): Buffer => hash(ascii("moe/lit/v1/nullifier"), cm);
const oTag = (nf: Uint8Array): Buffer => hash(ascii("moe/lit/v1/tag"), nf);
const oSpendRho = (nfs: Uint8Array[], j: number): Buffer => hash(ascii("moe/lit/v1/rho/spend"), u8(nfs.length), ...nfs, u8(j));
function oStatement(s: codec.Statement): Buffer {
  const head = join(ascii("moe/lit/v1/statement"), s.domain, u8(s.kind));
  switch (s.kind) {
    case 1: return join(head, s.segment, s.backing, u64(s.quantity), s.owner, s.nonce);
    case 2: return join(head, s.segment, u8(s.inputs.length), ...s.inputs.map(oOpening), u8(s.outputs.length), ...s.outputs.map(oOutput));
    case 3: return join(head, s.segment, u64(s.quantity), u8(s.inputs.length), ...s.inputs.map(oOpening), u8(s.outputs.length), ...s.outputs.map(oOutput));
    case 4: return join(head, s.segment, u8(s.inputs.length), ...s.inputs.map(oOpening), s.presenter, u64(s.instant), u64(s.deadline));
    case 5: return join(head, s.segment, s.demand);
    case 6: return join(head, s.segment, s.demand, s.owner);
    case 7: return join(head, oOpening(s.input), u64(s.refresh));
  }
}
const oRecord = (statement: Uint8Array, authorization: Uint8Array): Buffer =>
  join(u32(statement.length), statement, u32(authorization.length), authorization);
const oAcceptance = (demand: Uint8Array, owner: Uint8Array, deadline: bigint): Buffer =>
  join(ascii("moe/lit/v1/acceptance"), DOMAIN, demand, owner, u64(deadline));
const oPublication = (backing: Uint8Array, kind: number, body: Uint8Array): Buffer =>
  join(ascii("moe/lit/v1/publication"), DOMAIN, backing, u8(kind), u32(body.length), body);

// Fixtures: K issues two notes, a two-input spend to four outputs, a burn with change, a two-note demand, its
// settlement, a withdrawal and a request. Owners 2..8 are distinct keys; K is key 1.
const issue = (owner: number, quantity: bigint, nonce = NONCE, segment = SEGMENT): codec.Issue =>
  ({ domain: DOMAIN, kind: 1, segment, backing: BACKING, quantity, owner: keyOf(owner), nonce });
const issuedOpening = (s: codec.Issue): notes.Opening => ({ backing: s.backing, value: s.quantity, owner: s.owner,
  rho: hash(ascii("moe/lit/v1/rho/issue"), s.backing, u64(s.quantity), s.owner, s.nonce) });
const issueA = issue(2, 70n), issueB = issue(3, 30n, id(43));
const noteA = issuedOpening(issueA), noteB = issuedOpening(issueB);
const nfA = oNf(oCm(noteA)), nfB = oNf(oCm(noteB));
const spend: codec.Spend = { domain: DOMAIN, kind: 2, segment: SEGMENT, inputs: [noteA, noteB], outputs: [
  { backing: BACKING, value: 40n, owner: keyOf(4) }, { backing: BACKING, value: 30n, owner: keyOf(5) },
  { backing: BACKING, value: 20n, owner: keyOf(6) }, { backing: BACKING, value: 10n, owner: keyOf(7) }] };
const spendOutputs = spend.outputs.map((o, j) => ({ ...o, rho: oSpendRho([nfA, nfB], j) }));
const burn: codec.Burn = { domain: DOMAIN, kind: 3, segment: SEGMENT, quantity: 15n, inputs: [spendOutputs[0]!],
  outputs: [{ backing: BACKING, value: 25n, owner: keyOf(8) }] };
const demand: codec.Demand = { domain: DOMAIN, kind: 4, segment: SEGMENT, inputs: [spendOutputs[1]!, spendOutputs[2]!],
  presenter: keyOf(10), instant: 1000n, deadline: 2000n };
const demandHash = hash(oStatement(demand));
const settle: codec.Settle = { domain: DOMAIN, kind: 6, segment: SEGMENT, demand: demandHash, owner: keyOf(11) };
const withdraw: codec.Withdraw = { domain: DOMAIN, kind: 5, segment: SEGMENT, demand: demandHash };
const request: codec.Request = { domain: DOMAIN, kind: 7, input: spendOutputs[3]!, refresh: 77n };
const owners: Record<string, number> = { [hex(keyOf(2))]: 2, [hex(keyOf(3))]: 3, [hex(keyOf(5))]: 5, [hex(keyOf(6))]: 6, [hex(keyOf(7))]: 7, [hex(keyOf(4))]: 4 };
const ownerSigs = (s: codec.Spend | codec.Burn | codec.Demand | codec.Request): Uint8Array => {
  const message = oStatement(s), inputs = s.kind === 7 ? [s.input] : s.inputs;
  return join(...inputs.map(input => sign(owners[hex(input.owner)]!, message)));
};
const ACCEPTANCE_DEADLINE = 1900n;
const acceptance = oAcceptance(demandHash, settle.owner, ACCEPTANCE_DEADLINE);
const acceptanceSig = sign(K, acceptance);
const release = join(ascii("moe/lit/v1/release"), DOMAIN, demandHash, hash(acceptance), hash(oStatement(settle)));
const settleAuthorization = join(u64(ACCEPTANCE_DEADLINE), acceptanceSig, sign(10, release));
const records: [codec.Statement, Uint8Array][] = [
  [issueA, sign(K, oStatement(issueA))], [spend, ownerSigs(spend)], [burn, ownerSigs(burn)], [demand, ownerSigs(demand)],
  [withdraw, sign(10, oStatement(withdraw))], [settle, settleAuthorization], [request, ownerSigs(request)],
];
const record = (i: number): codec.LitRecord => ({ statement: records[i]![0], authorization: records[i]![1] });
const reason = (f: () => unknown): string => {
  try { f(); } catch (error) { expect(error).toBeInstanceOf(EncodingError); return (error as Error).message; }
  throw new Error("expected a refusal");
};

describe("lit-v1 configuration and contexts", () => {
  it("hashes to §9's constant and bounds two inputs and four outputs", () => {
    expect(hex(config.litConfigHash())).toBe("17835aa2cc5e76c4cc1df8ec6486b5ca3419a96c732256ccb5abccd39c9a77c1");
    expect(hex(config.litConfigurationBytes())).toBe(hex(join(ascii("moe/lit/v1/config"), u8(2), u8(4))));
    expect(hex(config.litConfigHash())).toBe(hex(DOMAIN));
  });
});

describe("lit-v1 §2 notes and derived outputs", () => {
  it("matches the oracle's commitment, nullifier, tag and both rho derivations", () => {
    expect(hex(notes.openingBytes(noteA))).toBe(hex(oOpening(noteA)));
    expect(notes.openingBytes(noteA)).toHaveLength(104);
    expect(hex(notes.noteCommitment(DOMAIN, noteA))).toBe(hex(oCm(noteA)));
    expect(hex(notes.noteNullifier(oCm(noteA)))).toBe(hex(nfA));
    expect(hex(notes.noteTag(nfA))).toBe(hex(oTag(nfA)));
    expect(hex(notes.issueRho({ backing: BACKING, value: 70n, owner: keyOf(2) }, NONCE))).toBe(hex(noteA.rho));
    expect(hex(notes.spendRho([nfA, nfB], 3))).toBe(hex(oSpendRho([nfA, nfB], 3)));
  });

  it("derives every creating statement's outputs, independent of the segment", () => {
    const issued = codec.derivedOutputs(issueA);
    expect(issued.map(oOpening).map(hex)).toEqual([hex(oOpening(noteA))]);
    expect(hex(oOpening(codec.derivedOutputs(issue(2, 70n, NONCE, OTHER_SEGMENT))[0]!))).toBe(hex(oOpening(noteA)));
    expect(codec.derivedOutputs(spend).map(oOpening).map(hex)).toEqual(spendOutputs.map(oOpening).map(hex));
    expect(new Set(spendOutputs.map(o => hex(oCm(o)))).size).toBe(4);
    const respent = { ...spend, segment: OTHER_SEGMENT };
    expect(codec.derivedOutputs(respent).map(oOpening).map(hex)).toEqual(spendOutputs.map(oOpening).map(hex));
    const nfs = demand.inputs.map(input => oNf(oCm(input)));
    expect(codec.inputNullifiers(demand).map(hex)).toEqual(nfs.map(hex));
    const [settled] = codec.derivedOutputs(settle, demand);
    expect(hex(oOpening(settled!))).toBe(hex(oOpening({ backing: BACKING, value: 50n, owner: settle.owner, rho: oSpendRho(nfs, 0) })));
    // The settlement's output equals the spend-side derivation over the same nullifiers: equal outputs need equal notes.
    expect(hex(settled!.rho)).toBe(hex(notes.spendRho(nfs, 0)));
    expect(codec.derivedOutputs(burn).map(o => hex(o.rho))).toEqual([hex(oSpendRho([oNf(oCm(spendOutputs[0]!))], 0))]);
    for (const s of [demand, withdraw, request]) expect(codec.derivedOutputs(s)).toEqual([]);
  });

  it("refuses a settlement's output without its own demand", () => {
    expect(reason(() => codec.derivedOutputs(settle))).toBe("a settlement's output needs its demand");
    expect(reason(() => codec.derivedOutputs(settle, { ...demand, deadline: 2001n }))).toBe("not the settlement's demand");
    expect(reason(() => codec.demandClaim({ ...demand, inputs: [noteA, { ...noteB, backing: BACKING_2 }] })))
      .toBe("demand inputs of several backings");
  });
});

describe("lit-v1 §3 statements and records", () => {
  const bodies = [136, 34 + 208 + 288, 42 + 104 + 72, 81 + 208, 64, 96, 112];
  it("encodes every kind as the oracle does, at 53 bytes plus §3's body length, and decodes it back", () => {
    records.forEach(([s, authorization], i) => {
      const bytes = codec.statementBytes(s);
      expect(hex(bytes)).toBe(hex(oStatement(s)));
      expect(bytes.length).toBe(53 + bodies[i]!);
      expect(hex(codec.statementHash(s))).toBe(hex(hash(oStatement(s))));
      expect(hex(codec.statementBytes(codec.decodeStatement(bytes)))).toBe(hex(bytes));
      const recordBytes = codec.encodeRecord({ statement: s, authorization });
      expect(hex(recordBytes)).toBe(hex(oRecord(oStatement(s), authorization)));
      const decoded = codec.decodeRecord(recordBytes);
      expect(hex(codec.encodeRecord(decoded))).toBe(hex(recordBytes));
      expect(decoded.authorization).toHaveLength(codec.authorizationLength(s));
      expect(hex(codec.splitRecord(recordBytes).statement)).toBe(hex(bytes));
    });
    expect(Math.min(...records.map(([s, a]) => codec.encodeRecord({ statement: s, authorization: a }).length))).toBe(189);
  });

  it("refuses noncanonical statements with the specific reason", () => {
    const spendBytes = oStatement(spend);
    const at = (b: Buffer, offset: number, value: number): Buffer => { const c = Buffer.from(b); c[offset] = value; return c; };
    expect(reason(() => codec.decodeStatement(join(spendBytes, u8(0))))).toBe("trailing bytes");
    expect(reason(() => codec.decodeStatement(spendBytes.subarray(0, spendBytes.length - 1)))).toBe("truncated");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 52, 0)))).toBe("unknown statement kind");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 52, 8)))).toBe("unknown statement kind");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 0, 0x4e)))).toBe("wrong statement context");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 85, 0)))).toBe("wrong input or output count");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 85, 3)))).toBe("wrong input or output count");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 86 + 208, 0)))).toBe("wrong input or output count");
    expect(reason(() => codec.decodeStatement(at(spendBytes, 86 + 208, 5)))).toBe("wrong input or output count");
    const burnBytes = oStatement({ ...burn, outputs: [] });
    expect(codec.decodeStatement(burnBytes).kind).toBe(3);
    expect(reason(() => codec.decodeStatement(at(oStatement(burn), 94 + 104, 2)))).toBe("wrong input or output count");
    // A zero value, a zero quantity, a small-order owner and a noncanonical owner encoding.
    expect(reason(() => codec.decodeStatement(oStatement({ ...spend, outputs: [{ ...spend.outputs[0]!, value: 0n }] }))))
      .toBe("value is not a positive u64");
    expect(reason(() => codec.decodeStatement(oStatement({ ...issueA, quantity: 0n })))).toBe("quantity is not a positive u64");
    const smallOrder = Buffer.alloc(32); smallOrder[0] = 1;
    expect(reason(() => codec.decodeStatement(oStatement({ ...settle, owner: smallOrder })))).toBe("invalid owner key");
    const noncanonical = Buffer.alloc(32, 0xff); noncanonical[0] = 0xed; noncanonical[31] = 0x7f;
    expect(reason(() => codec.decodeStatement(oStatement({ ...demand, presenter: noncanonical })))).toBe("invalid presenter key");
    expect(reason(() => codec.decodeStatement(oStatement({ ...request, input: { ...request.input, owner: smallOrder } }))))
      .toBe("invalid owner key");
  });

  it("refuses a record whose authorization has another length, or which does not split exactly", () => {
    const s = oStatement(spend), sigs = ownerSigs(spend);
    expect(reason(() => codec.decodeRecord(oRecord(s, sigs.subarray(0, 64))))).toBe("wrong authorization length");
    expect(reason(() => codec.decodeRecord(oRecord(oStatement(settle), settleAuthorization.subarray(1))))).toBe("wrong authorization length");
    expect(reason(() => codec.decodeRecord(join(oRecord(s, sigs), u8(0))))).toBe("trailing bytes");
    expect(reason(() => codec.splitRecord(join(u32(s.length + 1), s)))).toBe("truncated");
    expect(reason(() => codec.encodeRecord({ statement: spend, authorization: new Uint8Array(64) }))).toBe("wrong authorization length");
  });

  it("hashes the actual fields as evidence, even an empty or failing authorization", () => {
    const pair = codec.evidencePair(record(1));
    expect(hex(pair.statementHash)).toBe(hex(hash(oStatement(spend))));
    expect(hex(pair.signatureHash)).toBe(hex(hash(ownerSigs(spend))));
    expect(hex(codec.hashEvidenceFields(new Uint8Array(3), new Uint8Array(0)).signatureHash)).toBe(hex(hash(new Uint8Array(0))));
  });
});

describe("lit-v1 §§6–7 arithmetic and signatures", () => {
  it("balances a spend per backing with widened sums", () => {
    expect(codec.arithmeticHolds(spend)).toBe(true);
    expect(codec.arithmeticHolds({ ...spend, outputs: spend.outputs.slice(1) })).toBe(false);
    expect(codec.arithmeticHolds({ ...spend, outputs: [...spend.outputs.slice(1), { ...spend.outputs[0]!, backing: BACKING_2 }] })).toBe(false);
    const big = { ...noteA, value: MAX }, two = { ...noteB, value: 2n };
    // Wrapping at 2^64 would balance (MAX + 2 ≡ 1); the widened sum does not.
    expect(codec.arithmeticHolds({ ...spend, inputs: [big, two], outputs: [{ ...spend.outputs[0]!, value: 1n }] })).toBe(false);
    expect(codec.arithmeticHolds({ ...spend, inputs: [big, two], outputs: [{ ...spend.outputs[0]!, value: MAX }, { ...spend.outputs[1]!, value: 2n }] })).toBe(true);
    const mixed = { ...spend, inputs: [noteA, { ...noteB, backing: BACKING_2 }],
      outputs: [{ backing: BACKING, value: 70n, owner: keyOf(4) }, { backing: BACKING_2, value: 30n, owner: keyOf(5) }] };
    expect(codec.arithmeticHolds(mixed)).toBe(true);
    expect(codec.arithmeticHolds({ ...mixed, outputs: [{ backing: BACKING, value: 60n, owner: keyOf(4) }, { backing: BACKING_2, value: 40n, owner: keyOf(5) }] })).toBe(false);
  });

  it("checks a burn's one backing, its change and its quantity, and a demand's one backing", () => {
    expect(codec.arithmeticHolds(burn)).toBe(true);
    expect(codec.arithmeticHolds({ ...burn, quantity: 16n })).toBe(false);
    expect(codec.arithmeticHolds({ ...burn, quantity: 40n, outputs: [] })).toBe(true);
    expect(codec.arithmeticHolds({ ...burn, outputs: [{ ...burn.outputs[0]!, backing: BACKING_2 }] })).toBe(false);
    expect(codec.arithmeticHolds({ ...burn, quantity: 140n, inputs: [noteA, { ...noteB, backing: BACKING_2 }], outputs: [] })).toBe(false);
    expect(codec.arithmeticHolds(demand)).toBe(true);
    expect(codec.arithmeticHolds({ ...demand, inputs: [noteA, { ...noteB, backing: BACKING_2 }] })).toBe(false);
  });

  it("verifies owner signatures in input order over the statement bytes, and K's and the presenter's", () => {
    for (const i of [1, 2, 3, 6]) expect(codec.ownerSignaturesVerify(record(i))).toBe(true);
    const sigs = ownerSigs(spend);
    expect(codec.ownerSignaturesVerify({ statement: spend, authorization: join(sigs.subarray(64), sigs.subarray(0, 64)) })).toBe(false);
    expect(codec.ownerSignaturesVerify({ statement: { ...spend, segment: OTHER_SEGMENT }, authorization: sigs })).toBe(false);
    expect(codec.ownerSignaturesVerify(record(0))).toBe(false);
    expect(codec.ownerSignaturesVerify({ statement: spend, authorization: sigs.subarray(64) })).toBe(false);
    expect(codec.statementSignatureVerifies(record(0), keyOf(K))).toBe(true);
    expect(codec.statementSignatureVerifies(record(0), keyOf(2))).toBe(false);
    expect(codec.statementSignatureVerifies(record(4), keyOf(10))).toBe(true);
    expect(codec.statementSignatureVerifies(record(1), keyOf(2))).toBe(false);
  });
});

describe("lit-v1 §4 signed objects and publications", () => {
  it("reconstructs a settlement's acceptance and release, which verify under K and the presenter key", () => {
    const a = codec.settlementAuthorization(record(5));
    expect(hex(a.acceptanceMessage)).toBe(hex(acceptance));
    expect(a.acceptanceMessage).toHaveLength(125);
    expect(hex(a.releaseMessage)).toBe(hex(release));
    expect(a.releaseMessage).toHaveLength(146);
    expect(ed25519.verify(a.acceptance.signature, a.acceptanceMessage, keyOf(K))).toBe(true);
    expect(ed25519.verify(a.releaseSignature, a.releaseMessage, demand.presenter)).toBe(true);
    expect(hex(codec.encodeSettlementAuthorization(ACCEPTANCE_DEADLINE, acceptanceSig, sign(10, release)))).toBe(hex(settleAuthorization));
    expect(reason(() => codec.settlementAuthorization(record(4)))).toBe("not a settlement");
  });

  const signed = { domain: DOMAIN, demand: demandHash, owner: settle.owner, deadline: ACCEPTANCE_DEADLINE, signature: acceptanceSig };
  const publications: [codec.Publication, Buffer][] = [
    [{ domain: DOMAIN, backing: BACKING, kind: 1, record: record(3) }, oPublication(BACKING, 1, oRecord(oStatement(demand), ownerSigs(demand)))],
    [{ domain: DOMAIN, backing: BACKING, kind: 2, acceptance: signed }, oPublication(BACKING, 2, join(acceptance, acceptanceSig))],
    [{ domain: DOMAIN, backing: BACKING, kind: 3, record: record(5) }, oPublication(BACKING, 3, oRecord(oStatement(settle), settleAuthorization))],
    [{ domain: DOMAIN, backing: BACKING, kind: 4, record: record(4) }, oPublication(BACKING, 4, oRecord(oStatement(withdraw), records[4]![1]))],
    [{ domain: DOMAIN, backing: BACKING, kind: 5, record: record(6) }, oPublication(BACKING, 5, oRecord(oStatement(request), ownerSigs(request)))],
  ];
  it("encodes every publication kind as the oracle does and decodes it back", () => {
    for (const [p, expected] of publications) {
      const bytes = codec.encodePublication(p);
      expect(hex(bytes)).toBe(hex(expected));
      expect(hex(codec.encodePublication(codec.decodePublication(bytes)))).toBe(hex(bytes));
      expect(hex(codec.publicationId(p))).toBe(hex(hash(expected)));
    }
    expect(publications[1]![1].length).toBe(22 + 69 + 189);
    expect(codec.MAX_PUBLICATION_BYTES).toBe(569);
    const largest = codec.encodePublication(publications[0]![0]);
    expect(largest.length).toBe(569);
  });

  it("routes a demand and a request by their own openings and refuses a body past its kind's bound before copying", () => {
    expect(reason(() => codec.decodePublication(oPublication(BACKING_2, 1, oRecord(oStatement(demand), ownerSigs(demand))))))
      .toBe("wrong routing backing");
    expect(reason(() => codec.decodePublication(oPublication(BACKING_2, 5, oRecord(oStatement(request), ownerSigs(request))))))
      .toBe("wrong routing backing");
    // Acceptances, settlements and withdrawals route beside their demand: any backing decodes.
    expect(codec.decodePublication(oPublication(BACKING_2, 3, oRecord(oStatement(settle), settleAuthorization))).kind).toBe(3);
    expect(reason(() => codec.decodePublication(oPublication(BACKING, 1, oRecord(oStatement(withdraw), records[4]![1])))))
      .toBe("wrong publication body kind");
    expect(reason(() => codec.decodePublication(join(ascii("moe/lit/v1/publication"), DOMAIN, BACKING, u8(4), u32(190)))))
      .toBe("field too long");
    expect(reason(() => codec.decodePublication(join(ascii("moe/lit/v1/publication"), DOMAIN, BACKING, u8(1), u32(479)))))
      .toBe("field too long");
    expect(reason(() => codec.decodePublication(join(ascii("moe/lit/v1/publication"), DOMAIN, BACKING, u8(6), u32(0)))))
      .toBe("unknown publication kind");
    const otherDomain = id(5);
    expect(reason(() => codec.decodePublication(join(ascii("moe/lit/v1/publication"), otherDomain, BACKING, u8(2), u32(189), acceptance, acceptanceSig))))
      .toBe("inconsistent domain");
  });
});

describe("lit-v1 §5 frames", () => {
  const spentRoot = id(61);
  const pairOf = (i: number) => ({ statementHash: hash(oStatement(records[i]![0])), signatureHash: hash(records[i]![1]) });
  it("chains history and evidence and frames the snapshot and receipt as the oracle does", () => {
    const h0 = hash(ascii("moe/lit/v1/genesis"), SEGMENT), e0 = hash(ascii("moe/lit/v1/evidence-seed"), SEGMENT);
    expect(hex(frames.genesisHistoryHash(SEGMENT))).toBe(hex(h0));
    expect(hex(frames.genesisEvidenceHash(SEGMENT))).toBe(hex(e0));
    const p = pairOf(0);
    const h1 = hash(ascii("moe/lit/v1/history"), h0, p.statementHash, spentRoot, u64(1n));
    const e1 = hash(ascii("moe/lit/v1/evidence-link"), e0, p.statementHash, p.signatureHash, u64(1n));
    expect(hex(frames.nextHistoryHash(h0, p.statementHash, spentRoot, 1n))).toBe(hex(h1));
    expect(hex(frames.nextEvidenceHash(e0, p, 1n))).toBe(hex(e1));
    expect(reason(() => frames.nextHistoryHash(h0, p.statementHash, spentRoot, 0n))).toBe("invalid u64");
    const e2 = frames.nextEvidenceHash(e1, pairOf(1), 2n);
    const snapshot = { backing: BACKING, segment: SEGMENT, historyHash: h1, evidenceHash: e2, issued: 100n, burned: 15n };
    const snapshotBytes = join(ascii("moe/lit/v1/snapshot"), BACKING, SEGMENT, h1, e2, u64(100n), u64(15n));
    expect(hex(frames.snapshotBytes(snapshot))).toBe(hex(snapshotBytes));
    expect(snapshotBytes.length).toBe(163);
    expect(hex(frames.snapshotBytes(frames.decodeSnapshot(snapshotBytes)))).toBe(hex(snapshotBytes));
    const digest = hash(snapshotBytes);
    expect(frames.verifyEvidenceOpening(digest, snapshot, { position: 1n, length: 2n, previous: e0, target: p, suffix: [pairOf(1)] })).toBe(true);
    expect(frames.verifyEvidenceOpening(digest, snapshot, { position: 2n, length: 2n, previous: e1, target: pairOf(1), suffix: [] })).toBe(true);
    expect(frames.verifyEvidenceOpening(digest, snapshot, { position: 1n, length: 2n, previous: e0, target: pairOf(1), suffix: [p] })).toBe(false);
    expect(frames.verifyEvidenceOpening(digest, snapshot, { position: 1n, length: 2n, previous: e1, target: p, suffix: [pairOf(1)] })).toBe(false);
    expect(frames.verifyEvidenceOpening(id(0), snapshot, { position: 2n, length: 2n, previous: e1, target: pairOf(1), suffix: [] })).toBe(false);
  });

  it("frames a 194-byte receipt message and 290-byte record that verify only under the segment's operator", () => {
    const p = pairOf(1), historyHash = id(67);
    const fields = { domain: DOMAIN, segment: SEGMENT, position: 2n, ...p, historyHash, after: 5n };
    const message = join(ascii("moe/lit/v1/receipt"), DOMAIN, SEGMENT, u64(2n), p.statementHash, historyHash, p.signatureHash, u64(5n));
    expect(hex(frames.receiptBytes(fields))).toBe(hex(message));
    expect(message.length).toBe(194);
    const receipt = { ...fields, operator: keyOf(OPERATOR), signature: sign(OPERATOR, message) };
    const bytes = frames.encodeReceipt(receipt);
    expect(hex(bytes)).toBe(hex(join(message, keyOf(OPERATOR), receipt.signature)));
    expect(bytes.length).toBe(290);
    expect(hex(frames.encodeReceipt(frames.decodeReceipt(bytes)))).toBe(hex(bytes));
    const authority = { domain: DOMAIN, segment: SEGMENT, operator: keyOf(OPERATOR) };
    expect(frames.verifyReceipt(authority, receipt)).toBe(true);
    expect(frames.verifyReceipt({ ...authority, segment: OTHER_SEGMENT }, receipt)).toBe(false);
    expect(frames.verifyReceipt({ ...authority, operator: keyOf(K) }, receipt)).toBe(false);
    expect(frames.verifyReceipt(authority, { ...receipt, after: 6n })).toBe(false);
    expect(frames.receiptMatchesEvent(fields, { position: 2n, ...p, historyHash })).toBe(true);
    expect(frames.receiptMatchesEvent(fields, { position: 2n, ...p, historyHash: id(68) })).toBe(false);
    const zero = Buffer.from(bytes); zero.fill(0, 18 + 64, 18 + 72);
    expect(reason(() => frames.decodeReceipt(zero))).toBe("receipt position is zero");
  });
});

describe("lit-v1 §8 key derivation", () => {
  const seed = id(71);
  const root = (info: string): Buffer => Buffer.from(hkdfSync("sha256", seed, DOMAIN, ascii(info), 32));
  const hmac = (key: Uint8Array, ...m: Uint8Array[]): Buffer => createHmac("sha256", key).update(join(...m)).digest();
  it("derives owner, acceptance and presenter secrets under three HKDF roots", () => {
    expect(hex(wallet.ownerSecret(seed, DOMAIN, 0n))).toBe(hex(hmac(root("moe/wallet/lit/v1/owner"), u64(0n))));
    expect(hex(wallet.ownerSecret(seed, DOMAIN, 255n))).toBe(hex(hmac(root("moe/wallet/lit/v1/owner"), u64(255n))));
    expect(hex(wallet.acceptSecret(seed, DOMAIN, demandHash, ACCEPTANCE_DEADLINE)))
      .toBe(hex(hmac(root("moe/wallet/lit/v1/settlement"), demandHash, u64(ACCEPTANCE_DEADLINE))));
    const tags = demand.inputs.map(input => oTag(oNf(oCm(input))));
    expect(hex(wallet.presentSecret(seed, DOMAIN, tags, 1000n, 2000n)))
      .toBe(hex(hmac(root("moe/wallet/lit/v1/presenter"), tags[0]!, tags[1]!, u64(1000n), u64(2000n))));
    expect(hex(wallet.presentSecret(seed, DOMAIN, [tags[0]!], 1000n, 2000n)))
      .toBe(hex(hmac(root("moe/wallet/lit/v1/presenter"), tags[0]!, Buffer.alloc(32), u64(1000n), u64(2000n))));
    const secret = wallet.ownerSecret(seed, DOMAIN, 7n);
    expect(hex(wallet.publicKeyOf(secret))).toBe(hex(ed25519.getPublicKey(secret)));
    expect(hex(wallet.ownerSecret(seed, id(1), 7n))).not.toBe(hex(secret));
    expect(reason(() => wallet.ownerSecret(seed, DOMAIN, -1n))).toBe("owner index outside u64");
  });
});

describe("lit-v1 conformance vectors", () => {
  // Every vector comes from the oracle above; the codec must reproduce each byte. LIT_VECTORS=write rewrites the file.
  const path = new URL("./fixtures/lit-v1-vectors.json", import.meta.url);
  const seed = id(71);
  const vectors = {
    specification: "money-from-first-principles lit-v1.md at 0c2ac45 (draft until adopted)",
    configHash: hex(DOMAIN),
    keys: Object.fromEntries([K, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => [`secret${n}`, hex(secretOf(n))])),
    records: records.map(([s, authorization]) => {
      const statement = oStatement(s);
      const created = s.kind === 1 ? [issuedOpening(s)] : s.kind === 2 || s.kind === 3
        ? s.outputs.map((o, j) => ({ ...o, rho: oSpendRho(s.inputs.map(input => oNf(oCm(input))), j) }))
        : s.kind === 6 ? [{ backing: BACKING, value: 50n, owner: s.owner, rho: oSpendRho(demand.inputs.map(input => oNf(oCm(input))), 0) }] : [];
      return { kind: s.kind, record: hex(oRecord(statement, authorization)), statementHash: hex(hash(statement)),
        signatureHash: hex(hash(authorization)),
        outputs: created.map(o => ({ opening: hex(oOpening(o)), cm: hex(oCm(o)), nf: hex(oNf(oCm(o))), tag: hex(oTag(oNf(oCm(o)))) })) };
    }),
    publications: [
      hex(oPublication(BACKING, 1, oRecord(oStatement(demand), ownerSigs(demand)))),
      hex(oPublication(BACKING, 2, join(acceptance, acceptanceSig))),
      hex(oPublication(BACKING, 3, oRecord(oStatement(settle), settleAuthorization))),
      hex(oPublication(BACKING, 4, oRecord(oStatement(withdraw), records[4]![1]))),
      hex(oPublication(BACKING, 5, oRecord(oStatement(request), ownerSigs(request)))),
    ],
    wallet: { seed: hex(seed), owner0: hex(hmac(seed)) },
  };
  function hmac(s: Uint8Array): Buffer {
    return createHmac("sha256", Buffer.from(hkdfSync("sha256", s, DOMAIN, ascii("moe/wallet/lit/v1/owner"), 32))).update(u64(0n)).digest();
  }
  it("matches the committed vectors, and the codec reproduces every one", () => {
    if (process.env.LIT_VECTORS === "write") writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(vectors);
    const statements = new Map<string, codec.Statement>();
    for (const v of vectors.records) {
      const r = codec.decodeRecord(Buffer.from(v.record, "hex"));
      statements.set(v.statementHash, r.statement);
      expect(hex(codec.encodeRecord(r))).toBe(v.record);
      expect(hex(codec.statementHash(r.statement))).toBe(v.statementHash);
      expect(hex(codec.evidencePair(r).signatureHash)).toBe(v.signatureHash);
      const d = r.statement.kind === 6 ? statements.get(hex(r.statement.demand)) as codec.Demand : undefined;
      const outputs = codec.derivedOutputs(r.statement, d);
      expect(outputs.map(o => hex(notes.openingBytes(o)))).toEqual(v.outputs.map(o => o.opening));
      expect(outputs.map(o => hex(notes.noteCommitment(r.statement.domain, o)))).toEqual(v.outputs.map(o => o.cm));
      expect(outputs.map(o => hex(notes.noteTag(notes.noteNullifier(notes.noteCommitment(r.statement.domain, o))))))
        .toEqual(v.outputs.map(o => o.tag));
    }
    for (const p of vectors.publications) expect(hex(codec.encodePublication(codec.decodePublication(Buffer.from(p, "hex"))))).toBe(p);
    expect(hex(wallet.ownerSecret(seed, DOMAIN, 0n))).toBe(vectors.wallet.owner0);
  });
});
