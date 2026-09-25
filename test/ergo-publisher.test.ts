import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { afterEach, describe, expect, it } from "vitest";
import { makeBacking, signBacking } from "../src/backing.js";
import type { SignedBacking } from "../src/pool/segment.js";
import { encodeCommitment, signCommitment, type Commitment } from "../src/commitment.js";
import { ErgoVenue } from "../src/ergo.js";
import { attributeBlock, frameTransaction, MINER_FEE_TREE_HEX } from "../src/ergo-profile.js";
import {
  DEFAULT_ERGO_FEE, DEFAULT_MIN_VALUE_PER_BYTE, ergoNodePublisher, ErgoPublisher, payToPublicKeyTree, readPlainBox, verifyErgoProof,
  type ErgoPublishingSupplier, type NodeRequestInit,
} from "../src/ergo-publisher.js";
import { operatorAt, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { signRevocation } from "../src/revocation.js";
import { VenueError } from "../src/venue.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { BranchSupplier, Chain, hex, MempoolNode, plainBox, SCRIPTS, type Block } from "./ergo-chain.js";
import { CONFIG, DOMAIN, Oracle } from "./pool-support.js";
import { KEYS, SECRETS } from "./support.js";

// The runtime's Ergo wallet (ergo-publisher.ts): proveDlog proofs on
// @noble/curves, one record per transaction in the profile's grammar,
// broadcast through untrusted suppliers, and read back only through the
// verifying view. The mempool node in ergo-chain.ts reads what it is sent
// independently of the publisher and admits only balanced transactions
// whose every input it holds and whose every proof verifies.

const sha = (text: string): Uint8Array => createHash("sha256").update(text).digest();
const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
const SECRET = sha("moe/test/ergo-publisher/key");
const PUBLIC = secp256k1.getPublicKey(SECRET, true);
const TREE = payToPublicKeyTree(PUBLIC);
const HEIGHT = 900_010n;
const SUBJECT = new Uint8Array(32).fill(0x51);
const RECORD = new Uint8Array(136).map((_, i) => i);
const request = (record = RECORD, location = SCRIPTS[1], height = HEIGHT) => ({ location, subject: SUBJECT, record, height });

function node(name = "node"): MempoolNode {
  return new MempoolNode(name, verifyErgoProof);
}
function funded(values: readonly bigint[], name?: string): MempoolNode {
  const n = node(name);
  for (const value of values) n.fund(plainBox(TREE, value, HEIGHT - 5n));
  return n;
}
const publisher = (suppliers: readonly ErgoPublishingSupplier[], options: { fee?: bigint } = {}): ErgoPublisher =>
  new ErgoPublisher({ secretKey: SECRET, suppliers, ...options });

describe("proveDlog proofs are Ergo's", () => {
  // Signed by the vendored sigma-rust release build (Wallet.sign_message_using_p2pk) with this key.
  const KNOWN = [
    ["", "5b4965c54f5a34cb8d7ce3b69fc45b7e6c0bc796096fd3ebf4cdf092ade298fdd88f25d10b2e9898104ccc2b5d6297fd8de9839ac59a2afd"],
    ["6d6f65", "c01251c78fce4bfb391bfb2090e6ec760177174062de99ea591c98adfd0e967a1e17de13a18ea76c8e7885a21a8805bc0a14c4a90e8da770"],
  ] as const;

  it("accepts sigma-rust's proofs and refuses every variation of them", () => {
    expect(hex(PUBLIC)).toBe("024aaf4f4e400e8ecbde8933a94511f8dd94c8fdd0c58c1ee5021f1be7b885a30b");
    for (const [message, proof] of KNOWN) {
      const m = Buffer.from(message, "hex"), p = Buffer.from(proof, "hex");
      expect(verifyErgoProof(PUBLIC, m, p)).toBe(true);
      expect(verifyErgoProof(PUBLIC, Buffer.concat([m, Uint8Array.of(0)]), p)).toBe(false);
      expect(verifyErgoProof(secp256k1.getPublicKey(sha("other"), true), m, p)).toBe(false);
      for (const at of [0, 23, 24, 55]) { const bad = Uint8Array.from(p); bad[at]! ^= 1; expect(verifyErgoProof(PUBLIC, m, bad)).toBe(false); }
      expect(verifyErgoProof(PUBLIC, m, p.subarray(0, 55))).toBe(false);
      expect(verifyErgoProof(PUBLIC, m, Buffer.concat([p, Uint8Array.of(0)]))).toBe(false);
      // z at or above the group order is not a response, even where it reduces to one.
      const z = BigInt(`0x${Buffer.from(p.subarray(24)).toString("hex")}`) + secp256k1.CURVE.n;
      if (z < 1n << 256n) expect(verifyErgoProof(PUBLIC, m, Buffer.concat([p.subarray(0, 24), Buffer.from(z.toString(16).padStart(64, "0"), "hex")]))).toBe(false);
    }
  });

  it("refuses keys that are not scalars below the order, and a fee or per-byte minimum the network would refuse", () => {
    for (const secretKey of [new Uint8Array(32), new Uint8Array(31).fill(1),
      Buffer.from(secp256k1.CURVE.n.toString(16).padStart(64, "0"), "hex")]) {
      expect(() => new ErgoPublisher({ secretKey, suppliers: [node()] })).toThrow(VenueError);
    }
    // The fee box's minimum: its 105-byte tree, value, height and counts, the transaction id and its index.
    expect(() => publisher([node()], { fee: 50_000n })).toThrow(/below its box's minimum/);
    expect(() => new ErgoPublisher({ secretKey: SECRET, suppliers: [node()], minValuePerByte: 0n })).toThrow(VenueError);
  });
});

describe("a publication is one record in the profile's grammar", () => {
  it("carries the record at its location with the minimum value, change to the key and the fee, balanced and signed", async () => {
    const n = funded([10_000_000n]);
    const publication = await publisher([n]).publish(request());
    expect(hex(publication.id)).toBe(hex(hash(publication.unsigned)));
    expect(n.pool).toHaveLength(1);
    // The profile's framer and attribution read it as one kind-1 object.
    const outputs = frameTransaction(publication.unsigned)!;
    expect(outputs.map(o => hex(o.ergoTree))).toEqual([hex(SCRIPTS[1]), hex(TREE), MINER_FEE_TREE_HEX]);
    const objects = attributeBlock(new Chain().profile(3n), n.pool);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ kind: 1, ordinal: 0n });
    expect(hex(objects[0]!.subject)).toBe(hex(SUBJECT));
    expect(hex(objects[0]!.record)).toBe(hex(RECORD));
    // Output 0 pays exactly the network minimum for its full box; the fee box is the fee.
    const recordBox = n.boxes.get(hex(publication.recordBox))!;
    expect(readPlainBox(recordBox, SCRIPTS[1])).toBeUndefined(); // it has registers: not a box the publisher spends
    const recordValue = DEFAULT_MIN_VALUE_PER_BYTE * BigInt(recordBox.length);
    expect(publication.change!.value).toBe(10_000_000n - recordValue - DEFAULT_ERGO_FEE);
    expect(hex(hash(publication.change!.bytes))).toBe(hex(publication.change!.id));
    expect(n.boxes.has(hex(publication.change!.id))).toBe(true);
  });

  it("gives change below the minimum to the fee, and refuses boxes that cannot pay", async () => {
    const sized = funded([10_000_000n]), recordBox = (await publisher([sized]).publish(request())).recordBox;
    const recordAndFee = DEFAULT_MIN_VALUE_PER_BYTE * BigInt(sized.boxes.get(hex(recordBox))!.length) + DEFAULT_ERGO_FEE;
    const n = funded([recordAndFee + 1_000n]);
    const publication = await publisher([n]).publish(request());
    expect(publication.change).toBeUndefined();
    expect(frameTransaction(publication.unsigned)!.map(o => hex(o.ergoTree))).toEqual([hex(SCRIPTS[1]), MINER_FEE_TREE_HEX]);
    await expect(publisher([funded([recordAndFee - 1n])]).publish(request())).rejects.toThrow(/do not cover/);
    await expect(publisher([node()]).publish(request())).rejects.toThrow(/no supplier offered/);
  });

  it("refuses a record that does not fit one box, and malformed requests", async () => {
    const p = publisher([funded([100_000_000_000n])]);
    await expect(p.publish(request(new Uint8Array(4_100)))).rejects.toThrow(/does not fit one box/);
    await expect(p.publish({ ...request(), subject: new Uint8Array(31) })).rejects.toThrow(VenueError);
    await expect(p.publish({ ...request(), height: -1n })).rejects.toThrow(VenueError);
  });
});

describe("suppliers are untrusted", () => {
  it("spends only plain boxes of the key that hash to their ids, created at or below the height", async () => {
    const other = payToPublicKeyTree(secp256k1.getPublicKey(sha("stranger"), true));
    const good = plainBox(TREE, 5_000_000n, HEIGHT);
    const offered = [
      plainBox(other, 900_000_000n, HEIGHT),
      plainBox(TREE, 800_000_000n, HEIGHT + 1n),
      Buffer.concat([plainBox(TREE, 700_000_000n, HEIGHT), Uint8Array.of(0)]),
      Uint8Array.from(plainBox(TREE, 600_000_000n, HEIGHT)).map((b, i, a) => (i === a.length - 34 ? 1 : b)), // a token count
      good,
    ];
    const seen: Uint8Array[][] = [];
    const lying: ErgoPublishingSupplier = {
      name: "liar", unspentBoxes: async () => offered, hasBox: async () => { throw new Error("no answer"); }, hasTransaction: async () => { throw new Error("no answer"); },
      submit: async (_signed, _id) => { throw new Error("refused"); },
    };
    const n = node();
    n.fund(good);
    const spy: ErgoPublishingSupplier = { name: "spy", unspentBoxes: async t => n.unspentBoxes(t), hasBox: b => n.hasBox(b), hasTransaction: id => n.hasTransaction(id),
      submit: async (s, id) => { seen.push([s]); return n.submit(s, id); } };
    const publication = await publisher([lying, spy]).publish(request());
    expect(publication.inputs.map(hex)).toEqual([hex(hash(good))]);
    expect(seen).toHaveLength(1);
  });

  it("passes over suppliers that throw, time out or answer nonsense, and fails only when none accepts", async () => {
    const n = funded([10_000_000n]);
    const broken: ErgoPublishingSupplier = {
      name: "broken", unspentBoxes: async () => { throw new Error("down"); }, hasBox: async () => { throw new Error("down"); }, hasTransaction: async () => { throw new Error("down"); },
      submit: async () => { throw new Error("down"); },
    };
    const nonsense = { name: "nonsense", unspentBoxes: async () => "boxes", hasBox: async () => "yes", hasTransaction: async () => "yes", submit: async () => undefined } as unknown as ErgoPublishingSupplier;
    const slow: ErgoPublishingSupplier = { name: "slow", unspentBoxes: () => new Promise(() => {}), hasBox: () => new Promise(() => {}), hasTransaction: () => new Promise(() => {}), submit: () => new Promise(() => {}) };
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [broken, slow, n], timeoutMs: 50 });
    await p.publish(request());
    expect(n.pool).toHaveLength(1);
    // A supplier that says it accepted is believed: acceptance proves nothing, and only a read counts.
    const q = new ErgoPublisher({ secretKey: SECRET, suppliers: [nonsense, funded([10_000_000n])], timeoutMs: 50 });
    await expect(q.publish(request())).resolves.toBeDefined();
    const refusing = funded([10_000_000n]);
    refusing.refuse = () => true;
    await expect(publisher([broken, refusing]).publish(request())).rejects.toThrow(/no supplier accepted/);
  });

  it("spends no box a supplier invents where another answers that it lacks it", async () => {
    const n = funded([10_000_000n]);
    const invented = plainBox(TREE, 1n << 62n, HEIGHT);
    const liar: ErgoPublishingSupplier = {
      name: "liar", unspentBoxes: async () => [invented], hasBox: async id => hex(id) === hex(hash(invented)) || n.hasBox(id),
      hasTransaction: id => n.hasTransaction(id), submit: async () => {},
    };
    const publication = await publisher([n, liar]).publish(request());
    expect(publication.inputs.map(hex)).not.toContain(hex(hash(invented)));
    expect(n.pool).toHaveLength(1);
    // The price: a supplier denying every box stops publication, visibly, rather than letting a false box through.
    const denier: ErgoPublishingSupplier = { name: "denier", unspentBoxes: async () => [], hasBox: async () => false, hasTransaction: async () => false, submit: async () => {} };
    await expect(publisher([funded([10_000_000n]), denier]).publish(request())).rejects.toThrow(/no supplier offered/);
  });
});

describe("a publication is sent once, and publications chain", () => {
  it("returns the transaction already sent for a record, sending it again only while no supplier shows its record box or holds it", async () => {
    const funding = plainBox(TREE, 10_000_000n, HEIGHT - 5n), n = node();
    n.fund(funding);
    const p = publisher([n]);
    const first = await p.publish(request());
    const again = await p.publish(request());
    expect(hex(again.id)).toBe(hex(first.id));
    expect(n.submitted).toHaveLength(1); // the record box is in the mempool: nothing is sent
    n.boxes.delete(hex(first.recordBox));
    await p.publish(request());
    expect(n.submitted).toHaveLength(1); // the node still holds the transaction
    const pooled = n.pool.splice(0); // and now it does not: its input is unspent again
    n.boxes.clear();
    n.fund(funding);
    await p.publish(request());
    expect(n.submitted).toEqual([hex(first.id), hex(first.id)]);
    expect(pooled).toHaveLength(1);
  });

  it("keeps a transaction whose acceptance it never heard, and sends the same one again", async () => {
    const n = funded([10_000_000n]);
    // The node takes the transaction, and the answer is lost.
    const lossy: ErgoPublishingSupplier = { name: "lossy", unspentBoxes: t => n.unspentBoxes(t), hasBox: id => n.hasBox(id), hasTransaction: id => n.hasTransaction(id),
      submit: async (s, id) => { await n.submit(s, id).catch(() => {}); throw new Error("connection reset"); } };
    const p = publisher([lossy]);
    await expect(p.publish(request())).rejects.toThrow(/kept and sent again/);
    // The retry finds the record box the lost submission created, and sends nothing.
    const retried = await p.publish(request());
    expect(n.submitted).toEqual([hex(retried.id)]);
    expect(n.pool).toHaveLength(1);
    expect(p.unsettled).toBe(1);
  });

  it("survives an unreachable supplier without building a second transaction", async () => {
    const n = funded([10_000_000n]);
    let down = false;
    const flaky: ErgoPublishingSupplier = {
      name: "flaky", unspentBoxes: t => (down ? Promise.reject(new Error("down")) : n.unspentBoxes(t)),
      hasBox: id => (down ? Promise.reject(new Error("down")) : n.hasBox(id)),
      hasTransaction: id => (down ? Promise.reject(new Error("down")) : n.hasTransaction(id)), submit: (s, id) => (down ? Promise.reject(new Error("down")) : n.submit(s, id)),
    };
    const p = publisher([flaky]);
    const first = await p.publish(request());
    n.boxes.delete(hex(first.recordBox)); // not shown: a retry sends it again
    down = true;
    await expect(p.publish(request())).rejects.toThrow(/kept and sent again/);
    down = false;
    expect(hex((await p.publish(request())).id)).toBe(hex(first.id));
    expect(n.pool).toHaveLength(1);
    expect(new Set(n.submitted)).toEqual(new Set([hex(first.id)]));
  });

  it("sends a dropped transaction again before the one that spends its change", async () => {
    const funding = plainBox(TREE, 10_000_000n, HEIGHT - 5n), n = node();
    n.fund(funding);
    const p = publisher([n]);
    const dropped = await p.publish(request());
    // The network forgot the first transaction: its input is unspent again and its outputs gone.
    n.pool.splice(0);
    n.boxes.clear();
    n.fund(funding);
    const next = await p.publish(request(new Uint8Array(136).fill(7)));
    expect(next.inputs.map(hex)).toEqual([hex(dropped.change!.id)]);
    expect(n.submitted.slice(-2)).toEqual([hex(dropped.id), hex(next.id)]);
    expect(n.pool).toHaveLength(2);
  });

  it("rebuilds a transaction that can never land, and builds nothing further on its change", async () => {
    const funding = plainBox(TREE, 10_000_000n, HEIGHT - 5n), n = node();
    n.fund(funding);
    const invented = plainBox(TREE, 1n << 40n, HEIGHT);
    // The honest node fails to answer once, while a liar offers a box that does not exist.
    let silent = true;
    const honest: ErgoPublishingSupplier = { name: "honest", unspentBoxes: t => n.unspentBoxes(t),
      hasBox: id => (silent ? (silent = false, Promise.reject(new Error("500"))) : n.hasBox(id)),
      hasTransaction: id => n.hasTransaction(id), submit: (s, id) => n.submit(s, id) };
    const liar: ErgoPublishingSupplier = { name: "liar", unspentBoxes: async () => [invented], hasBox: async id => { if (hex(id) === hex(hash(invented))) return true; throw new Error("no answer"); },
      hasTransaction: async () => false,
      submit: async () => { throw new Error("refused"); } };
    const p = publisher([honest, liar]);
    await expect(p.publish(request())).rejects.toThrow(/kept and sent again/);
    // A second record is not built on the doomed transaction's change: that change is not anyone's box.
    // The retry sees the invented input denied and rebuilds on the real funding.
    const repaired = await p.publish(request());
    expect(repaired.inputs.map(hex)).toEqual([hex(hash(funding))]);
    const second = await p.publish(request(new Uint8Array(136).fill(8)));
    expect(second.inputs.map(hex)).toEqual([hex(repaired.change!.id)]);
    expect(n.pool).toHaveLength(2);
    expect(p.unsettled).toBe(2);
  });

  it("rebuilds keeping every input still shown, so the old and new transactions conflict", async () => {
    const a = plainBox(TREE, 700_000n, HEIGHT - 5n), b = plainBox(TREE, 800_000n, HEIGHT - 5n), n = node();
    n.fund(a);
    n.fund(b);
    const p = publisher([n]);
    const first = await p.publish(request());
    expect(first.inputs.map(hex).sort()).toEqual([hex(hash(a)), hex(hash(b))].sort());
    // The network dropped it, and one of its inputs is gone for good; the other is still there.
    n.pool.splice(0);
    n.boxes.clear();
    n.fund(b);
    n.fund(plainBox(TREE, 5_000_000n, HEIGHT - 5n));
    const rebuilt = await p.publish(request());
    expect(rebuilt.inputs.map(hex)).toContain(hex(hash(b)));
    expect(rebuilt.inputs.map(hex)).not.toContain(hex(hash(a)));
    expect(n.pool).toHaveLength(1);
  });

  it("takes a landed transaction whose record box was swept as published, not as one whose inputs are gone", async () => {
    const n = funded([10_000_000n]);
    const p = publisher([n]);
    const first = await p.publish(request());
    n.take(); // mined
    n.boxes.delete(hex(first.recordBox)); // whoever holds the location spent it
    n.refuse = () => true; // its inputs are spent: sending it again is refused
    expect(hex((await p.publish(request())).id)).toBe(hex(first.id));
    expect(new Set(n.submitted)).toEqual(new Set([hex(first.id)]));
  });

  it("rebuilds a transaction refused for something other than its inputs on the same inputs, at the new height", async () => {
    const n = funded([10_000_000n]);
    const p = publisher([n]);
    n.refuse = () => true; // say, a node that will not take this height
    await expect(p.publish(request())).rejects.toThrow(/kept and sent again/);
    const refused = n.submitted[0]!;
    n.refuse = id => id === refused; // the old transaction stays refused
    const later = await p.publish({ ...request(), height: HEIGHT + 1n });
    expect(hex(later.id)).not.toBe(refused);
    expect(later.inputs).toHaveLength(1);
    expect(n.pool).toHaveLength(1);
    expect(frameTransaction(later.unsigned)).toBeDefined();
  });

  it("spends its own change before any index shows it, and never one box twice under concurrent calls", async () => {
    const n = funded([10_000_000n]);
    n.mempoolAware = false; // a stale index: it still offers the spent box and not the change
    const p = publisher([n]);
    const [a, b] = await Promise.all([p.publish(request()), p.publish(request(new Uint8Array(136).fill(9)))]);
    expect(b.inputs.map(hex)).toEqual([hex(a.change!.id)]);
    const c = await p.publish(request(new Uint8Array(96).fill(3), SCRIPTS[3]));
    expect(c.inputs.map(hex)).toEqual([hex(b.change!.id)]);
    expect(n.pool).toHaveLength(3);
  });
});

// --- Through the verifying view ---------------------------------------------------------------------------

const chain = new Chain();
const DEPTH = 3n;
const PROFILE = chain.profile(DEPTH);

/** A chain whose blocks carry what the mempool node accepted, served to the view. */
class Network {
  readonly node = funded([10_000_000_000n], "mempool");
  tip: Block = chain.anchor;
  readonly supplier = new BranchSupplier("chain", chain.anchor, chain);
  mine(count = 1): void {
    for (let i = 0; i < count; i++) { this.tip = chain.mine(this.tip, this.node.take()); }
    this.supplier.tip = this.tip;
  }
}
async function view(network: Network, withPublisher = true): Promise<ErgoVenue> {
  const v = new ErgoVenue(PROFILE, chain.context, {}, withPublisher ? publisher([network.node]) : undefined);
  await v.sync([network.supplier]);
  return v;
}
const commitmentOf = (sequence: bigint, fill: number): Commitment =>
  signCommitment(SECRETS.operator, sequence, new Uint8Array(32).fill(fill));

describe("the view publishes through its wallet and holds only what it reads", () => {
  it("publishes a commitment, a replacement and a revocation, each held once its block is final", async () => {
    const network = new Network();
    network.mine(Number(DEPTH) + 2);
    const v = await view(network);
    // Published now, included in the next block; the walk floors the lead at twice the lag plus one.
    const including = v.witnessedIndex() + DEPTH + 1n, effective = including + 2n * v.lag() + 1n;
    const ruled = makeBacking({ obligor: KEYS.backer2, payout: { thing: "USD", quantumExponent: -2, perUnit: 100n }, reliance: [],
      evidence: { setting: "transparent", operator: KEYS.operator, silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
        replacementRule: KEYS.backer2, witnessing: { venue: v.id, interval: 5n } } });
    const unsigned = { role: ROLE_OPERATOR, successor: KEYS.carol, predecessor: ruled.name, effective,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(ruled.name, unsigned);
    const r: Replacement = { ...unsigned, signature: ed25519.sign(message, SECRETS.backer2), successorSignature: ed25519.sign(message, SECRETS.carol) };
    const c = commitmentOf(1n, 0xaa), revocation = signRevocation(SECRETS.backer);
    await v.publish(c);
    await v.publishReplacement(ruled.name, r);
    await v.publishRevocation(revocation);
    expect(network.node.pool).toHaveLength(3);
    // Accepted is not held: nothing is read before the including block is final.
    await v.sync([network.supplier]);
    expect(v.latestFor(KEYS.operator)).toBeUndefined();
    network.mine(Number(DEPTH));
    await v.sync([network.supplier]);
    expect(v.latestFor(KEYS.operator)).toBeUndefined();
    network.mine();
    await v.sync([network.supplier]);
    expect(v.witnessedIndex()).toBe(including);
    expect(v.latestFor(KEYS.operator)).toEqual(c);
    expect(v.witnessedAtSequence(KEYS.operator, 1n)).toBe(including);
    expect(v.replacementsFor(ruled.name)).toEqual([{ replacement: r, at: including }]);
    network.mine(Number(effective - including));
    await v.sync([network.supplier]);
    expect(v.witnessedIndex()).toBe(effective);
    expect(hex(operatorAt(ruled, v, effective - 1n))).toBe(hex(KEYS.operator));
    expect(hex(operatorAt(ruled, v, effective))).toBe(hex(KEYS.carol));
    expect(v.revocationsFor(KEYS.backer)).toEqual([{ revocation, at: including }]);
  });

  it("refuses to publish unsigned records, and before a settled snapshot", async () => {
    const network = new Network();
    const unsynced = new ErgoVenue(PROFILE, chain.context, {}, publisher([network.node]));
    expect(() => unsynced.publish(commitmentOf(1n, 1))).toThrow(/no settled snapshot/);
    network.mine(5);
    const v = await view(network);
    const c = commitmentOf(1n, 1);
    expect(() => v.publish({ ...c, signature: new Uint8Array(64) })).toThrow(/signature invalid/);
    const revocation = signRevocation(SECRETS.backer);
    expect(() => v.publishRevocation({ ...revocation, obligor: KEYS.backer2 })).toThrow(/not signed/);
    expect(network.node.submitted).toHaveLength(0);
  });

  it("settles its wallet as it reads: a publication is forgotten once its record is final, and its inputs once it landed", async () => {
    const network = new Network();
    network.mine(5);
    const p = publisher([network.node]);
    const v = new ErgoVenue(PROFILE, chain.context, {}, p);
    await v.sync([network.supplier]);
    await v.publish(commitmentOf(1n, 2));
    const second = await p.publish({ location: SCRIPTS[1], subject: KEYS.operator, record: encodeCommitment(commitmentOf(2n, 3)), height: network.tip.height });
    expect(p.unsettled).toBe(2);
    network.mine(Number(DEPTH));
    await v.sync([network.supplier]);
    await p.settle(() => false); // the view settles in the publisher's queue: wait for it
    expect(p.unsettled).toBe(2); // included, not yet final
    network.mine();
    await v.sync([network.supplier]);
    await p.settle(() => false);
    expect(p.unsettled).toBe(0);
    // Landed change stays the publisher's own, whether or not an index lists it.
    network.node.mempoolAware = false;
    network.node.confirmed.delete(hex(second.change!.id));
    const next = await p.publish({ location: SCRIPTS[1], subject: KEYS.operator, record: new Uint8Array(136).fill(4), height: network.tip.height });
    expect(next.inputs.map(hex)).toEqual([hex(second.change!.id)]);
    expect(network.node.pool).toHaveLength(1);
    // A record the view already holds is not sent again.
    const before = network.node.submitted.length;
    await v.publish(commitmentOf(1n, 2));
    expect(network.node.submitted).toHaveLength(before);
  });
});

const supported = Number(process.versions.node.split(".")[0]) >= 24;
describe.skipIf(!supported)("a pool store publishes on the Ergo view (Node 24)", () => {
  const directories: string[] = [], scratch = resolve("scratch");
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signs its opening, publishes it through the view's wallet and finds it held after the depth", async () => {
    const { PoolStore } = await import("../src/pool/store.js");
    const network = new Network();
    network.mine(6);
    const v = await view(network);
    const terms = (thing: string): SignedBacking => {
      const backing = makeBacking({ obligor: KEYS.backer, payout: { thing, quantumExponent: -2, perUnit: 100n }, reliance: [],
        evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v2", configuration: DOMAIN,
          witnessing: { venue: v.id, interval: 1n }, replacementRule: KEYS.backer } });
      return { backing, signature: signBacking(SECRETS.backer, backing) };
    };
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "ergo-publisher-")); directories.push(directory);
    const store = new PoolStore(join(directory, "state.db"), CONFIG, SECRETS.operator, v, new Oracle());
    try {
      const opening = await store.activate("opening", [terms("EUR")]);
      const published = await store.publish();
      expect(published).toEqual(opening);
      expect(network.node.pool).toHaveLength(1);
      // A retry before inclusion sends the same transaction, not a second record.
      await store.publish();
      expect(new Set(network.node.submitted).size).toBe(1);
      network.mine(Number(DEPTH) + 1);
      await v.sync([network.supplier]);
      expect(v.latestFor(KEYS.operator)).toEqual(opening);
      expect(await store.publish()).toEqual(opening);
      expect(network.node.pool).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("a node as a publishing supplier", () => {
  // A real testnet box of the experiment's throwaway key, as the node's index and UTXO set state it.
  const TREE = "0008cd03eb9432b2aaf72b39f474ea8daec054a85f1b34ed2423aa0731221117f62af749";
  const BOX_ID = "9d9f9c692d414e6f8bbd74fafea11c6c1742ebba2be5c24841a835c6f5c9879d";
  const BOX_BYTES = `90acb3c089c604${TREE}eca4220000553a060beb6098b15b50eaff149ac48b4579c0efacd11ec47c2bee96553d072206`;
  const statement = (changes: Record<string, unknown> = {}): string => `{
    "globalIndex" : 3877053, "inclusionHeight" : 561774, "address" : "3WzLhpY2Dbd8WSbvZTbHS5cbCiJFsfbLFrfoWWEt3GkQJJr6oxi9",
    "spentTransactionId" : null, "spendingProof" : null, "boxId" : ${JSON.stringify(changes.boxId ?? BOX_ID)}, "value" : 19999918708240,
    "ergoTree" : "${TREE}", "assets" : ${JSON.stringify(changes.assets ?? [])}, "creationHeight" : 561772,
    "additionalRegisters" : ${JSON.stringify(changes.additionalRegisters ?? {})},
    "transactionId" : "553a060beb6098b15b50eaff149ac48b4579c0efacd11ec47c2bee96553d0722", "index" : 6 }`;
  const recording = (answer: (url: string) => Response) => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const fetch = async (url: string, init: NodeRequestInit): Promise<Response> => {
      calls.push({ url, ...(init.method === undefined ? {} : { method: init.method }), ...(init.body === undefined ? {} : { body: init.body }) });
      return answer(url);
    };
    return { calls, fetch };
  };

  it("copies plain boxes from the index, bound to their ids, and passes over every other box", async () => {
    const { calls, fetch } = recording(() => new Response(`[${[statement(), statement({ assets: [{ tokenId: "11".repeat(32), amount: 1 }] }),
      statement({ additionalRegisters: { R4: "0e0100" } }), statement({ boxId: "22".repeat(32) })].join(",")}]`));
    const supplier = ergoNodePublisher("http://node", { fetch });
    const boxes = await supplier.unspentBoxes(Buffer.from(TREE, "hex"));
    expect(boxes.map(hex)).toEqual([BOX_BYTES]);
    expect(hex(hash(boxes[0]!))).toBe(BOX_ID);
    expect(calls).toEqual([{ method: "POST", body: JSON.stringify(TREE), url:
      "http://node/blockchain/box/unspent/byErgoTree?offset=0&limit=100&sortDirection=asc&includeUnconfirmed=true&excludeMempoolSpent=true" }]);
    const none = ergoNodePublisher("http://node", { fetch: recording(() => new Response("", { status: 404 })).fetch });
    expect(await none.unspentBoxes(Buffer.from(TREE, "hex"))).toEqual([]);
  });

  it("shows a box only where the bytes served hash to its id", async () => {
    const answer = (bytes: string) => ergoNodePublisher("http://node", { fetch: recording(() => new Response(`{ "boxId" : "${BOX_ID}", "bytes" : "${bytes}" }`)).fetch });
    expect(await answer(BOX_BYTES).hasBox(Buffer.from(BOX_ID, "hex"))).toBe(true);
    expect(await answer(`${BOX_BYTES}00`).hasBox(Buffer.from(BOX_ID, "hex"))).toBe(false);
    const missing = ergoNodePublisher("http://node", { fetch: recording(() => new Response("", { status: 404 })).fetch });
    expect(await missing.hasBox(Buffer.from(BOX_ID, "hex"))).toBe(false);
  });

  it("holds a transaction only where its mempool or its index states it under that id", async () => {
    const id = "ab".repeat(32);
    const answering = (routes: Record<string, string>) => ergoNodePublisher("http://node", { fetch: recording(url => {
      const route = routes[url.slice("http://node".length)];
      return route === undefined ? new Response("", { status: 404 }) : new Response(route);
    }).fetch });
    const idBytes = Buffer.from(id, "hex");
    expect(await answering({ [`/transactions/unconfirmed/byTransactionId/${id}`]: `{ "id" : "${id}" }` }).hasTransaction(idBytes)).toBe(true);
    expect(await answering({ [`/blockchain/transaction/byId/${id}`]: `{ "id" : "${id}", "inclusionHeight" : 5 }` }).hasTransaction(idBytes)).toBe(true);
    expect(await answering({ [`/blockchain/transaction/byId/${id}`]: `{ "id" : "${"cd".repeat(32)}" }` }).hasTransaction(idBytes)).toBe(false);
    expect(await answering({}).hasTransaction(idBytes)).toBe(false);
  });

  it("takes a submission as accepted only where the node answers with the transaction's id", async () => {
    const id = new Uint8Array(32).fill(0xab);
    const { calls, fetch } = recording(() => new Response(`"${hex(id)}"`));
    await ergoNodePublisher("http://node", { fetch }).submit(Uint8Array.of(1, 2, 3), id);
    expect(calls).toEqual([{ url: "http://node/transactions/bytes", method: "POST", body: '"010203"' }]);
    await expect(ergoNodePublisher("http://node", { fetch }).submit(Uint8Array.of(1), new Uint8Array(32))).rejects.toThrow(/did not accept/);
    const refusing = recording(() => new Response('{ "error" : 400, "reason" : "bad.request", "detail" : "Can not parse transaction bytes: null" }', { status: 400 }));
    await expect(ergoNodePublisher("http://node", { fetch: refusing.fetch }).submit(Uint8Array.of(0), id)).rejects.toThrow(/400/);
  });
});
