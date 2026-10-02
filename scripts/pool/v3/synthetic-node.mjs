// A synthetic Ergo node for command drills (slice 10 M10b, item 5): the synthetic chain (`Chain`) and its mempool
// (`MempoolNode`) served through the node REST paths the runtime's clients call, so a drill's processes read through
// `ergoNodeSupplier` and publish through `ergoNodePublisher` exactly as on the testnet. Test tooling, not shipped:
// it binds loopback only, its headers carry no real work, and `ErgoVenue` reads it only under the synthetic context.
//
// Read paths: `/info`, `/blocks/chainSlice`, `/blocks/{id}/transactions`. Publisher paths: the index's
// `/blockchain/box/unspent/byErgoTree` and `/blockchain/indexedHeight`, `/blockchain/transaction/byId/{id}`,
// `/transactions/unconfirmed/byTransactionId/{id}`, `/utxo/withPool/byIdBinary/{id}` and `/transactions/bytes`.
// Their answers follow recorded real node answers (test/fixtures/ergo-node-answers.json; synthetic-node-check.mjs
// compares them): a missing transaction or box answers 404 with the node's error body, a box the mempool spends is
// still answered by withPool, and the index lists boxes in order of inclusion, the mempool's after every page.
// Statements carry every field the clients read and the node's other fields where they are cheap to state; boxes
// carry no `address`.
//
// Drill paths, POST with a JSON body, outside the node's API: `/synthetic/fund` `{ tree, value }` adds an unspent
// plain box of that pay-to-public-key tree and answers its id; `/synthetic/mine` `{ count }` mines that many blocks,
// the first taking the mempool, and answers the new tip.
//
// Usage: node scripts/pool/v3/synthetic-node.mjs [--port 0]  (prints {"url": ...} once listening; stops on SIGTERM)
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { ANCHOR_CONTEXT } from "../../../dist/ergo-headers.js";
import { Chain, MempoolNode, plainBox, plainOutput, SYNTHETIC_ANCHOR_HEIGHT, transaction } from "../../../dist/ergo-synthetic.js";

const hash = bytes => blake2b(bytes, { dkLen: 32 });
const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_BODY_BYTES = 1 << 20;
const NOT_FOUND = { error: 404, reason: "not-found", detail: null };
/** Version 2 and later headers carry no `w` or `d`; the node states them as the generator and zero. */
const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** A cursor over bytes in the node's serialization; each read throws on bytes that are not of the expected shape. */
function reader(bytes) {
  let at = 0;
  const take = length => {
    if (at + length > bytes.length) throw new SyntaxError("truncated");
    const part = bytes.subarray(at, at + length);
    at += length;
    return part;
  };
  const vlq = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const [byte] = take(1);
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new SyntaxError("long VLQ");
  };
  /** A tree in the lengths MempoolNode reads: 36 bytes after a zero header (pay-to-public-key), 105 after 0x10 (the miner-fee tree). */
  const tree = () => {
    const first = bytes[at];
    if (first === 0x00) return take(36);
    if (first === 0x10) return take(105);
    throw new SyntaxError("a tree of another shape");
  };
  return { take, vlq, tree, get at() { return at; }, get done() { return at === bytes.length; } };
}

/** A box candidate's fields: value, tree, creation height, and its `Coll[Byte]` registers from R4; no tokens. */
function readCandidate(r) {
  const value = r.vlq(), tree = r.tree(), creationHeight = r.vlq();
  if (r.vlq() !== 0n) throw new SyntaxError("tokens");
  const count = Number(r.vlq()), registers = {};
  if (count > 6) throw new SyntaxError("registers");
  for (let i = 0; i < count; i++) {
    const start = r.at;
    if (r.take(1)[0] !== 0x0e) throw new SyntaxError("a register other than Coll[Byte]");
    r.take(Number(r.vlq()));
    registers[`R${4 + i}`] = start;
  }
  return { value, tree, creationHeight, registers };
}

/** A box's statement as the node's index lists it, from its bytes (candidate, transaction id, output index). */
function boxStatement(bytes, included) {
  const r = reader(bytes), c = readCandidate(r), transactionId = r.take(32), index = r.vlq();
  if (!r.done) throw new SyntaxError("trailing box bytes");
  const registers = {}, ends = [...Object.values(c.registers).slice(1), bytes.length - 32 - vlqBytes(index).length];
  Object.entries(c.registers).forEach(([name, start], i) => { registers[name] = bytesToHex(bytes.subarray(start, ends[i])); });
  return {
    globalIndex: included?.globalIndex ?? 0, inclusionHeight: included?.height ?? 0, spentTransactionId: null, spendingProof: null,
    boxId: bytesToHex(hash(bytes)), value: c.value, ergoTree: bytesToHex(c.tree), assets: [], creationHeight: c.creationHeight,
    additionalRegisters: registers, transactionId: bytesToHex(transactionId), index,
  };
}
function vlqBytes(n) {
  const out = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
}
const concat = (...parts) => Uint8Array.from(Buffer.concat(parts));

/** A signed transaction in the publisher's shape split into its unsigned bytes and input proofs. */
function splitSigned(signed) {
  const r = reader(signed), count = r.vlq(), parts = [vlqBytes(count)], proofs = [];
  if (count === 0n || count > 65535n) throw new SyntaxError("inputs");
  for (let i = 0n; i < count; i++) {
    const boxId = r.take(32);
    proofs.push(r.take(Number(r.vlq())));
    if (r.take(1)[0] !== 0) throw new SyntaxError("an extension");
    parts.push(boxId, Uint8Array.of(0, 0));
  }
  return { unsigned: concat(...parts, signed.subarray(r.at)), proofs };
}

/** A transaction's statement from its unsigned bytes and its inputs' proofs. */
function transactionStatement(unsigned, proofs) {
  const r = reader(unsigned), id = hash(unsigned), inputs = [], outputs = [];
  const count = Number(r.vlq());
  for (let i = 0; i < count; i++) {
    const boxId = r.take(32);
    if (r.vlq() !== 0n || r.take(1)[0] !== 0) throw new SyntaxError("a proof or extension in unsigned bytes");
    inputs.push({ boxId: bytesToHex(boxId), spendingProof: { proofBytes: bytesToHex(proofs[i] ?? new Uint8Array(0)), extension: {} } });
  }
  if (r.vlq() !== 0n || r.vlq() !== 0n) throw new SyntaxError("data inputs or tokens");
  const outputCount = Number(r.vlq());
  for (let index = 0; index < outputCount; index++) {
    const start = r.at;
    readCandidate(r);
    const box = concat(unsigned.subarray(start, r.at), id, vlqBytes(BigInt(index)));
    const { globalIndex: _g, inclusionHeight: _h, spentTransactionId: _s, spendingProof: _p, ...output } = boxStatement(box);
    outputs.push(output);
  }
  if (!r.done) throw new SyntaxError("trailing transaction bytes");
  const size = unsigned.length + proofs.reduce((sum, proof) => sum + vlqBytes(BigInt(proof.length)).length + proof.length - 1, 0);
  return { id: bytesToHex(id), inputs, dataInputs: [], outputs, size };
}

/** A header's statement as `/blocks/chainSlice` lists it, from the synthetic chain's version 3 bytes. */
function headerStatement(bytes) {
  const r = reader(bytes), version = r.take(1)[0];
  const parentId = r.take(32), adProofsRoot = r.take(32), transactionsRoot = r.take(32), stateRoot = r.take(33);
  const timestamp = r.vlq(), extensionHash = r.take(32), nBits = r.take(4).reduce((bits, byte) => bits * 256 + byte, 0);
  const height = r.vlq(), votes = r.take(3), unparsedBytes = version > 1 ? r.take(r.take(1)[0]) : new Uint8Array(0);
  const pk = r.take(33), n = r.take(8);
  if (!r.done || version !== 3) throw new SyntaxError("not a synthetic header");
  return {
    extensionId: bytesToHex(hash(concat(Uint8Array.of(108), hash(bytes), extensionHash))), difficulty: "1", votes: bytesToHex(votes),
    timestamp, size: bytes.length, unparsedBytes: bytesToHex(unparsedBytes), stateRoot: bytesToHex(stateRoot), height, nBits,
    version, id: bytesToHex(hash(bytes)), adProofsRoot: bytesToHex(adProofsRoot), transactionsRoot: bytesToHex(transactionsRoot),
    extensionHash: bytesToHex(extensionHash), powSolutions: { pk: bytesToHex(pk), w: GENERATOR, n: bytesToHex(n), d: 0n },
    parentId: bytesToHex(parentId),
  };
}

/** The node's JSON: bigint values written as integers, in key order. */
const json = value => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `\u0000${v}\u0000` : v), 2)
  .replace(/"\\u0000(-?[0-9]+)\\u0000"/g, "$1");

/** A synthetic node: one best chain from the synthetic anchor, a mempool, and the index over both. */
export class SyntheticNode {
  constructor(name = "synthetic node") {
    this.chain = new Chain();
    this.mempool = new MempoolNode(`${name} mempool`, verifyErgoProof);
    /** The best chain above the anchor, lowest first. */
    this.blocks = [];
    /** Each pooled or mined transaction's proofs, by id. */
    this.proofs = new Map();
    /** Each mined transaction's block and position, by id. */
    this.mined = new Map();
    /** Each box's inclusion as the index numbers it, by id. */
    this.included = new Map();
    this.globalIndex = 0;
  }

  get tip() { return this.blocks.at(-1) ?? this.chain.anchor; }

  #include(height) {
    for (const id of this.mempool.confirmed.keys()) if (!this.included.has(id)) this.included.set(id, { height, globalIndex: this.globalIndex++ });
  }

  /** An unspent plain box of `tree` holding `value`, as if mined at the tip. */
  fund(tree, value) {
    const id = this.mempool.fund(plainBox(tree, value, this.tip.height, hash(concat(new TextEncoder().encode("synthetic-node/fund/"), vlqBytes(BigInt(this.globalIndex))))));
    this.#include(this.tip.height);
    return id;
  }

  /** `count` blocks, the first taking the mempool; a block with nothing pooled carries one plain transaction. */
  mine(count = 1) {
    for (let i = 0; i < count; i++) {
      const height = this.tip.height + 1n;
      let section = this.mempool.take();
      if (section.length === 0) {
        const seed = `synthetic-node/block/${height}`;
        section = [transaction([plainOutput], 1n, seed)];
        this.proofs.set(bytesToHex(hash(section[0].unsigned)), [new TextEncoder().encode(seed)]);
      }
      const block = this.chain.mine(this.tip, section);
      this.blocks.push(block);
      section.forEach((t, index) => this.mined.set(bytesToHex(hash(t.unsigned)), { block, index }));
      this.#include(height);
    }
    return this.tip;
  }

  /** The header bytes at `height` on the best chain, the anchor's context included. */
  headerAt(height) {
    const above = height - SYNTHETIC_ANCHOR_HEIGHT;
    if (above > 0n) return this.blocks[Number(above) - 1]?.bytes;
    return this.chain.context[Number(height - (SYNTHETIC_ANCHOR_HEIGHT - BigInt(ANCHOR_CONTEXT)))];
  }

  #statement(id) {
    const mined = this.mined.get(id);
    const view = mined?.block.section[mined.index] ?? this.mempool.pool.find(t => bytesToHex(hash(t.unsigned)) === id);
    return view === undefined ? undefined : transactionStatement(view.unsigned, this.proofs.get(id) ?? []);
  }

  /** Answers one request: [status, body]. */
  answer(method, url, body) {
    const path = url.pathname, query = url.searchParams, segment = path.split("/").at(-1);
    const id = HEX.test(segment) && segment.length === 64 ? segment : undefined;
    const tip = this.tip;
    if (method === "GET" && path === "/info") {
      return [200, { name: "synthetic", network: "synthetic", appVersion: "synthetic", headersHeight: tip.height, fullHeight: tip.height,
        bestHeaderId: bytesToHex(tip.id), bestFullHeaderId: bytesToHex(tip.id), parameters: { height: tip.height, minValuePerByte: 360 } }];
    }
    if (method === "GET" && path === "/blocks/chainSlice") {
      const from = BigInt(query.get("fromHeight") ?? "0"), to = BigInt(query.get("toHeight") ?? "-1");
      const out = [];
      for (let height = from + 1n; height <= (to < 0n || to > tip.height ? tip.height : to); height++) {
        const bytes = this.headerAt(height);
        if (bytes !== undefined) out.push(headerStatement(bytes));
      }
      return [200, out];
    }
    if (method === "GET" && path.startsWith("/blocks/") && path.endsWith("/transactions")) {
      const block = this.blocks.find(b => bytesToHex(b.id) === path.split("/")[2]);
      if (block === undefined) return [404, NOT_FOUND];
      const transactions = block.section.map(t => transactionStatement(t.unsigned, this.proofs.get(bytesToHex(hash(t.unsigned))) ?? []));
      return [200, { headerId: bytesToHex(block.id), transactions, blockSize: block.bytes.length + transactions.reduce((sum, t) => sum + t.size, 0) }];
    }
    if (method === "GET" && path === "/blockchain/indexedHeight") return [200, { indexedHeight: tip.height, fullHeight: tip.height }];
    if (method === "GET" && path.startsWith("/transactions/unconfirmed/byTransactionId/")) {
      const statement = id === undefined || this.mined.has(id) ? undefined : this.#statement(id);
      return statement === undefined ? [404, NOT_FOUND] : [200, statement];
    }
    if (method === "GET" && path.startsWith("/blockchain/transaction/byId/")) {
      const mined = id === undefined ? undefined : this.mined.get(id);
      if (mined === undefined) return [404, NOT_FOUND];
      const { id: txId, ...statement } = this.#statement(id), height = mined.block.height;
      return [200, { id: txId, blockId: bytesToHex(mined.block.id), inclusionHeight: height, timestamp: headerStatement(mined.block.bytes).timestamp,
        index: mined.index, globalIndex: 0, numConfirmations: tip.height - height + 1n, ...statement }];
    }
    if (method === "GET" && path.startsWith("/utxo/withPool/byIdBinary/")) {
      const box = id === undefined ? undefined : this.mempool.box(hexToBytes(id));
      return box === undefined ? [404, NOT_FOUND] : [200, { boxId: id, bytes: bytesToHex(box) }];
    }
    if (method === "POST" && path === "/blockchain/box/unspent/byErgoTree") {
      if (typeof body !== "string" || !HEX.test(body)) return [400, { error: 400, reason: "bad.request", detail: "Invalid ErgoTree" }];
      const offset = Number(query.get("offset") ?? "0"), limit = Number(query.get("limit") ?? "5");
      const of = bytes => { try { return bytesToHex(readCandidate(reader(bytes)).tree) === body; } catch { return false; } };
      let confirmed = [...this.mempool.confirmed].filter(([key, bytes]) => of(bytes) && (query.get("excludeMempoolSpent") !== "true" || this.mempool.boxes.has(key)));
      confirmed.sort(([a], [b]) => this.included.get(a).globalIndex - this.included.get(b).globalIndex);
      if (query.get("sortDirection") === "desc") confirmed = confirmed.reverse();
      const page = confirmed.slice(offset, offset + limit).map(([key, bytes]) => boxStatement(bytes, this.included.get(key)));
      if (query.get("includeUnconfirmed") === "true") {
        for (const [key, bytes] of this.mempool.boxes) if (!this.mempool.confirmed.has(key) && of(bytes)) page.push(boxStatement(bytes));
      }
      return [200, page];
    }
    if (method === "POST" && path === "/transactions/bytes") {
      let split;
      try { split = splitSigned(hexToBytes(typeof body === "string" && HEX.test(body) ? body : "")); } catch { split = undefined; }
      if (split === undefined) return [400, { error: 400, reason: "bad.request", detail: "Can not parse transaction bytes: null" }];
      const txId = hash(split.unsigned), key = bytesToHex(txId);
      // A node refuses a transaction it already holds: pooled, or mined (its inputs are spent).
      if (this.mined.has(key) || this.mempool.pool.some(t => bytesToHex(hash(t.unsigned)) === key)) {
        return [400, { error: 400, reason: "bad.request", detail: `Pool can not accept transaction ${key}, it is already in the mempool` }];
      }
      return this.mempool.submit(hexToBytes(body), txId).then(() => {
        this.proofs.set(key, split.proofs);
        return [200, bytesToHex(txId)];
      }, error => [400, { error: 400, reason: "bad.request", detail: `Malformed transaction: ${error.message}` }]);
    }
    if (method === "POST" && path === "/synthetic/fund") {
      const tree = body?.tree, value = body?.value;
      if (typeof tree !== "string" || !/^0008cd(02|03)[0-9a-f]{64}$/.test(tree) || typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        return [400, { error: 400, reason: "bad.request", detail: "fund { tree, value }" }];
      }
      return [200, { boxId: bytesToHex(this.fund(hexToBytes(tree), BigInt(value))) }];
    }
    if (method === "POST" && path === "/synthetic/mine") {
      const count = body?.count ?? 1;
      if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) return [400, { error: 400, reason: "bad.request", detail: "mine { count }" }];
      const mined = this.mine(count);
      return [200, { height: mined.height, id: bytesToHex(mined.id) }];
    }
    return [404, NOT_FOUND];
  }
}

/** Serves `node` on loopback; resolves once listening. */
export async function serveSyntheticNode(node = new SyntheticNode(), port = 0) {
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size <= MAX_BODY_BYTES) chunks.push(chunk); });
    request.on("end", async () => {
      let status, body;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = size > MAX_BODY_BYTES ? Symbol("too large") : text === "" ? undefined : JSON.parse(text);
        [status, body] = typeof parsed === "symbol" ? [413, { error: 413, reason: "too-large", detail: null }]
          : await node.answer(request.method, new URL(request.url, "http://node"), parsed);
      } catch (error) {
        [status, body] = error instanceof SyntaxError ? [400, { error: 400, reason: "bad.request", detail: "Invalid JSON" }] : [500, { error: 500, reason: "internal.error", detail: String(error) }];
      }
      const text = json(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const { port: bound } = server.address();
  return { url: `http://127.0.0.1:${bound}`, node, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf("--port"), port = at >= 0 ? Number(process.argv[at + 1]) : 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) { console.error("usage: synthetic-node.mjs [--port n]"); process.exit(2); }
  const served = await serveSyntheticNode(new SyntheticNode(), port);
  console.log(JSON.stringify({ url: served.url }));
  process.on("SIGTERM", () => served.close().then(() => process.exit(0)));
  process.on("SIGINT", () => served.close().then(() => process.exit(0)));
}
