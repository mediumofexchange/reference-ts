import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { afterEach, describe, expect, it } from "vitest";
import { makeBacking, signBacking } from "../src/backing.js";
import type { SignedBacking } from "../src/pool/segment.js";
import { signCommitment, type Commitment } from "../src/commitment.js";
import { ErgoVenue } from "../src/ergo.js";
import { attributeBlock, frameTransaction, MINER_FEE_TREE_HEX } from "../src/ergo-profile.js";
import {
  DEFAULT_ERGO_FEE, DEFAULT_MIN_VALUE_PER_BYTE, ErgoPublisher, payToPublicKeyTree, readPlainBox, verifyErgoProof, type ErgoPublishingSupplier,
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

  it("refuses keys that are not scalars below the order", () => {
    for (const secretKey of [new Uint8Array(32), new Uint8Array(31).fill(1),
      Buffer.from(secp256k1.CURVE.n.toString(16).padStart(64, "0"), "hex")]) {
      expect(() => new ErgoPublisher({ secretKey, suppliers: [node()] })).toThrow(VenueError);
    }
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
      name: "liar", unspentBoxes: async () => offered, hasBox: async () => false,
      submit: async (_signed, _id) => { throw new Error("refused"); },
    };
    const n = node();
    n.fund(good);
    const spy: ErgoPublishingSupplier = { name: "spy", unspentBoxes: async t => n.unspentBoxes(t), hasBox: b => n.hasBox(b),
      submit: async (s, id) => { seen.push([s]); return n.submit(s, id); } };
    const publication = await publisher([lying, spy]).publish(request());
    expect(publication.inputs.map(hex)).toEqual([hex(hash(good))]);
    expect(seen).toHaveLength(1);
  });

  it("passes over suppliers that throw, time out or answer nonsense, and fails only when none accepts", async () => {
    const n = funded([10_000_000n]);
    const broken: ErgoPublishingSupplier = {
      name: "broken", unspentBoxes: async () => { throw new Error("down"); }, hasBox: async () => { throw new Error("down"); },
      submit: async () => { throw new Error("down"); },
    };
    const nonsense = { name: "nonsense", unspentBoxes: async () => "boxes", hasBox: async () => "yes", submit: async () => undefined } as unknown as ErgoPublishingSupplier;
    const slow: ErgoPublishingSupplier = { name: "slow", unspentBoxes: () => new Promise(() => {}), hasBox: () => new Promise(() => {}), submit: () => new Promise(() => {}) };
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
});

describe("a publication is sent once, and publications chain", () => {
  it("returns the transaction already sent for a record, rebroadcasting it only while no supplier shows its record box", async () => {
    const n = funded([10_000_000n]);
    const p = publisher([n]);
    const first = await p.publish(request());
    const again = await p.publish(request());
    expect(hex(again.id)).toBe(hex(first.id));
    expect(n.submitted).toHaveLength(1); // the record box is in the mempool: nothing is sent
    n.boxes.delete(hex(first.recordBox));
    await p.publish(request());
    expect(n.submitted).toEqual([hex(first.id), hex(first.id)]);
    expect(n.pool).toHaveLength(1);
  });

  it("builds anew once no supplier accepts or shows the old transaction", async () => {
    const n = funded([10_000_000n]);
    const p = publisher([n]);
    const first = await p.publish(request());
    // The node dropped the transaction: its inputs are back and its outputs gone.
    n.pool.splice(0);
    n.boxes.clear();
    const funding = plainBox(TREE, 10_000_000n, HEIGHT - 5n);
    n.fund(funding);
    n.refuse = id => id === hex(first.id);
    const rebuilt = await p.publish(request());
    expect(hex(rebuilt.id)).not.toBe(hex(first.id));
    expect(rebuilt.inputs.map(hex)).toEqual([hex(hash(funding))]);
    expect(n.submitted).toEqual([hex(first.id), hex(first.id), hex(rebuilt.id)]);
    expect(n.pool).toHaveLength(1);
  });

  it("forgets change and spends of a transaction the network dropped once a new one cannot be sent", async () => {
    const n = funded([10_000_000n]);
    const p = publisher([n]);
    const dropped = await p.publish(request());
    n.pool.splice(0);
    n.boxes.clear();
    const funding = plainBox(TREE, 5_000_000n, HEIGHT - 5n);
    n.fund(funding);
    // The remembered change is larger and chosen first; the node has never seen it.
    const next = await p.publish(request(new Uint8Array(136).fill(7)));
    expect(next.inputs.map(hex)).toEqual([hex(hash(funding))]);
    expect(n.submitted.filter(id => id !== hex(dropped.id))).toHaveLength(2);
    expect(n.pool).toHaveLength(1);
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
    await expect(unsynced.publish(commitmentOf(1n, 1))).rejects.toThrow(/no settled snapshot/);
    network.mine(5);
    const v = await view(network);
    const c = commitmentOf(1n, 1);
    await expect(v.publish({ ...c, signature: new Uint8Array(64) })).rejects.toThrow(/signature invalid/);
    const revocation = signRevocation(SECRETS.backer);
    await expect(v.publishRevocation({ ...revocation, obligor: KEYS.backer2 })).rejects.toThrow(/not signed/);
    expect(network.node.submitted).toHaveLength(0);
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
