import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { decodeRangeAnswer, MAX_RANGE_RECORD_BYTES, type RecordKind } from "../src/record-range.js";
import type { RecordPublisher } from "../src/record-venue.js";
import { encodeCommitment, signCommitment, type Commitment } from "../src/commitment.js";
import { ErgoVenue } from "../src/ergo.js";
import { attributeBlock, collBytes, frameTransaction, MINER_FEE_TREE_HEX } from "../src/ergo-profile.js";
import {
  DEFAULT_ERGO_FEE, DEFAULT_MIN_VALUE_PER_BYTE, ergoNodePublisher, ErgoPublisher, ergoRunCapacity, payToPublicKeyTree, readPlainBox, verifyErgoProof,
  type ErgoPublishingSupplier, type ErgoPublisherPersistence, type NodeRequestInit,
} from "../src/ergo-publisher.js";
import { VenueError } from "../src/venue-error.js";
import { BranchSupplier, Chain, hex, MiningSupplier, MempoolNode, plainBox, plainOutput, rawOutput, SCRIPTS, transaction, type Block } from "./ergo-chain.js";
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
const request = (record: Uint8Array = RECORD, location: Uint8Array = SCRIPTS[1], height = HEIGHT) => ({ location, subject: SUBJECT, record, height });

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

describe("durable publisher exact retry", () => {
  const storage = () => {
    const state = { text: undefined as string | undefined, fail: false, uncertain: false };
    const persistence: ErgoPublisherPersistence = {
      load: () => state.text, guard: () => {}, save: text => {
        if (state.fail) throw new Error("disk failure"); state.text = text;
        if (state.uncertain) throw new Error("commit response lost");
      },
    };
    return { state, persistence };
  };
  it("reopens after a lost reply and retries dependent transactions with identical signed bytes", async () => {
    const { persistence } = storage(), n = funded([10_000_000n]), funding = [...n.boxes.values()];
    const sent: string[] = [];
    const supplier: ErgoPublishingSupplier = { name: "lost", unspentBoxes: t => n.unspentBoxes(t), hasBox: id => n.hasBox(id),
      hasTransaction: id => n.hasTransaction(id), submit: async (bytes, id) => { sent.push(hex(bytes)); await n.submit(bytes, id); throw new Error("lost reply"); } };
    const first = new ErgoPublisher({ secretKey: SECRET, suppliers: [supplier], persistence });
    await expect(first.publish(request())).rejects.toThrow(/kept and sent again/);
    const parent = await first.publish(request());
    await expect(first.publish(request(new Uint8Array(100).fill(8)))).rejects.toThrow(/kept and sent again/);
    const child = await first.publish(request(new Uint8Array(100).fill(8)));
    n.pool.splice(0); n.boxes.clear(); for (const bytes of funding) n.fund(bytes);
    const second = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    const retried = await second.publish(request(new Uint8Array(100).fill(8)));
    expect(retried.signed).toEqual(child.signed); expect(retried.id).toEqual(child.id);
    expect(n.submitted.slice(-2)).toEqual([hex(parent.id), hex(child.id)]);
    expect(sent).toEqual([hex(parent.signed), hex(child.signed)]);
    // Public return values never mutate the retained transaction or next snapshot.
    retried.signed.fill(0); retried.change!.bytes.fill(0);
    expect((await second.publish(request(new Uint8Array(100).fill(8)))).signed).toEqual(child.signed);
  });

  it("retains settled change after restart, and releases a settled publication's inputs", async () => {
    const { persistence } = storage(), n = funded([10_000_000n]);
    const first = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    const published = await first.publish(request());
    await first.settle(() => true);
    n.unspentBoxes = async () => []; // the index no longer supplies the settled change
    const reopened = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    expect((await reopened.publish(request(new Uint8Array(100).fill(2)))).inputs).toEqual([published.change!.id]);

    const separate = storage(), refusing = funded([10_000_000n]); refusing.refuse = () => true;
    const firstInputs: string[] = [], submit = refusing.submit.bind(refusing);
    refusing.submit = async (signed, id) => { firstInputs.push(hex(signed.subarray(1, 33))); return submit(signed, id); };
    const reserved = new ErgoPublisher({ secretKey: SECRET, suppliers: [refusing], persistence: separate.persistence });
    await expect(reserved.publish(request())).rejects.toThrow(/kept and sent again/);
    // Another publisher's transaction carried the record, and settling asks no supplier whether this one landed: its
    // change stays the publisher's until a build finds it gone, and its input is released.
    await reserved.settle(() => true);
    const after = new ErgoPublisher({ secretKey: SECRET, suppliers: [refusing], persistence: separate.persistence });
    expect(after.unsettled).toBe(0);
    await expect(after.publish(request(new Uint8Array(100).fill(3)))).rejects.toThrow(/kept and sent again/);
    expect(firstInputs[1]).not.toBe(firstInputs[0]); // the unlanded change
    // That change is gone, so the next attempt spends the released input again: it conflicts with the first.
    await expect(after.publish(request(new Uint8Array(100).fill(3)))).rejects.toThrow(/kept and sent again/);
    expect(firstInputs.slice(2)).toEqual([firstInputs[1], firstInputs[0]]);
  });

  it("fails before send, poisons uncertain state and keeps the old reservation when rebuilding fails", async () => {
    const { persistence, state } = storage(), n = funded([10_000_000n]);
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    state.fail = true;
    await expect(p.publish(request())).rejects.toThrow("disk failure"); expect(n.submitted).toHaveLength(0);
    state.fail = false;
    await expect(p.publish(request())).rejects.toThrow(/reopen from durable state/);
    const next = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    const first = await next.publish(request()), durable = state.text;
    n.pool.splice(0); n.boxes.clear(); n.refuse = () => true;
    await expect(next.publish(request())).rejects.toThrow(/no supplier offered/);
    expect(next.unsettled).toBe(1); expect(state.text).toBe(durable);
    const reopened = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    expect(reopened.unsettled).toBe(1); expect(first.id).toHaveLength(32);
  });

  it("refuses wrong keys, policy and corrupted saved transactions or reservations", async () => {
    const { persistence, state } = storage(), n = funded([10_000_000n]);
    await new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence }).publish(request());
    const saved = state.text!;
    expect(() => new ErgoPublisher({ secretKey: sha("other funding key"), suppliers: [n], persistence })).toThrow(/saved publisher state/);
    expect(() => new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence, fee: DEFAULT_ERGO_FEE + 1n })).toThrow(/saved publisher state/);
    for (const mutate of [
      (s: any) => { s.pending[0].publication.signed.bytes = `00${s.pending[0].publication.signed.bytes.slice(2)}`; },
      (s: any) => { const proof = s.pending[0].publication.signed; proof.bytes = proof.bytes.slice(0, 68) +
        (parseInt(proof.bytes.slice(68, 70), 16) ^ 1).toString(16).padStart(2, "0") + proof.bytes.slice(70); },
      (s: any) => { s.pending[0].request.record.bytes = "01"; },
      (s: any) => { s.pending[0].inputs[0].value.integer = "99999999"; },
      (s: any) => { s.pending[0].publication.recordBox.bytes = "00".repeat(32); },
      (s: any) => { s.spent = []; },
      (s: any) => { s.created[0].bytes.bytes = "00"; },
    ]) {
      const damaged = JSON.parse(saved); mutate(damaged); state.text = JSON.stringify(damaged);
      expect(() => new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence })).toThrow(/saved publisher|saved publication/);
    }
    state.text = saved;
    expect(new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence }).unsettled).toBe(1);
  });

  it("recovers the committed transaction after an uncertain save without submitting from the poisoned instance", async () => {
    const { persistence, state } = storage(), n = funded([10_000_000n]);
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    state.uncertain = true;
    await expect(p.publish(request())).rejects.toThrow("commit response lost");
    expect(n.submitted).toHaveLength(0);
    state.uncertain = false;
    await expect(p.publish(request())).rejects.toThrow(/reopen from durable state/);
    const reopened = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    const saved = state.text;
    expect(reopened.unsettled).toBe(1);
    await reopened.publish(request());
    expect(state.text).toBe(saved); expect(n.submitted).toHaveLength(1);
  });
});

describe("proveDlog proofs are Ergo's", () => {
  // Signed by the sigma-rust 2f840d3 release build (Wallet.sign_message_using_p2pk) with this key.
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

  it("refuses a record that does not fit one box, and malformed requests as the caller's errors", async () => {
    const p = publisher([funded([100_000_000_000n])]);
    await expect(p.publish(request(new Uint8Array(4_100)))).rejects.toThrow(/does not fit one box/);
    await expect(p.publish({ ...request(), subject: new Uint8Array(31) })).rejects.toThrow(EncodingError);
    await expect(p.publish({ ...request(), height: -1n })).rejects.toThrow(EncodingError);
  });
});

describe("kind-4 publications are one adjacent output run", () => {
  const publicationRequest = (record: Uint8Array) => ({ ...request(record, SCRIPTS[4]), chunked: true });

  it("carries a proof-sized record in one transaction, paying each full box's minimum and chaining its change", async () => {
    const record = Uint8Array.from({ length: 16_000 }, (_, i) => i % 251);
    const n = funded([100_000_000n]), p = publisher([n]);
    const publication = await p.publish(publicationRequest(record));
    const outputs = frameTransaction(publication.unsigned)!;
    const pieces = outputs.slice(0, -2);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(hex(piece.ergoTree)).toBe(hex(SCRIPTS[4]));
      expect(collBytes(piece.registers.R4!)!).toEqual(SUBJECT);
    }
    expect(Buffer.concat(pieces.map(piece => collBytes(piece.registers.R5!)!))).toEqual(Buffer.from(record));
    expect(attributeBlock(new Chain().profile(3n), n.pool)).toMatchObject([{ kind: 4, ordinal: 0n, record }]);
    const recordBoxes = [...n.boxes.values()].filter(bytes => !readPlainBox(bytes, TREE) && !readPlainBox(bytes, Buffer.from(MINER_FEE_TREE_HEX, "hex")));
    expect(recordBoxes).toHaveLength(pieces.length);
    expect(recordBoxes.every(bytes => bytes.length <= 4096)).toBe(true);
    const recordCost = recordBoxes.reduce((sum, bytes) => sum + DEFAULT_MIN_VALUE_PER_BYTE * BigInt(bytes.length), 0n);
    expect(publication.change!.value).toBe(100_000_000n - recordCost - DEFAULT_ERGO_FEE);
    expect(readPlainBox(publication.change!.bytes, TREE)?.id).toEqual(publication.change!.id);
    const again = await p.publish(publicationRequest(record));
    expect(again.signed).toEqual(publication.signed);
    expect(n.submitted).toHaveLength(1);
    const next = await p.publish(request());
    expect(next.inputs).toEqual([publication.change!.id]);
    await expect(publisher([funded([recordCost + DEFAULT_ERGO_FEE - 1n])]).publish(publicationRequest(record))).rejects.toThrow(/do not cover/);
    const dust = await publisher([funded([recordCost + DEFAULT_ERGO_FEE + 1n])]).publish(publicationRequest(record));
    expect(dust.change).toBeUndefined();
    expect(frameTransaction(dust.unsigned)).toHaveLength(pieces.length + 1);
  });

  it("fills each piece's box to the node's 4,096 bytes at its one-byte output index", async () => {
    const n = funded([100_000_000n]);
    const publication = await publisher([n]).publish(publicationRequest(new Uint8Array(3 * 3_982 + 1)));
    const pieces = frameTransaction(publication.unsigned)!.slice(0, -2).map(output => collBytes(output.registers.R5!)!.length);
    expect(pieces).toEqual([3_982, 3_982, 3_982, 1]);
    const boxes = [...n.boxes.values()].filter(bytes => !readPlainBox(bytes, TREE) && !readPlainBox(bytes, Buffer.from(MINER_FEE_TREE_HEX, "hex")));
    expect(boxes.map(bytes => bytes.length)).toEqual([4_096, 4_096, 4_096, 114]);
  });

  it("carries a record of the location's capacity in one transaction at any height and option, and refuses one byte more before remembering or submitting", async () => {
    const capacity = ergoRunCapacity(SCRIPTS[4]);
    // Every option at its longest encoding: a fee whose VLQ is ten bytes, the highest per-byte minimum, the
    // highest height; the change is then shorter than the largest the capacity allows for.
    const fee = 1n << 63n, height = 0xffff_ffffn, options = { fee, minValuePerByte: 1_000_000n };
    const worst = (record: Uint8Array) => ({ ...publicationRequest(record), height });
    const n = funded([fee + 1_000_000_000_000n]), p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], ...options });
    await expect(p.publish(worst(new Uint8Array(capacity + 1)))).rejects.toThrow(/does not fit one transaction$/);
    expect(p.unsettled).toBe(0);
    expect(n.submitted).toEqual([]);
    const record = Uint8Array.from({ length: capacity }, (_, i) => i % 251);
    const fitting = await p.publish(worst(record));
    expect(fitting.signed.length).toBeLessThanOrEqual(98_304);
    expect(fitting.inputs).toHaveLength(1);
    expect(attributeBlock(new Chain().profile(3n), n.pool)).toMatchObject([{ kind: 4, ordinal: 0n, record }]);
    // At the defaults and a current height the same record leaves room to spare.
    const easy = await publisher([funded([100_000_000n])]).publish(publicationRequest(record));
    expect(easy.signed.length).toBeLessThan(fitting.signed.length);
    // The whole frame's bound does not fit, and a longer location tree carries less.
    await expect(publisher([funded([100_000_000n])]).publish(publicationRequest(new Uint8Array(MAX_RANGE_RECORD_BYTES[4])))).rejects.toThrow(/does not fit one transaction$/);
    const sized = (length: number) => Uint8Array.of(0x08, 0x88, 0x1b, ...new Uint8Array(length));
    expect(ergoRunCapacity(sized(3_464))).toBeLessThan(capacity);
    // A tree of 4,016 bytes leaves no room in a box for even an empty piece.
    expect(ergoRunCapacity(Uint8Array.of(0x08, 0xad, 0x1f, ...new Uint8Array(4_013)))).toBe(0);
    expect(() => ergoRunCapacity(new Uint8Array(new SharedArrayBuffer(4)))).toThrow(VenueError);
  });

  it("takes only the inputs the outputs leave room for, so a long record is never refused for the transaction's size", async () => {
    const capacity = ergoRunCapacity(SCRIPTS[4]), fee = 1n << 63n, height = 0xffff_ffffn;
    const worst = (length: number) => ({ ...publicationRequest(new Uint8Array(length)), height });
    const two = () => {
      const n = funded([fee + 50_000_000_000n, 1_000_000_000_000n]);
      return new ErgoPublisher({ secretKey: SECRET, suppliers: [n], fee, minValuePerByte: 1_000_000n });
    };
    // Paying for this run takes both boxes, but the outputs leave room for one input: the boxes do not cover it.
    await expect(two().publish(worst(capacity))).rejects.toThrow(/do not cover/);
    // Eight pieces fewer leave room for both.
    const shorter = await two().publish(worst(capacity - 8 * 4_000));
    expect(shorter.inputs).toHaveLength(2);
    expect(shorter.signed.length).toBeLessThanOrEqual(98_304);
  });

  it("does not reassemble interrupted, reordered, truncated or cross-transaction pieces into the original record", async () => {
    const record = Uint8Array.from({ length: 15_600 }, (_, i) => i % 251), n = funded([100_000_000n]);
    const publication = await publisher([n]).publish(publicationRequest(record));
    const pieces = frameTransaction(publication.unsigned)!.slice(0, -2)
      .map(output => rawOutput(output.ergoTree, [output.registers.R4!, output.registers.R5!]));
    const profile = new Chain().profile(3n);
    const variants = [
      [transaction([pieces[0]!, plainOutput, ...pieces.slice(1)])],
      [transaction([pieces[1]!, pieces[0]!, ...pieces.slice(2)])],
      [transaction(pieces.slice(0, -1))],
      [transaction(pieces.slice(0, 1)), transaction(pieces.slice(1))],
    ];
    expect(attributeBlock(profile, [transaction(pieces)])).toMatchObject([{ kind: 4, record }]);
    for (const variant of variants) {
      const objects = attributeBlock(profile, variant);
      expect(objects.some(object => hex(object.record) === hex(record))).toBe(false);
    }
    const truncated = transaction(pieces);
    expect(attributeBlock(profile, [{ ...truncated, unsigned: truncated.unsigned.slice(0, -1) }])).toEqual([]);
  });

  it("bounds and owns requests before supplier calls, and carries an empty raw record without interpreting it", async () => {
    const n = funded([100_000_000n]), p = publisher([n]);
    await expect(p.publish(publicationRequest(new Uint8Array(MAX_RANGE_RECORD_BYTES[4] + 1)))).rejects.toThrow(EncodingError);
    await expect(p.publish({ ...publicationRequest(RECORD), chunked: 1 } as never)).rejects.toThrow(/invalid Ergo record request/);
    const shared = new Uint8Array(new SharedArrayBuffer(10));
    await expect(p.publish(publicationRequest(shared))).rejects.toThrow(/invalid Ergo record request/);
    expect(n.submitted).toEqual([]);
    const empty = await p.publish(publicationRequest(new Uint8Array()));
    expect(frameTransaction(empty.unsigned)).toHaveLength(3);
    expect(attributeBlock(new Chain().profile(3n), n.pool)).toMatchObject([{ kind: 4, record: new Uint8Array() }]);
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

  it("sends a transaction again to a supplier that missed it, whatever another supplier claims to hold", async () => {
    const n = funded([10_000_000n]);
    let down = true;
    const honest: ErgoPublishingSupplier = { name: "honest", unspentBoxes: t => n.unspentBoxes(t), hasBox: id => n.hasBox(id),
      hasTransaction: id => n.hasTransaction(id), submit: (s, id) => (down ? Promise.reject(new Error("down")) : n.submit(s, id)) };
    // A supplier that claims every transaction and relays none.
    const liar: ErgoPublishingSupplier = { name: "liar", unspentBoxes: async () => [], hasBox: async () => { throw new Error("no answer"); },
      hasTransaction: async () => true, submit: async () => {} };
    const p = publisher([honest, liar]);
    const first = await p.publish(request());
    expect(n.pool).toHaveLength(0);
    down = false;
    expect(hex((await p.publish(request())).id)).toBe(hex(first.id));
    expect(n.pool).toHaveLength(1);
    // A later record spending its change reaches the honest supplier with its parent.
    await p.publish(request(new Uint8Array(136).fill(7)));
    expect(n.pool).toHaveLength(2);
    expect(n.submitted.filter(id => id === hex(first.id))).toHaveLength(1); // once it holds the parent, it is not sent again
  });

  it("walks unsettled parents only for a supplier that answers it lacks the child", async () => {
    const n = funded([10_000_000n]), asked: string[] = [], sent: string[] = [];
    const counting = (name: string, fail: boolean): ErgoPublishingSupplier => ({ name, unspentBoxes: t => n.unspentBoxes(t),
      hasBox: id => { asked.push(`${name} box`); return fail ? Promise.reject(new Error("no answer")) : n.hasBox(id); },
      hasTransaction: id => { asked.push(`${name} tx`); return fail ? Promise.reject(new Error("no answer")) : n.hasTransaction(id); },
      submit: (s, id) => { sent.push(`${name} ${hex(id)}`); return n.submit(s, id); } });
    const p = publisher([counting("holder", false), counting("mute", true)]);
    for (let i = 1; i <= 3; i++) await p.publish(request(new Uint8Array(136).fill(i)));
    asked.length = 0; sent.length = 0;
    const last = await p.publish(request(new Uint8Array(136).fill(3)));
    // The holder shows the child, so none of its ancestry is asked about; the mute supplier is sent the child alone.
    expect(asked).toEqual(["holder box", "mute box", "mute tx"]);
    expect(sent).toEqual([`mute ${hex(last.id)}`]);
  });

  it("walks for a supplier one of whose queries says it lacks the child, and stops at a parent it refuses", async () => {
    const n = funded([10_000_000n]), m = node("without the funding box");
    const partial: ErgoPublishingSupplier = { name: "partial", unspentBoxes: async () => [], hasBox: async () => { throw new Error("400"); },
      hasTransaction: id => m.hasTransaction(id), submit: (s, id) => m.submit(s, id) };
    const p = publisher([n, partial]), ids: string[] = [];
    for (let i = 1; i <= 3; i++) ids.push(hex((await p.publish(request(new Uint8Array(136).fill(i)))).id));
    // Each attempt reaches the first transaction through its descendants and m refuses it: the walk ends there,
    // and of what lies between only the publication asked for is sent.
    expect(m.submitted).toEqual([ids[0], ids[0], ids[1], ids[0], ids[2]]);
    expect(n.pool).toHaveLength(3);
  });

  it("still sends the publication asked for when a supplier refuses a parent that already landed there", async () => {
    const n = funded([10_000_000n]);
    // Box queries fail and transaction queries miss what landed, so a landed parent is resent and refused as spent.
    const blind: ErgoPublishingSupplier = { name: "blind", unspentBoxes: t => n.unspentBoxes(t), hasBox: async () => { throw new Error("400"); },
      hasTransaction: async () => false,
      submit: async (s, id) => { if (await n.hasTransaction(id)) throw new Error("inputs spent"); return n.submit(s, id); } };
    const p = publisher([blind]);
    await p.publish(request(new Uint8Array(136).fill(1)));
    await p.publish(request(new Uint8Array(136).fill(2)));
    expect(n.pool).toHaveLength(2);
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

describe("replacement, settlement and supplier cost", () => {
  const never = (): Promise<never> => new Promise(() => {});
  /** `n` as a supplier that answers nothing while `down()`. */
  const switched = (n: MempoolNode, down: () => boolean, onSubmit: () => void = () => {}): ErgoPublishingSupplier => ({ name: n.name,
    unspentBoxes: t => (down() ? Promise.reject(new Error("down")) : n.unspentBoxes(t)),
    hasBox: id => (down() ? Promise.reject(new Error("down")) : n.hasBox(id)),
    hasTransaction: id => (down() ? Promise.reject(new Error("down")) : n.hasTransaction(id)),
    submit: async (signed, id) => { if (down()) throw new Error("down"); await n.submit(signed, id); onSubmit(); } });
  const carried = (n: MempoolNode, record: Uint8Array): number =>
    attributeBlock(new Chain().profile(3n), n.pool).filter(object => hex(object.record) === hex(record)).length;

  it("replaces nothing while no supplier answers, so a tip that moved meanwhile builds no second transaction", async () => {
    for (const acknowledged of [false, true]) {
      const n = funded([10_000_000n]);
      let down = false, lost = !acknowledged;
      const p = new ErgoPublisher({ secretKey: SECRET, timeoutMs: 50,
        suppliers: [switched(n, () => down, () => { if (lost) throw new Error("connection reset"); })] });
      if (acknowledged) await p.publish(request());
      else await expect(p.publish(request())).rejects.toThrow(/kept and sent again/);
      lost = false; down = true;
      await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 1n))).rejects.toThrow(/kept and sent again/);
      down = false;
      await p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 1n));
      expect(n.pool).toHaveLength(1);
      expect(carried(n, RECORD)).toBe(1);
    }
  });

  it("builds no replacement beside a transaction it replaced that a supplier holds, across a restart", async () => {
    const state: { text?: string } = {};
    const persistence: ErgoPublisherPersistence = { load: () => state.text, save: text => { state.text = text; }, guard: () => {} };
    const n = funded([10_000_000n]), lagging = node("lagging");
    for (const box of n.boxes.values()) lagging.fund(box); // it holds the funding box and none of the publisher's transactions
    lagging.refuse = () => true; // and takes nothing, say at this height
    let down = false;
    const suppliers = [switched(n, () => down), lagging];
    const first = await new ErgoPublisher({ secretKey: SECRET, suppliers, persistence, timeoutMs: 50 }).publish(request());
    down = true;
    // Only the lagging node answers, and it lacks the transaction: it is replaced on the same inputs at the new height.
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers, persistence, timeoutMs: 50 });
    await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 1n))).rejects.toThrow(/kept and sent again/);
    down = false;
    // The replacement is refused where the first landed in the pool, its input spent. The first is the record's,
    // so no third transaction is built on the funding box's successor, the first's change.
    const reopened = new ErgoPublisher({ secretKey: SECRET, suppliers, persistence, timeoutMs: 50 });
    const resolved = await reopened.publish(request(RECORD, SCRIPTS[1], HEIGHT + 1n));
    expect(hex(resolved.id)).not.toBe(hex(first.id));
    expect(n.pool.map(t => hex(hash(t.unsigned)))).toEqual([hex(first.id)]);
    expect(new Set(n.submitted)).toEqual(new Set([hex(first.id), hex(resolved.id)]));
    expect(carried(n, RECORD)).toBe(1);
  });

  it("replaces one record's transaction at most eight times in all", async () => {
    const n = funded([10_000_000n]);
    n.refuse = () => true;
    const p = publisher([n]);
    for (let i = 0n; i < 12n; i++) await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + i))).rejects.toThrow(/kept and sent again/);
    expect(new Set(n.submitted).size).toBe(8);
  });

  it("settles asking no supplier: landed change stays its own, and no settled input stays reserved", async () => {
    const state: { text?: string } = {};
    const persistence: ErgoPublisherPersistence = { load: () => state.text, save: text => { state.text = text; }, guard: () => {} };
    const n = funded([100_000_000n]);
    let down = false;
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [switched(n, () => down)], persistence, timeoutMs: 50 });
    const published: { change?: { id: Uint8Array } }[] = [];
    for (let i = 1; i <= 20; i++) published.push(await p.publish(request(new Uint8Array(136).fill(i))));
    n.take(); // mined: each spent the change of the one before
    for (const id of [...n.boxes.keys()]) if (!n.confirmed.has(id) || readPlainBox(n.boxes.get(id)!, TREE) === undefined) n.boxes.delete(id); // record boxes swept
    down = true; // no supplier answers while it settles
    await p.settle(() => true);
    expect(p.unsettled).toBe(0);
    const saved = JSON.parse(state.text!);
    expect(saved.pending).toEqual([]);
    expect(saved.created.map((box: { id: { bytes: string } }) => box.id.bytes)).toEqual([hex(published[19]!.change!.id)]);
    down = false;
    n.unspentBoxes = async () => []; // an index that does not list the change yet
    expect((await p.publish(request(new Uint8Array(136).fill(21)))).inputs).toEqual([published[19]!.change!.id]);
  });

  it("costs a supplier that invents boxes and never answers about them a few timeouts, not one per box", async () => {
    const n = funded([10_000_000n]), funding = [...n.boxes.keys()];
    const invented = Array.from({ length: 200 }, (_, i) => plainBox(TREE, 1_000_000_000n + BigInt(i), HEIGHT - 1n));
    const liar: ErgoPublishingSupplier = { name: "liar", unspentBoxes: async () => invented, hasBox: never, hasTransaction: never, submit: never };
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [liar, n], timeoutMs: 100 });
    const started = performance.now();
    const publication = await p.publish(request());
    // Two hundred boxes the honest node denies at once; its own funding waits once for the liar; sending waits three more.
    expect(performance.now() - started).toBeLessThan(1_200);
    expect(publication.inputs.map(hex)).toEqual(funding);
  });

  it("walks no ancestry for a supplier that does not answer whether it holds the transaction", async () => {
    const n = funded([10_000_000_000n]), funding = [...n.boxes.keys()][0]!;
    let slow = false, asked = 0;
    const lagging: ErgoPublishingSupplier = { name: "lagging", unspentBoxes: async () => [], hasBox: async id => hex(id) === funding,
      hasTransaction: () => { asked++; return slow ? never() : Promise.resolve(false); }, submit: async () => {} };
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n, lagging], timeoutMs: 50 });
    for (let i = 1; i <= 30; i++) await p.publish(request(new Uint8Array(136).fill(i)));
    slow = true; asked = 0;
    await p.publish(request(new Uint8Array(136).fill(31)));
    expect(asked).toBe(1);
  });

  it("ends a slow supplier's walk of unsettled ancestry at one deadline, however many ancestors it lacks", async () => {
    const T = 50, n = funded([10_000_000_000n]), funding = [...n.boxes.keys()][0]!;
    let slow = false;
    const late = (): Promise<boolean> => new Promise(resolve => setTimeout(() => resolve(false), T - 10));
    // It answers that it lacks each transaction just inside the timeout, and never about boxes.
    const lagging: ErgoPublishingSupplier = { name: "lagging", unspentBoxes: async () => [],
      hasBox: id => (slow ? never() : Promise.resolve(hex(id) === funding)), hasTransaction: () => (slow ? late() : Promise.resolve(false)),
      submit: () => (slow ? never() : Promise.resolve()) };
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n, lagging], timeoutMs: T });
    for (let i = 1; i <= 30; i++) await p.publish(request(new Uint8Array(136).fill(i)));
    slow = true;
    const started = performance.now();
    await p.publish(request(new Uint8Array(136).fill(31)));
    // Two timeouts of walk and one to send the publication asked for, not two per ancestor.
    expect(performance.now() - started).toBeLessThan(15 * T);
  });

  it("keeps what each attempt sent, so a slow supplier that lost its mempool gets a long unsettled chain back", async () => {
    const T = 200, n = node(), funding = plainBox(TREE, 10_000_000_000n, HEIGHT - 5n);
    n.fund(funding);
    let delay = 0;
    const slowly = <V>(call: () => Promise<V>): Promise<V> => new Promise((resolve, reject) => setTimeout(() => call().then(resolve, reject), delay));
    const slow: ErgoPublishingSupplier = { name: "slow", unspentBoxes: t => slowly(() => n.unspentBoxes(t)), hasBox: id => slowly(() => n.hasBox(id)),
      hasTransaction: id => slowly(() => n.hasTransaction(id)), submit: (bytes, id) => slowly(() => n.submit(bytes, id)) };
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [slow], timeoutMs: T });
    for (let i = 1; i <= 30; i++) await p.publish(request(new Uint8Array(136).fill(i)));
    // The node restarts: its mempool is gone. Each answer now takes 20 ms, so one walk's deadline sends only part of the chain.
    n.pool.splice(0); n.boxes.clear(); n.fund(funding);
    delay = 20;
    let attempts = 0;
    for (; attempts < 8 && n.pool.length < 30; attempts++) await p.publish(request(new Uint8Array(136).fill(30))).catch(() => {});
    expect(n.pool).toHaveLength(30);
    expect(attempts).toBeGreaterThan(1);
  });

  it("asks the caller's readiness in its turn, so a publication queued while the caller became unready sends nothing", async () => {
    const n = funded([10_000_000n]);
    let entered!: () => void, open!: () => void, ready = true;
    const submitting = new Promise<void>(resolve => { entered = resolve; }), opened = new Promise<void>(resolve => { open = resolve; });
    const held: ErgoPublishingSupplier = { name: "held", unspentBoxes: t => n.unspentBoxes(t), hasBox: id => n.hasBox(id),
      hasTransaction: id => n.hasTransaction(id), submit: async (signed, id) => { entered(); await opened; return n.submit(signed, id); } };
    const p = publisher([held]), check = (): void => { if (!ready) throw new VenueError("the chain is short"); };
    const first = p.publish(request(), check), second = p.publish(request(new Uint8Array(136).fill(2)), check);
    await submitting;
    ready = false;
    open();
    await first;
    await expect(second).rejects.toThrow(new VenueError("the chain is short"));
    expect(n.submitted).toHaveLength(1);
  });

  it("builds no replacement while no supplier answers whether a transaction the record had before is held", async () => {
    const n = funded([10_000_000n]);
    n.refuse = () => true;
    const asked: string[] = [], hasTransaction = n.hasTransaction.bind(n);
    let silent: string | undefined;
    n.hasTransaction = async id => { asked.push(hex(id)); if (hex(id) === silent) throw new Error("no answer"); return hasTransaction(id); };
    const p = publisher([n]);
    await expect(p.publish(request())).rejects.toThrow(/kept and sent again/);
    const first = n.submitted[0]!;
    await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 1n))).rejects.toThrow(/kept and sent again/); // replaced on its inputs
    // The replacement's input is now gone, and the first transaction's fate is unknown: nothing more is built.
    silent = first;
    n.boxes.clear(); n.fund(plainBox(TREE, 10_000_000n, HEIGHT - 5n));
    await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 1n))).rejects.toThrow(/kept and sent again/);
    expect(new Set(n.submitted).size).toBe(2);
    expect(asked).toContain(first);
  });

  it("keeps a refused transaction whose rebuild at the caller's height would be the same transaction", async () => {
    const state: { text?: string } = {};
    const persistence: ErgoPublisherPersistence = { load: () => state.text, save: text => { state.text = text; }, guard: () => {} };
    const n = node();
    n.fund(plainBox(TREE, 10_000_000n, HEIGHT + 5n));
    n.refuse = () => true;
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n], persistence });
    await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 5n))).rejects.toThrow(/kept and sent again/);
    // A lower height is raised to its input's, the old one: no replacement, and none of the record's eight is spent.
    for (let i = 0; i < 3; i++) await expect(p.publish(request(RECORD, SCRIPTS[1], HEIGHT + 3n))).rejects.toThrow(/kept and sent again/);
    expect(JSON.parse(state.text!).pending[0].replaced).toEqual([]);
    expect(new Set(n.submitted).size).toBe(1);
    expect(() => new ErgoPublisher({ secretKey: SECRET, suppliers: [n], timeoutMs: 2 ** 31 })).toThrow(new VenueError("invalid Ergo publisher options"));
  });

  it("takes no box that would carry a transaction's inputs past one box's value", async () => {
    const small = plainBox(TREE, 700_000n, HEIGHT - 5n), lost = plainBox(TREE, 800_000n, HEIGHT - 5n), extra = plainBox(TREE, 5_000_000n, HEIGHT - 5n);
    const huge = plainBox(TREE, (1n << 64n) - 1n, HEIGHT - 5n), hugeId = hex(hash(huge)), n = node();
    n.fund(small); n.fund(lost);
    let offering = false;
    // The honest node never answers about the invented box; the liar vouches for it.
    const honest: ErgoPublishingSupplier = { name: "honest", unspentBoxes: t => n.unspentBoxes(t), hasTransaction: id => n.hasTransaction(id),
      hasBox: id => (hex(id) === hugeId ? Promise.reject(new Error("no answer")) : n.hasBox(id)), submit: (s, id) => n.submit(s, id) };
    const liar: ErgoPublishingSupplier = { name: "liar", unspentBoxes: async () => (offering ? [huge] : []),
      hasBox: async id => { if (hex(id) === hugeId) return true; throw new Error("no answer"); },
      hasTransaction: async () => { throw new Error("no answer"); }, submit: async () => { throw new Error("refused"); } };
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [honest, liar], timeoutMs: 50 });
    const first = await p.publish(request());
    expect(first.inputs).toHaveLength(2);
    // The network dropped it and one input is gone for good; the rebuild keeps the other and needs more.
    n.pool.splice(0); n.boxes.clear(); n.fund(small); n.fund(extra);
    offering = true;
    const rebuilt = await p.publish(request());
    expect(rebuilt.inputs.map(hex)).toEqual([hex(hash(small)), hex(hash(extra))]);
    expect(n.pool).toHaveLength(1);
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
  it("carries raw kinds 1–4 through the mining supplier, owns their bytes and waits for finality", async () => {
    const supplier = new MiningSupplier("journal", chain, verifyErgoProof);
    supplier.mempool.fund(plainBox(TREE, 100_000_000n, chain.anchor.height));
    const p = publisher([supplier.mempool]);
    const v = new ErgoVenue(PROFILE, chain.context, {}, p);
    const records: RecordPublisher = v;
    supplier.mine(Number(DEPTH) + 1);
    await v.sync([supplier]);
    const including = v.witnessedIndex() + v.lag();
    const lengths = [136, 233, 96, 16_000];
    const limits = { maxEntries: 10n, maxBytes: 32_768n };
    for (const kind of [1, 2, 3, 4] as const) {
      const subject = SUBJECT.slice(), record = new Uint8Array(lengths[kind - 1]!).fill(kind);
      const pending = records.publishRecord(kind, subject, record);
      subject.fill(0); record.fill(0);
      await pending;
      await records.publishRecord(kind, SUBJECT, new Uint8Array(lengths[kind - 1]!).fill(kind));
    }
    expect(supplier.mempool.pool).toHaveLength(4);
    expect(new Set(supplier.mempool.submitted).size).toBe(4);
    const read = (venue: ErgoVenue, kind: RecordKind) => {
      const request = { venue: venue.id, kind, subject: SUBJECT, fromIndex: 0n, toIndex: venue.witnessedIndex() };
      return decodeRangeAnswer(venue.range(request, limits)!, request, limits).entries;
    };
    supplier.mine(Number(DEPTH));
    await v.sync([supplier]);
    expect(read(v, 1)).toEqual([]);
    supplier.mine();
    await v.sync([supplier]);
    await p.settle(() => false); // wait for the verifying view's queued settlement, including kind 4
    expect(p.unsettled).toBe(0);
    const fresh = new ErgoVenue(PROFILE, chain.context);
    await fresh.sync([supplier]);
    for (const kind of [1, 2, 3, 4] as const) {
      expect(read(fresh, kind)).toEqual([{ index: including, ordinal: kind === 4 ? 3n << 32n : 0n, record: new Uint8Array(lengths[kind - 1]!).fill(kind) }]);
      await records.publishRecord(kind, SUBJECT, new Uint8Array(lengths[kind - 1]!).fill(kind));
    }
    expect(supplier.mempool.pool).toHaveLength(0);
    // A parent change spent by another transaction in this block cannot reappear in the index.
    supplier.mempool.mempoolAware = false;
    const unspent = await supplier.mempool.unspentBoxes(TREE);
    expect(unspent).toHaveLength(1);
    expect(await supplier.mempool.hasBox(hash(unspent[0]!))).toBe(true);
  });

  it("refuses unsupported publication kinds and malformed raw records before submitting", async () => {
    const network = new Network();
    network.mine(5);
    const v = await view(network);
    await expect(v.publishRecord(4, SUBJECT, new Uint8Array(MAX_RANGE_RECORD_BYTES[4] + 1))).rejects.toThrow(/record length/);
    await expect(v.publishRecord(0 as RecordKind, SUBJECT, RECORD)).rejects.toThrow(EncodingError);
    await expect(v.publishRecord(1, new Uint8Array(31), RECORD)).rejects.toThrow(/record length/);
    for (const [kind, length] of [[1, 136], [2, 233], [3, 96]] as const) {
      await expect(v.publishRecord(kind, SUBJECT, new Uint8Array(length - 1))).rejects.toThrow(/record length/);
      await expect(v.publishRecord(kind, SUBJECT, new Uint8Array(length + 1))).rejects.toThrow(/record length/);
    }
    await expect(v.publishRecord(1, SUBJECT, new Uint8Array(new SharedArrayBuffer(136)))).rejects.toThrow(/shared byte array/);
    await expect(v.publishRecord(1, SUBJECT, Object.create(Uint8Array.prototype) as Uint8Array)).rejects.toThrow(/not a byte array/);
    expect(network.node.submitted).toEqual([]);
    const readOnly = await view(network, false);
    await expect(readOnly.publishRecord(1, SUBJECT, RECORD)).rejects.toThrow(/no publisher/);
  });

  it("refuses to publish before a settled snapshot", async () => {
    const network = new Network();
    const unsynced = new ErgoVenue(PROFILE, chain.context, {}, publisher([network.node]));
    await expect(unsynced.publishRecord(1, KEYS.operator, encodeCommitment(commitmentOf(1n, 1)))).rejects.toThrow(/no settled snapshot/);
    expect(network.node.submitted).toHaveLength(0);
  });

  it("settles its wallet as it reads: a publication is forgotten once its record is final, and its inputs once it landed", async () => {
    const network = new Network();
    network.mine(5);
    const p = publisher([network.node]);
    const v = new ErgoVenue(PROFILE, chain.context, {}, p);
    await v.sync([network.supplier]);
    await v.publishRecord(1, KEYS.operator, encodeCommitment(commitmentOf(1n, 2)));
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
    await v.publishRecord(1, KEYS.operator, encodeCommitment(commitmentOf(1n, 2)));
    expect(network.node.submitted).toHaveLength(before);
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
    const idBytes = Buffer.from(id, "hex"), current = { "/blockchain/indexedHeight": `{ "indexedHeight" : 7, "fullHeight" : 7 }` };
    expect(await answering({ [`/transactions/unconfirmed/byTransactionId/${id}`]: `{ "id" : "${id}" }` }).hasTransaction(idBytes)).toBe(true);
    expect(await answering({ ...current, [`/blockchain/transaction/byId/${id}`]: `{ "id" : "${id}", "inclusionHeight" : 5 }` }).hasTransaction(idBytes)).toBe(true);
    expect(await answering({ ...current, [`/blockchain/transaction/byId/${id}`]: `{ "id" : "${"cd".repeat(32)}" }` }).hasTransaction(idBytes)).toBe(false);
    expect(await answering(current).hasTransaction(idBytes)).toBe(false);
    // The index's height is read after the mempool and before the index: a block that took the transaction out of the
    // mempool is then one the index has read.
    const ordered = recording(url => { const route = { ...current }[url.slice("http://node".length)]; return route === undefined ? new Response("", { status: 404 }) : new Response(route); });
    expect(await ergoNodePublisher("http://node", { fetch: ordered.fetch }).hasTransaction(idBytes)).toBe(false);
    expect(ordered.calls.map(call => call.url.slice("http://node".length))).toEqual([`/transactions/unconfirmed/byTransactionId/${id}`, "/blockchain/indexedHeight", `/blockchain/transaction/byId/${id}`]);
    // A mined transaction leaves the mempool before the index reads its block: an index behind the node's blocks, or
    // one that does not say how far it has read, has not said the node lacks it.
    await expect(answering({ "/blockchain/indexedHeight": `{ "indexedHeight" : 6, "fullHeight" : 7 }` }).hasTransaction(idBytes))
      .rejects.toThrow("the node's index has not read its blocks");
    await expect(answering({}).hasTransaction(idBytes)).rejects.toThrow("the node's index has not read its blocks");
    // A mempool that errors does not keep the index from showing it, but then nothing says the node lacks it.
    const failingMempool = (index: number) => ergoNodePublisher("http://node", { fetch: recording(url =>
      url.includes("/unconfirmed/") ? new Response("", { status: 500 }) : url.endsWith("/indexedHeight")
        ? new Response(current["/blockchain/indexedHeight"], { status: index }) : new Response(`{ "id" : "${id}" }`, { status: index })).fetch });
    expect(await failingMempool(200).hasTransaction(idBytes)).toBe(true);
    await expect(failingMempool(503).hasTransaction(idBytes)).rejects.toThrow(/503/);
    const missing = ergoNodePublisher("http://node", { fetch: recording(url =>
      url.includes("/unconfirmed/") ? new Response("", { status: 500 }) : url.endsWith("/indexedHeight")
        ? new Response(current["/blockchain/indexedHeight"]) : new Response("", { status: 404 })).fetch });
    await expect(missing.hasTransaction(idBytes)).rejects.toThrow("the node's mempool did not answer");
  });

  it("reads at most 4 MiB of a node's answer, whatever length it declares", async () => {
    let pulled = 0;
    const endless = (): Response => new Response(new ReadableStream({ pull(controller) { pulled += 65_536; controller.enqueue(new Uint8Array(65_536).fill(0x20)); } }));
    const supplier = ergoNodePublisher("http://node", { fetch: async () => endless() });
    await expect(supplier.hasBox(new Uint8Array(32))).rejects.toThrow(/response over 4194304 bytes/);
    expect(pulled).toBeLessThan(5 * 1024 * 1024);
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
