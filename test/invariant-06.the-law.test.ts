import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { LedgerError, TransparentLedger } from "../src/ledger.js";
import { encodeBurn, encodeIssuance, encodeTransfer } from "../src/messages.js";
import { encodeLock, NO_ATTEMPT_SALT, NO_DECISION_VENUE } from "../src/presentation.js";
import { KEYS, register, SECRETS } from "./support.js";

// The law: nothing you owe (your written maximum) grows without your
// signature; nothing you hold leaves without your signature.

function freshLedger() {
  const ledger = new TransparentLedger();
  const backing = register(ledger, SECRETS.backer);
  return { ledger, backing };
}

describe("the law: nothing you owe grows without your signature", () => {
  it("issuance signed by the backer grows outstanding", () => {
    const { ledger, backing } = freshLedger();
    const op = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    ledger.issue(op, ed25519.sign(encodeIssuance(op), SECRETS.backer));
    expect(ledger.outstanding(backing)).toBe(100n);
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
  });

  it("issuance signed by anyone else is rejected and changes nothing", () => {
    const { ledger, backing } = freshLedger();
    const op = { backing, recipient: KEYS.mallory, quantity: 100n, nonce: 0n };
    expect(() => ledger.issue(op, ed25519.sign(encodeIssuance(op), SECRETS.mallory))).toThrow(
      /only the obligor issues/,
    );
    expect(ledger.outstanding(backing)).toBe(0n);
    expect(ledger.balance(backing, KEYS.mallory)).toBe(0n);
  });

  it("a corrupted backer signature is rejected", () => {
    const { ledger, backing } = freshLedger();
    const op = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    const signature = ed25519.sign(encodeIssuance(op), SECRETS.backer);
    signature[0] = (signature[0] as number) ^ 0xff;
    expect(() => ledger.issue(op, signature)).toThrow(/only the obligor issues/);
    expect(ledger.outstanding(backing)).toBe(0n);
  });
});

describe("the law: nothing you hold leaves without your signature", () => {
  function ledgerWithAliceHolding100() {
    const { ledger, backing } = freshLedger();
    const op = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    ledger.issue(op, ed25519.sign(encodeIssuance(op), SECRETS.backer));
    return { ledger, backing };
  }

  it("a transfer signed by the holder moves the units", () => {
    const { ledger, backing } = ledgerWithAliceHolding100();
    const op = { backing, from: KEYS.alice, to: KEYS.mallory, quantity: 40n, nonce: 0n };
    ledger.transfer(op, ed25519.sign(encodeTransfer(op), SECRETS.alice));
    expect(ledger.balance(backing, KEYS.alice)).toBe(60n);
    expect(ledger.balance(backing, KEYS.mallory)).toBe(40n);
  });

  it("a transfer out of Alice's holding signed by Mallory is rejected", () => {
    const { ledger, backing } = ledgerWithAliceHolding100();
    const op = { backing, from: KEYS.alice, to: KEYS.mallory, quantity: 40n, nonce: 0n };
    expect(() => ledger.transfer(op, ed25519.sign(encodeTransfer(op), SECRETS.mallory))).toThrow(
      /only the holder moves/,
    );
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
  });

  it("a burn of Alice's holding signed by anyone else is rejected", () => {
    const { ledger, backing } = ledgerWithAliceHolding100();
    const op = { backing, holder: KEYS.alice, quantity: 40n, nonce: 0n };
    expect(() => ledger.burn(op, ed25519.sign(encodeBurn(op), SECRETS.backer))).toThrow(
      /only the holder burns/,
    );
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
    expect(ledger.outstanding(backing)).toBe(100n);
  });

  it("more than the holding cannot leave", () => {
    const { ledger, backing } = ledgerWithAliceHolding100();
    const op = { backing, from: KEYS.alice, to: KEYS.mallory, quantity: 101n, nonce: 0n };
    expect(() => ledger.transfer(op, ed25519.sign(encodeTransfer(op), SECRETS.alice))).toThrow(
      /insufficient balance/,
    );
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
  });

  it("a malformed signer key is an EncodingError, from the encoder that saw it", () => {
    // The ledger used to pre-check signer keys and raise a LedgerError, which is
    // the one thing docs/PROTOCOL_RULES.md's boundary rule forbids: "does not pre-check in
    // order to relabel an error — give the lower layer a distinguishable error
    // type instead." It also made the two entry points disagree, since the
    // sequencer encodes first and so always surfaced the encoder's refusal.
    // Either way the key moves nothing and nothing crashes.
    const { ledger, backing } = ledgerWithAliceHolding100();
    const shortKey = new Uint8Array(31);
    const badTransfer = { backing, from: shortKey, to: KEYS.bob, quantity: 1n, nonce: 0n };
    expect(() => ledger.transfer(badTransfer, new Uint8Array(64))).toThrow(EncodingError);
    const badBurn = { backing, holder: shortKey, quantity: 1n, nonce: 0n };
    expect(() => ledger.burn(badBurn, new Uint8Array(64))).toThrow(EncodingError);
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
  });

  it("a key that signs nothing is still checked, because nothing else sees it", () => {
    // A recipient or a destination is not a signer, so no signature proves it is
    // a real point, and a balance under an invalid point is unspendable garbage.
    const { ledger, backing } = ledgerWithAliceHolding100();
    const dead = new Uint8Array(32).fill(0x04);
    const op = { backing, from: KEYS.alice, to: dead, quantity: 1n, nonce: 0n };
    expect(() => ledger.transfer(op, ed25519.sign(encodeTransfer(op), SECRETS.alice))).toThrow(
      /not a valid Ed25519 point/,
    );
  });

  it("a lock's beneficiary signs nothing either, and is checked like a recipient", () => {
    // Found by the 2026-08-22 audit: the third credit path. A lock to a key that
    // is not a point settles units no signature can ever move, still counted in
    // outstanding. Refused at the lock, so the refusal lands on whoever chose it.
    const { ledger, backing } = ledgerWithAliceHolding100();
    const dead = new Uint8Array(32).fill(0x04);
    const op = {
      backing,
      attemptId: new Uint8Array(32).fill(0x11),
      holder: KEYS.alice,
      beneficiary: dead,
      quantity: 10n,
      timeout: 100n,
      decisionVenue: NO_DECISION_VENUE,
      parties: [KEYS.alice],
      nonce: 0n,
    };
    const entry = {
      kind: "lock" as const,
      attemptId: op.attemptId,
      holder: op.holder,
      beneficiary: op.beneficiary,
      quantity: op.quantity,
      timeout: op.timeout,
      decisionVenue: op.decisionVenue,
      parties: op.parties,
      nonce: op.nonce,
      salt: NO_ATTEMPT_SALT,
      signature: ed25519.sign(encodeLock(op), SECRETS.alice),
    };
    expect(() => ledger.apply(backing, entry, 0n)).toThrow(/not a valid Ed25519 point/);
    expect(ledger.availableBalance(backing, KEYS.alice)).toBe(100n);
  });
});

describe("the law: a set is applied whole or not at all, whatever backings it names", () => {
  it("applyAll establishes a repeated backing as the set will run, and applies nothing on a refusal", () => {
    // Found by the 2026-08-22 audit: the dry run took a fresh copy per item, so
    // two of Alice's transfers at one nonce each passed alone, the first applied
    // for real and the second threw — half a set. One working copy per backing,
    // each item applied into it in order, is what "all or nothing" needs.
    const { ledger, backing } = freshLedger();
    const issue = { backing, recipient: KEYS.alice, quantity: 100n, nonce: 0n };
    ledger.issue(issue, ed25519.sign(encodeIssuance(issue), SECRETS.backer));
    const first = { backing, from: KEYS.alice, to: KEYS.bob, quantity: 10n, nonce: 0n };
    const second = { backing, from: KEYS.alice, to: KEYS.carol, quantity: 10n, nonce: 0n };
    const item = (op: typeof first) => ({
      backing,
      op: {
        kind: "transfer" as const,
        from: op.from,
        to: op.to,
        quantity: op.quantity,
        nonce: op.nonce,
        signature: ed25519.sign(encodeTransfer(op), SECRETS.alice),
      },
    });
    expect(() => ledger.applyAll([item(first), item(second)], undefined)).toThrow(/nonce/);
    expect(ledger.balance(backing, KEYS.alice)).toBe(100n);
    expect(ledger.balance(backing, KEYS.bob)).toBe(0n);
    expect(ledger.opLog(backing)).toHaveLength(1);
    // And a set that does run on one backing twice runs whole.
    const third = { ...second, nonce: 1n };
    ledger.applyAll([item(first), item(third)], undefined);
    expect(ledger.balance(backing, KEYS.alice)).toBe(80n);
  });
});
