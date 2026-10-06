// Explicit live-drill publication budget. This validator runs before the real
// supplier's submit: it never connects to a node or reads a wallet. Each live
// drill names its own transaction, total spend and fee caps. --check also checks
// the live drills' funding transfers (testnet.mjs) offline.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { MempoolNode, plainBox } from "../../../dist/ergo-synthetic.js";
import { ErgoPublisher, readPlainBox, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { MINER_FEE_TREE_HEX } from "../../../dist/ergo-profile.js";

const hex = bytes => Buffer.from(bytes).toString("hex");
const feeTree = new Uint8Array(Buffer.from(MINER_FEE_TREE_HEX, "hex"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function publicationBudget(limits) {
  assert(Number.isSafeInteger(limits.transactions) && limits.transactions > 0 &&
    typeof limits.spentNanoErg === "bigint" && typeof limits.feeNanoErg === "bigint", "budget limits");
  const shadow = new MempoolNode("offline pre-submission publication budget", verifyErgoProof);
  const known = new Set(), authorized = new Map(); let treeId, spent = 0n, fees = 0n;
  let failure;
  const total = tree => [...shadow.boxes.values()].reduce((sum, bytes) => sum + (readPlainBox(bytes, tree)?.value ?? 0n), 0n);
  return {
    async authorizeSubmission({ signed, id, tree, boxes }) {
      assert(failure === undefined, failure);
      try {
        assert(treeId === undefined || treeId === hex(tree), "funding key changed"); treeId = hex(tree);
        const identity = hex(id), signedHash = hash(signed), prior = authorized.get(identity);
        if (prior !== undefined) { assert.equal(prior.signedHash, signedHash, "changed retry bytes"); return; }
        assert(authorized.size < limits.transactions, "publication transaction budget");
        for (const bytes of boxes) {
          const box = readPlainBox(bytes, tree); assert(box !== undefined, "non-plain funding box");
          if (!known.has(hex(box.id))) { known.add(hex(box.id)); shadow.fund(bytes); }
        }
        const before = total(tree), feeBefore = total(feeTree);
        await shadow.submit(signed, id); // Verifies exact ids, signatures, values and the publisher's grammar.
        for (const key of shadow.boxes.keys()) known.add(key);
        const cost = before - total(tree), fee = total(feeTree) - feeBefore;
        assert(cost >= fee && fee > 0n, "invalid publication transaction cost");
        assert(spent + cost <= limits.spentNanoErg, "publication total spend budget");
        assert(fees + fee <= limits.feeNanoErg, "publication fee budget");
        // Reserve before broadcasting; an uncertain or failed submission retains its reservation.
        spent += cost; fees += fee;
        authorized.set(identity, { id: identity, signedHash, signedBytes: signed.length, spentNanoErg: String(cost), feeNanoErg: String(fee) });
      } catch (error) { failure = error.message; throw error; }
    },
    report() { return { transactions: [...authorized.values()], spentNanoErg: String(spent), feeNanoErg: String(fees),
      ...(failure === undefined ? {} : { refusal: failure }) }; },
  };
}

/** Cheap adversarial exercise of the actual pre-broadcast hook, without a node or wallet. */
export async function checkPublicationBudget() {
  const b = n => new Uint8Array(32).fill(n), limits = { transactions: 10, spentNanoErg: 50_000_000n, feeNanoErg: 11_000_000n };
  function setup(fee = 1_100_000n) {
    const budget = publicationBudget(limits), node = new MempoolNode("offline actual supplier", verifyErgoProof), calls = [];
    let captured;
    const supplier = { name: node.name, unspentBoxes: tree => node.unspentBoxes(tree), hasBox: id => node.hasBox(id),
      hasTransaction: id => node.hasTransaction(id), submit: async (signed, id) => {
        const request = { signed, id, tree: publisher.tree, boxes: await node.unspentBoxes(publisher.tree) };
        await budget.authorizeSubmission(request); captured = request; calls.push(hex(id)); await node.submit(signed, id);
      } };
    const publisher = new ErgoPublisher({ secretKey: b(17), suppliers: [supplier], fee });
    const location = new ErgoPublisher({ secretKey: b(18), suppliers: [node] }).tree;
    node.fund(plainBox(publisher.tree, 200_000_000n, 1n));
    return { budget, node, calls, publisher, captured: () => captured,
      publish: (n, length = 32) => publisher.publish({ chunked: true, subject: b(n), location, record: new Uint8Array(length).fill(n), height: 1n }) };
  }
  const first = setup();
  await first.publish(1); const snapshot = first.budget.report();
  await first.budget.authorizeSubmission(first.captured()); assert.deepEqual(first.budget.report(), snapshot);
  const changed = setup(); await changed.publish(1);
  const original = changed.captured(), altered = new Uint8Array(original.signed); altered[altered.length - 1] ^= 1;
  await assert.rejects(changed.budget.authorizeSubmission({ ...original, signed: altered }), /changed retry bytes/);
  assert.equal(changed.calls.length, 1);
  for (let i = 2; i <= 10; i++) await first.publish(i);
  await assert.rejects(first.publish(11)); assert.equal(first.calls.length, 10);
  assert.equal(first.budget.report().refusal, "publication transaction budget");
  const spend = setup();
  for (let i = 1; i <= 10; i++) {
    try { await spend.publish(i, 15_500); } catch (error) { if (spend.budget.report().refusal === undefined) throw error; break; }
  }
  assert.equal(spend.budget.report().refusal, "publication total spend budget");
  assert(BigInt(spend.budget.report().spentNanoErg) <= limits.spentNanoErg);
  assert(spend.calls.length < 10);
  const fee = setup(12_000_000n); await assert.rejects(fee.publish(1));
  assert.equal(fee.calls.length, 0); assert.equal(fee.budget.report().refusal, "publication fee budget");
  return { status: "passed", checks: ["exact retry", "changed retry refusal", "transaction cap", "total spend cap", "fee cap", "refusal before real supplier submit"] };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  assert.deepEqual(process.argv.slice(2), ["--check"], "testnet-budget supports only its offline --check");
  const { checkPlainTransfer } = await import("./testnet.mjs");
  process.stdout.write(JSON.stringify({ budget: await checkPublicationBudget(), transfer: await checkPlainTransfer() }) + "\n");
}
