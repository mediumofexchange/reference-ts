// The synthetic node (synthetic-node.mjs) as a separate process, against recorded real node answers and through the
// runtime's own node clients (slice 10 M10b, item 5; M10c1):
// - each recorded answer to the six publisher calls (test/fixtures/ergo-node-answers.json) has its synthetic
//   counterpart in the matching state, with the same status and the same fields (errors: the same code and reason;
//   transactions: their top-level fields; boxes: every field but `address`), and ergoNodePublisher makes of both the
//   same answer;
// - an ErgoVenue takes its anchor context and syncs through ergoNodeSupplier, publishes the four record kinds through
//   ergoNodePublisher, and a fresh view reads each record back at its witnessed index.
// Synthetic headers carry no real work; this checks the clients' paths, not a live venue.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { ErgoVenue, ergoAnchorContext } from "../../../dist/ergo.js";
import { ErgoPublisher, ergoNodePublisher, payToPublicKeyTree } from "../../../dist/ergo-publisher.js";
import { ergoNodeSupplier } from "../../../dist/ergo-supplier.js";
import { Chain, SYNTHETIC_ANCHOR_HEIGHT, SYNTHETIC_SCRIPTS } from "../../../dist/ergo-synthetic.js";
import { decodeRangeAnswer } from "../../../dist/record-range.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => blake2b(bytes, { dkLen: 32 });
const sha = text => createHash("sha256").update(text).digest();
const recorded = JSON.parse(readFileSync(join(root, "test/fixtures/ergo-node-answers.json"), "utf8"));

const child = spawn(process.execPath, [join(root, "scripts/pool/v3/synthetic-node.mjs"), "--port", "0"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", data => { stderr += data; });
const url = await new Promise((resolveUrl, reject) => {
  let out = "";
  const timer = setTimeout(() => reject(new Error(`synthetic node did not start: ${stderr}`)), 20_000);
  child.stdout.on("data", data => {
    out += data;
    const line = out.split("\n")[0];
    if (out.includes("\n")) { clearTimeout(timer); resolveUrl(JSON.parse(line).url); }
  });
  child.once("exit", code => { clearTimeout(timer); reject(new Error(`synthetic node exited ${code}: ${stderr}`)); });
});

try {
  const call = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, { method, signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  const drill = async (path, body) => {
    const answer = await call("POST", `/synthetic/${path}`, body);
    assert.equal(answer.status, 200, answer.text);
    return JSON.parse(answer.text);
  };
  const type = value => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
  const sameFields = (name, real, synthetic, left = []) => {
    for (const key of Object.keys(real)) {
      if (left.includes(key)) continue;
      assert(Object.hasOwn(synthetic, key), `${name}: no ${key}`);
      assert.equal(type(synthetic[key]), type(real[key]), `${name}: ${key}`);
    }
  };
  /** The synthetic answer to the question a recorded answer answered, compared with it. */
  const compared = new Set();
  const compare = async (name, path, body) => {
    const real = recorded.answers.find(a => a.name === name), synthetic = await call(real.method, path, body);
    assert.equal(synthetic.status, real.status, `${name}: status`);
    const r = JSON.parse(real.answer), s = JSON.parse(synthetic.text);
    if (real.status !== 200) {
      assert.deepEqual([s.error, s.reason, type(s.detail)], [r.error, r.reason, type(r.detail)], name);
    } else if (Array.isArray(r)) {
      assert(Array.isArray(s) && s.length > 0 === r.length > 0, `${name}: list`);
      if (r.length > 0) for (const box of s) sameFields(name, r[0], box, ["address"]);
    } else if (typeof r === "object") {
      sameFields(name, r, s);
      if (!("inputs" in r)) assert.deepEqual(Object.keys(s).sort(), Object.keys(r).sort(), `${name}: fields`);
    } else {
      assert.equal(type(s), type(r), name);
    }
    compared.add(name);
    return synthetic;
  };

  // A publisher key and one box of it; one record pooled.
  const secretKey = sha("moe/synthetic-node-check/key"), tree = payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true));
  const { boxId: funding } = await drill("fund", { tree: hex(tree), value: "100000000" });
  await drill("mine", { count: 1 });
  const client = ergoNodePublisher(url);
  const publisher = new ErgoPublisher({ secretKey, suppliers: [client] });
  const tip = BigInt(JSON.parse((await call("GET", "/info")).text).fullHeight);
  const pooled = await publisher.publish({ location: SYNTHETIC_SCRIPTS[1], subject: new Uint8Array(32).fill(1), record: new Uint8Array(136).fill(2), height: tip });
  assert.deepEqual(pooled.inputs.map(hex), [funding]);
  const absent = label => hex(sha(`moe/synthetic-node-check/absent/${label}`)), change = hex(pooled.change.id), id = hex(pooled.id);

  await compare("indexedHeight", "/blockchain/indexedHeight");
  await compare("pooledTransaction", `/transactions/unconfirmed/byTransactionId/${id}`);
  await compare("pooledTransactionInIndex", `/blockchain/transaction/byId/${id}`);
  await compare("absentPooledTransaction", `/transactions/unconfirmed/byTransactionId/${absent("pool")}`);
  await compare("poolCreatedBox", `/utxo/withPool/byIdBinary/${change}`);
  await compare("poolSpentBox", `/utxo/withPool/byIdBinary/${funding}`);
  await compare("absentBox", `/utxo/withPool/byIdBinary/${absent("box")}`);
  const unspent = "/blockchain/box/unspent/byErgoTree?offset=0&limit=100&sortDirection=asc&includeUnconfirmed=true&excludeMempoolSpent=true";
  const far = await compare("unspentBoxesPooledFarPage", unspent.replace("offset=0", "offset=100000"), hex(tree));
  assert.deepEqual(JSON.parse(far.text).map(box => [box.boxId, box.inclusionHeight]), [[change, 0]], "the mempool's boxes come with every page");
  await assert.rejects(client.submit(pooled.signed, pooled.id), /HTTP 400/, "a pooled transaction is refused again");
  assert.equal(await client.hasTransaction(pooled.id), true);
  assert.equal(await client.hasTransaction(sha("absent")), false);
  assert.equal(await client.hasBox(Buffer.from(funding, "hex")), true, "a box the mempool spends is shown");
  assert.equal(await client.hasBox(pooled.change.id), true);
  assert.deepEqual((await client.unspentBoxes(tree)).map(bytes => hex(hash(bytes))), [change], "the index leaves out the pool-spent box");

  await drill("mine", { count: 1 });
  await assert.rejects(client.submit(pooled.signed, pooled.id), /HTTP 400/, "a mined transaction is refused again");
  await compare("minedTransaction", `/blockchain/transaction/byId/${id}`);
  await compare("minedTransactionInPool", `/transactions/unconfirmed/byTransactionId/${id}`);
  await compare("absentMinedTransaction", `/blockchain/transaction/byId/${absent("mined")}`);
  await compare("confirmedBox", `/utxo/withPool/byIdBinary/${change}`);
  await compare("unspentBoxes", unspent, hex(tree));
  await compare("unspentBoxesNextPage", unspent.replace("offset=0", "offset=100"), hex(tree));
  await compare("unspentBoxesUnknownTree", unspent, hex(payToPublicKeyTree(secp256k1.getPublicKey(sha("fresh"), true))));
  await compare("submitNotATransaction", "/transactions/bytes", "00");
  assert.deepEqual([...compared].sort(), recorded.answers.map(a => a.name).sort(), "every recorded answer compared");
  assert.equal(await client.hasTransaction(pooled.id), true);
  assert.equal(await client.hasBox(Buffer.from(funding, "hex")), false);
  assert.deepEqual((await client.unspentBoxes(tree)).map(bytes => hex(hash(bytes))), [change]);
  await assert.rejects(client.submit(Uint8Array.of(0), new Uint8Array(32)), /HTTP 400/);

  // A view over the node through the clients: anchor context, sync, the four kinds published and read back.
  const depth = 3n, chain = new Chain(), profile = chain.profile(depth), supplier = ergoNodeSupplier(url, { batch: 200n });
  const context = await ergoAnchorContext(supplier, chain.anchor.id, SYNTHETIC_ANCHOR_HEIGHT);
  const viewKey = sha("moe/synthetic-node-check/view key");
  await drill("fund", { tree: hex(payToPublicKeyTree(secp256k1.getPublicKey(viewKey, true))), value: "1000000000" });
  const viewPublisher = new ErgoPublisher({ secretKey: viewKey, suppliers: [ergoNodePublisher(url)] });
  const venue = new ErgoVenue(profile, context, {}, viewPublisher);
  await drill("mine", { count: Number(depth) + 1 });
  await venue.sync([supplier]);
  const subject = new Uint8Array(32).fill(0x51), lengths = { 1: 136, 2: 233, 3: 96, 4: 16_000 };
  for (const kind of [1, 2, 3, 4]) await venue.publishRecord(kind, subject, new Uint8Array(lengths[kind]).fill(kind));
  const including = venue.witnessedIndex() + venue.lag();
  await drill("mine", { count: Number(depth) + 1 });
  await venue.sync([supplier]);
  await viewPublisher.settle(() => false);
  assert.equal(viewPublisher.unsettled, 0, "the view settled every publication it read");
  const fresh = new ErgoVenue(profile, context);
  await fresh.sync([supplier]);
  const limits = { maxEntries: 10n, maxBytes: 32_768n };
  for (const kind of [1, 2, 3, 4]) {
    const request = { venue: fresh.id, kind, subject, fromIndex: 0n, toIndex: fresh.witnessedIndex() };
    const { entries } = decodeRangeAnswer(fresh.range(request, limits), request, limits);
    assert.deepEqual(entries, [{ index: including, ordinal: kind === 4 ? 3n << 32n : 0n, record: new Uint8Array(lengths[kind]).fill(kind) }], `kind ${kind}`);
  }
  console.log(JSON.stringify({ recordedAnswers: compared.size, recordedNode: recorded.appVersion, kindsReadBack: 4, witnessedIndex: String(fresh.witnessedIndex()) }));
} finally {
  child.kill();
}
