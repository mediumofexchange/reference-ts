import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking, encodeBacking, signBacking } from "../src/backing.js";
import { encodePublishedOp, opMessageOfEntry, type PublishedOp } from "../src/oplog.js";
import { decodeCommitment } from "../src/commitment.js";
import { VenueError } from "../src/venue.js";
import {
  hex, localViewFromWire, parsePilotCommand, receiptFromWire, stateFromWire, verifyPilotPayment,
  type PilotCommand, type PilotReply,
} from "../src/pilot-wire.js";
import type { PilotStore as Store } from "../src/pilot-store.js";

const supported = Number(process.versions.node.split(".")[0]) >= 24;
const operatorSecret = new Uint8Array(32).fill(31), issuerSecret = new Uint8Array(32).fill(32);
const aliceSecret = new Uint8Array(32).fill(33), bobSecret = new Uint8Array(32).fill(34);
const operator = ed25519.getPublicKey(operatorSecret), issuer = ed25519.getPublicKey(issuerSecret);
const alice = ed25519.getPublicKey(aliceSecret), bob = ed25519.getPublicKey(bobSecret);
const venueId = new Uint8Array(32).fill(35);
const backing = makeBacking({ obligor: issuer, payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
  reliance: [], evidence: { setting: "transparent", operator, witnessing: { venue: venueId, interval: 1n } } });
const terms = encodeBacking(backing), termsSignature = signBacking(issuerSecret, backing);
const register: PilotCommand = { id: "register", kind: "register", backing: bytesToHex(terms), signature: bytesToHex(termsSignature) };
function signed(op: PublishedOp, secret: Uint8Array, id: string): PilotCommand & { kind: "submit" } {
  const signature = ed25519.sign(opMessageOfEntry(backing.name, op), secret);
  return { id, kind: "submit", operation: bytesToHex(encodePublishedOp(backing.name, { ...op, signature } as PublishedOp)) };
}
const issue = signed({ kind: "issue", recipient: alice, quantity: 100n, nonce: 0n, signature: new Uint8Array(64) }, issuerSecret, "issue");
const transfer = signed({ kind: "transfer", from: alice, to: bob, quantity: 40n, nonce: 0n, signature: new Uint8Array(64) }, aliceSecret, "transfer");
function accepted(reply: PilotReply) {
  if (reply.kind !== "accepted") throw new Error("expected receipt");
  return receiptFromWire(reply.receipt);
}

describe.skipIf(!supported)("durable local pilot (Node 24)", () => {
  let PilotStore: typeof import("../src/pilot-store.js").PilotStore;
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  const stores: Store[] = [], directories: string[] = [];
  const scratch = resolve("scratch");
  beforeAll(async () => {
    ({ PilotStore } = await import("../src/pilot-store.js"));
    ({ DatabaseSync } = await import("node:sqlite"));
  });
  function path() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pilot-test-")); directories.push(directory);
    return join(directory, "state.db");
  }
  function open(file: string, hook?: (phase: "applied" | "stored" | "committed") => void) {
    const store = new PilotStore(file, operatorSecret, venueId, hook); stores.push(store); return store;
  }
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves pending receipts, witnesses after restart, and independently verifies the payment", () => {
    const file = path(); let store = open(file);
    store.execute(register); store.execute(issue);
    const response = store.execute(transfer), receipt = accepted(response);
    const args = { terms, termsSignature, operation: hex(transfer.operation, 8192), receipt,
      venue: localViewFromWire(store.view(), operator, venueId), operator, recipient: bob, quantity: 40n };
    expect(verifyPilotPayment(args).status).toBe("pending");
    store.close(); store = open(file);
    expect(store.execute(transfer)).toEqual(response);
    const witnessed = store.execute({ id: "witness", kind: "witness" });
    const view = store.view([backing.name]);
    expect(view.state?.directory).toHaveLength(1);
    const state = stateFromWire(view.state), venue = localViewFromWire(view, operator, venueId);
    expect(verifyPilotPayment({ ...args, state, venue }).status).toBe("final");
    expect(verifyPilotPayment({ ...args, state, venue, recipient: alice }).status).toBe("invalid");
    expect(verifyPilotPayment({ ...args, state, venue, quantity: 41n }).status).toBe("invalid");
    expect(() => venue.publish(state.commitment)).toThrow(VenueError);
    const unavailable = { ...venue, witnessedAtSequence: () => { throw new VenueError("offline"); } };
    expect(verifyPilotPayment({ ...args, state, venue: unavailable }).status).toBe("unavailable");
    const tampered = { ...state, snapshots: state.snapshots.map(s => ({ ...s, opLog: s.opLog.slice(0, -1) })) };
    expect(verifyPilotPayment({ ...args, state: tampered, venue }).status).toBe("invalid");
    store.close(); store = open(file);
    expect(store.execute({ id: "witness", kind: "witness" })).toEqual(witnessed);
    expect(store.nextNonce(backing.name, alice)).toBe(1n);
  });

  it("synchronizes two writers and their reads under the database lock", () => {
    const file = path(), a = open(file), b = open(file);
    a.execute(register); b.execute(issue); a.execute(transfer);
    expect(b.nextNonce(backing.name, alice)).toBe(1n);
    b.execute({ id: "first", kind: "witness" });
    a.execute({ id: "second", kind: "witness" });
    const view = b.view();
    expect(view.commitments.map(c => decodeCommitment(hex(c.bytes, 136)).sequence)).toEqual([0n, 1n]);
    expect(view.index).toBe("2");
    expect(a.execute(transfer)).toEqual(b.execute(transfer));
  });

  it("rejects witnessing before registration without preventing later payments", () => {
    const file = path(); let store = open(file);
    const witness = { id: "first", kind: "witness" } as const;
    expect(() => store.execute(witness)).toThrow("register the root before witnessing");
    expect(store.view().index).toBe("0");
    expect(store.view().commitments).toEqual([]);
    store.close(); store = open(file);
    store.execute(register); store.execute(issue);
    const receipt = accepted(store.execute(transfer));
    store.execute(witness);
    const view = store.view();
    expect(view.index).toBe("1");
    expect(verifyPilotPayment({ terms, termsSignature, operation: hex(transfer.operation, 8192),
      receipt, state: stateFromWire(view.state), venue: localViewFromWire(view, operator, venueId),
      operator, recipient: bob, quantity: 40n }).status).toBe("final");
  });

  it.each(["applied", "stored", "committed"] as const)("recovers from failure at %s", phase => {
    const file = path(); let fail = false;
    const store = open(file, at => { if (fail && at === phase) throw new Error("injected I/O failure"); });
    store.execute(register); fail = true;
    expect(() => store.execute(issue)).toThrow("injected");
    fail = false;
    expect(store.nextNonce(backing.name, issuer)).toBe(phase === "committed" ? 1n : 0n);
    const receipt = store.execute(issue);
    store.close();
    expect(open(file).execute(issue)).toEqual(receipt);
  });

  it("rejects identifier conflicts without corrupting accepted state", () => {
    const store = open(path()); store.execute(register); store.execute(issue);
    expect(() => store.execute({ ...transfer, id: issue.id })).toThrow("different content");
    expect(store.nextNonce(backing.name, issuer)).toBe(1n);
    expect(store.nextNonce(backing.name, alice)).toBe(0n);
    expect(store.execute(transfer).kind).toBe("accepted");
  });

  it("refuses another signing identity and detects edited durable responses on reopen", () => {
    const file = path(), store = open(file); store.execute(register); store.execute(issue); store.close();
    expect(() => new PilotStore(file, aliceSecret, venueId)).toThrow("does not match");
    const db = new DatabaseSync(file);
    db.prepare("UPDATE commands SET response=? WHERE id=?").run('{"kind":"registered","backing":"bad"}', "issue");
    db.close();
    expect(() => open(file)).toThrow("replay differs");
  });

  it.each([":memory:", ""])("refuses non-durable SQLite path %s", file => {
    expect(() => new PilotStore(file, operatorSecret, venueId)).toThrow("persistent database path");
  });

  it("copies views and refuses unsupported profiles without changing the journal", () => {
    const store = open(path()); store.execute(register); store.execute(issue); store.execute({ id: "w", kind: "witness" });
    const first = store.view(); first.commitments[0]!.bytes = "bad"; first.state!.snapshots.length = 0;
    expect(store.view().state!.snapshots).toHaveLength(1);
    const other = makeBacking({ ...backing, payout: { thing: "USD", perUnit: 1n, quantumExponent: -2 } });
    expect(() => store.execute({ id: "other", kind: "register", backing: bytesToHex(encodeBacking(other)),
      signature: bytesToHex(signBacking(issuerSecret, other)) })).toThrow("one root");
    expect(store.view().backings).toHaveLength(1);
  });
});

describe("pilot envelopes", () => {
  it("rejects unknown own fields even when they shadow Object.prototype", () => {
    expect(() => parsePilotCommand({ id: "a", kind: "witness", constructor: "hidden option" })).toThrow("unknown");
    expect(() => parsePilotCommand(JSON.parse('{"id":"a","kind":"witness","__proto__":1}'))).toThrow("unknown");
  });
});
