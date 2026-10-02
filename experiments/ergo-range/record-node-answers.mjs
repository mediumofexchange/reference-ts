// Records a real Ergo node's answers to the six calls the runtime's node publisher makes (src/ergo-publisher.ts
// ergoNodePublisher), so the synthetic node and MempoolNode are tested against what a node says rather than what we
// expect it to say (slice 10 M10b, item 5). Read-only, except one submission of bytes that are no transaction, which a
// node refuses while parsing. Needs a node with extraIndex; any network will do, since the answers' shapes are the
// node's, not the chain's. A second node is asked the same questions and must give the same statuses.
// Usage, from the repository root on Node 24:
//   node experiments/ergo-range/record-node-answers.mjs <node> <second node> [--out test/fixtures/ergo-node-answers.json]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const args = process.argv.slice(2);
const at = args.indexOf("--out"), out = at >= 0 ? args.splice(at, 2)[1] : "test/fixtures/ergo-node-answers.json";
const [first, second] = args.map(url => url.replace(/\/+$/, ""));
assert(first !== undefined && second !== undefined, "usage: <node> <second node> [--out file]");

const call = async (base, method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.text() };
};
const json = async (base, path) => JSON.parse((await call(base, "GET", path)).text);
const absent = label => createHash("sha256").update(`moe/node-answers/absent/${label}/${Date.now()}`).digest("hex");
const plain = o => o.ergoTree.startsWith("0008cd") && o.assets.length === 0 && Object.keys(o.additionalRegisters).length === 0;
// The publisher's own query (BOXES_PER_PAGE, sortDirection, mempool flags).
const unspent = offset => `/blockchain/box/unspent/byErgoTree?offset=${offset}&limit=100&sortDirection=asc&includeUnconfirmed=true&excludeMempoolSpent=true`;

/** The questions, chosen on `base`: a pooled transaction with a plain output, a mined one with an unspent plain
 * output whose tree holds one to four boxes, a fresh key's tree, and ids nobody holds. */
async function questions(base) {
  const pool = await json(base, "/transactions/unconfirmed?offset=0&limit=50");
  // A pool entry whose first input is in the UTXO set: a stale entry's input answers 404 everywhere and says nothing.
  let pooled;
  for (const t of pool) {
    if (t.outputs.some(plain) && (await call(base, "GET", `/utxo/byIdBinary/${t.inputs[0].boxId}`)).status === 200) { pooled = t; break; }
  }
  assert(pooled !== undefined, `${base}: no pooled transaction with a plain output and an unspent first input`);
  const [last] = await json(base, "/blocks/lastHeaders/1");
  let mined;
  for (let height = last.height - 2; height > last.height - 40 && mined === undefined; height--) {
    const [id] = await json(base, `/blocks/at/${height}`);
    for (const t of (await json(base, `/blocks/${id}/transactions`)).transactions) for (const o of t.outputs) {
      if (mined !== undefined || !plain(o) || (await call(base, "GET", `/utxo/withPool/byIdBinary/${o.boxId}`)).status !== 200) continue;
      const listed = await call(base, "POST", unspent(0), o.ergoTree);
      const count = listed.status === 200 ? JSON.parse(listed.text).length : 0;
      if (count >= 1 && count <= 4) mined = { tx: t.id, box: o.boxId, tree: o.ergoTree };
    }
  }
  assert(mined !== undefined, `${base}: no unspent plain output with a small tree in the last blocks`);
  const fresh = `0008cd${Buffer.from(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true)).toString("hex")}`;
  return [
    ["indexedHeight", "GET", "/blockchain/indexedHeight"],
    ["pooledTransaction", "GET", `/transactions/unconfirmed/byTransactionId/${pooled.id}`],
    ["pooledTransactionInIndex", "GET", `/blockchain/transaction/byId/${pooled.id}`],
    ["absentPooledTransaction", "GET", `/transactions/unconfirmed/byTransactionId/${absent("pool")}`],
    ["poolCreatedBox", "GET", `/utxo/withPool/byIdBinary/${pooled.outputs.find(plain).boxId}`],
    ["poolSpentBox", "GET", `/utxo/withPool/byIdBinary/${pooled.inputs[0].boxId}`],
    ["absentBox", "GET", `/utxo/withPool/byIdBinary/${absent("box")}`],
    ["minedTransaction", "GET", `/blockchain/transaction/byId/${mined.tx}`],
    ["minedTransactionInPool", "GET", `/transactions/unconfirmed/byTransactionId/${mined.tx}`],
    ["absentMinedTransaction", "GET", `/blockchain/transaction/byId/${absent("mined")}`],
    ["confirmedBox", "GET", `/utxo/withPool/byIdBinary/${mined.box}`],
    ["unspentBoxes", "POST", unspent(0), mined.tree],
    ["unspentBoxesNextPage", "POST", unspent(100), mined.tree],
    ["unspentBoxesUnknownTree", "POST", unspent(0), fresh],
    // Past every confirmed box of a tree with a pooled output: the mempool's boxes come with every page.
    ["unspentBoxesPooledFarPage", "POST", unspent(100_000), pooled.outputs.find(plain).ergoTree],
    ["submitNotATransaction", "POST", "/transactions/bytes", "00"],
  ];
}

const info = await json(first, "/info"), otherInfo = await json(second, "/info");
const answers = [];
for (const [name, method, path, body] of await questions(first)) {
  const answer = await call(first, method, path, body);
  answers.push({ name, method, path, ...(body === undefined ? {} : { body }), status: answer.status, answer: answer.text });
}
// The pooled transaction is still pooled, so its input's answer is that of a box the mempool spends.
assert.equal((await call(first, "GET", answers[1].path)).status, 200, "the pooled transaction left the mempool while recording: run again");
const statuses = [];
for (const [name, method, path, body] of await questions(second)) statuses.push([name, (await call(second, method, path, body)).status]);
const sameStatuses = statuses.every(([name, status]) => answers.find(a => a.name === name)?.status === status);
assert(sameStatuses, `the second node answered otherwise: ${JSON.stringify(statuses.filter(([name, status]) => answers.find(a => a.name === name)?.status !== status))}`);
writeFileSync(out, `${JSON.stringify({
  about: "Real Ergo node answers to the six calls ergoNodePublisher makes, each body as served; recorded by experiments/ergo-range/record-node-answers.mjs.",
  recordedAt: new Date().toISOString(), node: first, appVersion: info.appVersion, network: info.network,
  agreement: { node: second, appVersion: otherInfo.appVersion, sameStatuses }, answers,
}, null, 2)}\n`);
for (const a of answers) console.log(a.status, a.name);
console.log("second node: same statuses");
