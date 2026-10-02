import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { describe, expect, it } from "vitest";
import { ergoNodePublisher, ErgoPublisher, payToPublicKeyTree, verifyErgoProof, type NodeRequestInit } from "../src/ergo-publisher.js";
import { hex, MempoolNode, plainBox, SCRIPTS } from "./ergo-chain.js";

// Real node answers to the six calls the node publisher makes, recorded from
// a public node (experiments/ergo-range/record-node-answers.mjs): what the
// client makes of each, and the same answer from MempoolNode, the mempool the
// synthetic node serves (slice 10 M10b, item 5), in the matching state.

interface Answer { readonly name: string; readonly method: string; readonly path: string; readonly body?: string; readonly status: number; readonly answer: string }
const recorded: { readonly agreement: { readonly sameStatuses: boolean }; readonly answers: readonly Answer[] } = JSON.parse(readFileSync(new URL("./fixtures/ergo-node-answers.json", import.meta.url), "utf8"));
const answer = (name: string): Answer => recorded.answers.find(a => a.name === name)!;
const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
const idIn = (name: string): Uint8Array => Buffer.from(answer(name).path.split("/").at(-1)!, "hex");
const treeOf = (name: string): Uint8Array => Buffer.from(answer(name).body!, "hex");

/** The recorded node: each question answered as recorded, and a transaction or box nobody holds as the absent ones were. */
const recordedNode = ergoNodePublisher("http://node", {
  fetch: async (url: string, init: NodeRequestInit): Promise<Response> => {
    const path = url.slice("http://node".length), body = init.body === undefined ? undefined : JSON.parse(init.body) as string;
    const found = recorded.answers.find(a => a.path === path && a.method === (init.method ?? "GET") && a.body === body)
      ?? (path.startsWith("/transactions/unconfirmed/byTransactionId/") ? answer("absentPooledTransaction")
        : path.startsWith("/blockchain/transaction/byId/") ? answer("absentMinedTransaction")
          : path.startsWith("/utxo/withPool/byIdBinary/") ? answer("absentBox") : undefined);
    if (found === undefined) throw new Error(`not recorded: ${init.method ?? "GET"} ${path}`);
    return new Response(found.answer, { status: found.status, headers: { "content-type": "application/json" } });
  },
});

describe("the node publisher on recorded node answers", () => {
  it("holds a pooled or mined transaction and lacks an absent one once the index has read every block", async () => {
    expect(await recordedNode.hasTransaction(idIn("pooledTransaction"))).toBe(true);
    expect(await recordedNode.hasTransaction(idIn("minedTransaction"))).toBe(true);
    expect(await recordedNode.hasTransaction(createHash("sha256").update("nobody's").digest())).toBe(false);
  });

  it("shows a box created or spent in the mempool, or unspent in blocks, and no absent box", async () => {
    expect(await recordedNode.hasBox(idIn("poolCreatedBox"))).toBe(true);
    expect(await recordedNode.hasBox(idIn("poolSpentBox"))).toBe(true);
    expect(await recordedNode.hasBox(idIn("confirmedBox"))).toBe(true);
    expect(await recordedNode.hasBox(idIn("absentBox"))).toBe(false);
  });

  it("copies a tree's plain boxes from the index, each to bytes hashing to its id, and none for a fresh key", async () => {
    const listed = JSON.parse(answer("unspentBoxes").answer) as { boxId: string; assets: unknown[]; additionalRegisters: object }[];
    const plain = listed.filter(box => box.assets.length === 0 && Object.keys(box.additionalRegisters).length === 0);
    expect(plain.length).toBeGreaterThan(0);
    const copies = await recordedNode.unspentBoxes(treeOf("unspentBoxes"));
    expect(copies.map(bytes => hex(hash(bytes)))).toEqual(plain.map(box => box.boxId));
    expect(await recordedNode.unspentBoxes(treeOf("unspentBoxesUnknownTree"))).toEqual([]);
  });

  it("was answered alike by a second node, and lists the mempool's boxes on a page past every confirmed one", () => {
    expect(recorded.agreement.sameStatuses).toBe(true);
    const far = JSON.parse(answer("unspentBoxesPooledFarPage").answer) as { boxId: string; inclusionHeight: number }[];
    expect(far.map(box => [box.boxId, box.inclusionHeight])).toEqual([[JSON.parse(answer("poolCreatedBox").answer).boxId, 0]]);
  });

  it("takes a refused submission as not accepted", async () => {
    await expect(recordedNode.submit(Uint8Array.of(0), new Uint8Array(32))).rejects.toThrow(/HTTP 400/);
  });
});

describe("MempoolNode answers as the recorded node does", () => {
  const SECRET = createHash("sha256").update("moe/test/ergo-node-answers/key").digest();
  const TREE = payToPublicKeyTree(secp256k1.getPublicKey(SECRET, true));
  const request = { location: SCRIPTS[1], subject: new Uint8Array(32).fill(1), record: new Uint8Array(40).fill(2), height: 900_010n };

  it("shows a box its pool spends and one its pool creates, lists neither the spent one nor an absent one", async () => {
    const n = new MempoolNode("node", verifyErgoProof), funding = plainBox(TREE, 10_000_000n, 900_000n), fundingId = n.fund(funding);
    const published = await new ErgoPublisher({ secretKey: SECRET, suppliers: [n] }).publish(request);
    expect(published.inputs.map(hex)).toEqual([hex(fundingId)]);
    // Pooled: the input it spends is still shown (poolSpentBox), its outputs are (poolCreatedBox).
    expect(await n.hasBox(fundingId)).toBe(true);
    expect(await n.hasBox(published.change!.id)).toBe(true);
    expect(await n.hasBox(new Uint8Array(32))).toBe(false);
    expect(await n.hasTransaction(published.id)).toBe(true);
    // The index leaves out what the mempool spends and lists what it creates.
    expect((await n.unspentBoxes(TREE)).map(bytes => hex(hash(bytes)))).toEqual([hex(published.change!.id)]);
    // Mined: the spent input is gone, the change unspent in blocks (confirmedBox), the transaction in the index.
    n.take();
    expect(await n.hasBox(fundingId)).toBe(false);
    expect(await n.hasBox(published.change!.id)).toBe(true);
    expect(await n.hasTransaction(published.id)).toBe(true);
    expect(await n.unspentBoxes(payToPublicKeyTree(secp256k1.getPublicKey(createHash("sha256").update("fresh").digest(), true)))).toEqual([]);
  });

  it("shows a box its pool creates and spends until a block takes both transactions", async () => {
    const n = new MempoolNode("node", verifyErgoProof);
    n.fund(plainBox(TREE, 10_000_000n, 900_000n));
    const p = new ErgoPublisher({ secretKey: SECRET, suppliers: [n] });
    const parent = await p.publish(request), child = await p.publish({ ...request, record: new Uint8Array(40).fill(3) });
    expect(child.inputs.map(hex)).toEqual([hex(parent.change!.id)]);
    expect(await n.hasBox(parent.change!.id)).toBe(true);
    expect((await n.unspentBoxes(TREE)).map(bytes => hex(hash(bytes)))).toEqual([hex(child.change!.id)]);
    n.take();
    expect(await n.hasBox(parent.change!.id)).toBe(false);
    expect(await n.hasBox(child.change!.id)).toBe(true);
  });
});
