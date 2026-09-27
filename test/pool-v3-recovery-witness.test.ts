import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { limbsOf } from "../src/pool/field.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../src/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../src/pool/v3/capsules.js";
import { segmentIdentity } from "../src/pool/v3/headers.js";
import { tagOf } from "../src/pool/v3/recovery.js";
import { acceptanceBytes, acceptanceId, decodeRecord, encodeRecord, encodeSettlementAuthorization, releaseBytes,
  settlementAuthorization, statementHash, withdrawalBytes, type Record } from "../src/pool/v3/records.js";
import { authorizeAcceptance, authorizeSettlement, demandTask, requestTask, settleTask, withdrawalRecord,
  type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const domain = b(1), backing = b(2), issuerSecret = b(3), presenterSecret = b(4);
const presenter = ed25519.getPublicKey(presenterSecret), issuer = ed25519.getPublicKey(issuerSecret);
const context: SegmentContext = { domain, header: { domain, venue: b(5), operator: b(6), sequence: 1n,
  entries: [{ backing, link: backing }] } };
const funded = prepareExactOutput(b(7), domain, b(8), backing, 10n);
const padding = prepareExactOutput(b(7), domain, b(9), backing, 0n);
const tree = new NoteTree(); tree.append(funded.cm);
const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
const inputs = [input, { ...input, note: padding }];
const notice = { backing, quantity: 10n, presenter, instant: 4n, deadline: 10n };
// A stand-in proof tests framing/signatures only; real proofs run in acceptance.
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(32).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const demand = record(demandTask(context, inputs, notice)), demandId = statementHash(demand);
const secret = deriveSettlementOwnerSecret(b(10), domain, demandId, 9n).value;
const opening = { backing, value: 10n, owner: ownerOf(secret), rho: 11n };
const output = { opening, cm: commitmentOf(domain, opening) };
const settlement = () => record(settleTask(context, inputs, output, demandId));
const acceptance = () => authorizeAcceptance({ domain, demand: demandId, owner: opening.owner, deadline: 9n }, issuerSecret);

describe("runtime recovery witnesses", () => {
  it("binds the holder's notice and zeroes the demand's padding anchor and tag", () => {
    const task = demandTask(context, inputs, notice);
    expect(task.publicInputs.slice(0, 4)).toEqual([...limbsOf(domain), ...limbsOf(segmentIdentity(context.header))]);
    expect(task.publicInputs.slice(5)).toEqual([...limbsOf(backing), 10n, tree.root(), 0n, tagOf(funded.nf), 0n,
      ...limbsOf(presenter), 4n, 10n]);
    expect(task.witness["anchors"]).toEqual([String(tree.root()), "0"]);
    expect(task.witness["tags"]).toEqual([String(tagOf(funded.nf)), "0"]);
    expect(task.witness).not.toHaveProperty("nullifiers");
    expect(task.capsules).toEqual([]);
    expect(statementHash(record(demandTask(context, inputs, { ...notice, presenter: b(12) })))).not.toEqual(demandId);
    expect(statementHash(record(demandTask(context, inputs, { ...notice, instant: 3n })))).not.toEqual(demandId);
    expect(statementHash(record(demandTask(context, inputs, { ...notice, deadline: 11n })))).not.toEqual(demandId);
    const reversed = demandTask(context, [...inputs].reverse(), notice);
    expect(reversed.publicInputs.slice(8, 12)).toEqual([0n, tree.root(), 0n, tagOf(funded.nf)]);
  });

  it("settles to a backer's public opening and preserves spend-style padding anchors", () => {
    const task = settleTask(context, inputs, output, demandId);
    expect(task.publicInputs.slice(5)).toEqual([...limbsOf(backing), 10n, opening.owner, 11n,
      tree.root(), tree.root(), funded.nf, padding.nf, output.cm, ...limbsOf(demandId)]);
    expect(task.witness["secrets"]).toEqual(inputs.map(i => String(i.note.secret)));
    expect(task.witness["rho_out"]).toBe("11");
    expect(task.capsules).toEqual([]);
  });

  it("builds segment-free requests and binds refresh without revealing quantity", () => {
    const task = requestTask(domain, input, 2n);
    expect(task.publicInputs).toEqual([...limbsOf(domain), ...limbsOf(backing), tree.root(), tagOf(funded.nf), 2n]);
    for (const key of ["segment", "scope", "quantity"]) expect(task.witness).not.toHaveProperty(key);
    expect(task.witness["refresh"]).toBe("2");
    expect(statementHash(record(requestTask(domain, input, 1n)))).not.toEqual(statementHash(record(task)));
  });

  it("rejects wrong segment context, input counts, scope and codec time bounds", () => {
    expect(() => demandTask({ ...context, domain: b(90) }, inputs, notice)).toThrow("domain is not its segment");
    expect(() => demandTask(context, [input], notice)).toThrow("exactly two inputs");
    expect(() => demandTask(context, inputs, { ...notice, backing: b(90) })).toThrow("outside the segment's scope");
    for (const value of [-1n, 1n << 64n]) {
      const timeError = value < 0n ? "noncanonical public input" : "time outside u64";
      expect(() => demandTask(context, inputs, { ...notice, instant: value })).toThrow(timeError);
      expect(() => demandTask(context, inputs, { ...notice, deadline: value })).toThrow(timeError);
      expect(() => requestTask(domain, input, value)).toThrow(value < 0n ? "noncanonical public input" : "refresh outside u64");
    }
    expect(() => demandTask(context, inputs, { ...notice, quantity: 0n })).toThrow("quantity outside positive u64");
  });

  it("copies witness arrays rather than retaining caller paths or notice bytes", () => {
    const localInputs = structuredClone(inputs), localNotice = structuredClone(notice);
    const task = demandTask(context, localInputs, localNotice), original = structuredClone(task);
    (localInputs[0]!.path.siblings as bigint[])[0] = 99n;
    localNotice.presenter.fill(0); localNotice.backing.fill(0);
    expect(task).toEqual(original);
  });
});

describe("runtime recovery authorizations", () => {
  it("signs withdrawals with a context-specific presenter authorization", () => {
    const withdraw = withdrawalRecord(context, demandId, presenterSecret);
    expect(withdraw.kind).toBe(5); expect(withdraw.proof).toHaveLength(0);
    expect(ed25519.verify(withdraw.authorization, withdrawalBytes(withdraw), presenter, { zip215: false })).toBe(true);
    expect(ed25519.verify(withdraw.authorization, withdrawalBytes(withdraw), issuer, { zip215: false })).toBe(false);
    const next = withdrawalRecord({ ...context, header: { ...context.header, sequence: 2n } }, demandId, presenterSecret);
    expect(ed25519.verify(withdraw.authorization, withdrawalBytes(next), presenter, { zip215: false })).toBe(false);
    expect(decodeRecord(encodeRecord(withdraw))).toEqual(withdraw);
  });

  it("binds acceptance, output owner, deadline and the exact settlement in the two signatures", () => {
    const accepted = acceptance(), settled = authorizeSettlement(settlement(), accepted, presenterSecret);
    const auth = settlementAuthorization(settled);
    expect(auth.acceptance).toEqual(accepted);
    expect(ed25519.verify(accepted.signature, acceptanceBytes(accepted), issuer, { zip215: false })).toBe(true);
    expect(ed25519.verify(auth.releaseSignature, auth.releaseMessage, presenter, { zip215: false })).toBe(true);
    const changed = { ...settled, publicInputs: [...settled.publicInputs] }; changed.publicInputs[9] = 12n;
    expect(ed25519.verify(auth.releaseSignature, releaseBytes(domain, demandId, acceptanceId(accepted), statementHash(changed)),
      presenter, { zip215: false })).toBe(false);
    expect(ed25519.verify(accepted.signature, acceptanceBytes({ ...accepted, deadline: 8n }), issuer, { zip215: false })).toBe(false);
    for (const altered of [{ ...accepted, domain: b(90) }, { ...accepted, demand: b(90) }, { ...accepted, owner: 1n }]) {
      expect(() => authorizeSettlement(settlement(), altered, presenterSecret)).toThrow("acceptance does not match");
    }
    expect(() => authorizeSettlement(demand, accepted, presenterSecret)).toThrow("only a settlement");
    expect(() => authorizeAcceptance({ ...accepted, deadline: 1n << 64n }, issuerSecret)).toThrow("invalid acceptance owner or deadline");
  });

  it("encodes fixed deadline/signature bytes and rejects malformed widths and u64s", () => {
    const accepted = acceptance(), settled = authorizeSettlement(settlement(), accepted, presenterSecret);
    expect(settled.authorization).toHaveLength(136);
    expect(Array.from(settled.authorization.slice(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 9]);
    expect(settled.authorization.slice(8, 72)).toEqual(accepted.signature);
    const signature = new Uint8Array(64);
    for (const bad of [-1n, 1n << 64n]) expect(() => encodeSettlementAuthorization(bad, signature, signature)).toThrow("u64 out of range");
    expect(() => encodeSettlementAuthorization(0n, b(1), signature)).toThrow("wrong byte type or length");
    expect(() => encodeSettlementAuthorization(0n, signature, b(1))).toThrow("wrong byte type or length");
    const max = encodeSettlementAuthorization((1n << 64n) - 1n, signature, signature);
    expect(Array.from(max.slice(0, 8))).toEqual(new Array(8).fill(255));
  });

  it("owns returned signed bytes and proof independently of inputs", () => {
    const original = settlement(), accepted = acceptance();
    const settled = authorizeSettlement(original, accepted, presenterSecret), saved = encodeRecord(settled);
    original.proof.fill(0); accepted.signature.fill(0); accepted.domain.fill(0); accepted.demand.fill(0);
    expect(encodeRecord(settled)).toEqual(saved);
    const mutable = { domain: b(1), demand: b(2), owner: 1n, deadline: 0n };
    const signed = authorizeAcceptance(mutable, issuerSecret), bytes = acceptanceBytes(signed);
    mutable.domain.fill(0); mutable.demand.fill(0);
    expect(acceptanceBytes(signed)).toEqual(bytes);
  });
});
