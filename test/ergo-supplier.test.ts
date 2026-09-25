import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b.js";
import { describe, expect, it } from "vitest";
import { sectionMatchesRoot } from "../src/ergo-profile.js";
import {
  copyTransaction, ergoNodeSupplier, parseNodeJson, supplyBlock, supplyHeader, supplyTransaction, type NodeJson, type NodeRequestInit,
} from "../src/ergo-supplier.js";

// The supplier's copy over the experiment's hash-pinned mainnet fixtures: every
// fixture transaction is supplied, its copy hashes to its id, and each block's
// supplied ids and witness ids reproduce its header's transaction root; a
// statement the copy cannot reproduce is unsupplied, never misread, and text
// that is not the node's JSON is refused.
const fixtures = new URL("../experiments/ergo-range/fixtures/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixtures), "utf8")) as { fixtures: { file: string; sha256: string }[] };
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
type Json = Map<string, NodeJson>;
const map = (value: NodeJson | undefined): Json => { if (!(value instanceof Map)) throw new Error("not an object"); return value; };
const items = (value: NodeJson | undefined): NodeJson[] => { if (!Array.isArray(value)) throw new Error("not a list"); return value; };
const blocks = manifest.fixtures.map(fixture => {
  const raw = readFileSync(new URL(fixture.file.replace(/^fixtures\//, ""), fixtures));
  expect(sha256(raw)).toBe(fixture.sha256);
  return map(parseNodeJson(raw.toString("utf8")));
});
const sample = (() => {
  for (const block of blocks) for (const statement of items(map(block.get("blockTransactions")).get("transactions"))) {
    if (items(map(statement).get("outputs")).some(output => map(map(output).get("additionalRegisters")).size > 0)) return map(statement);
  }
  throw new Error("no fixture transaction with registers");
})();
const clone = (value: Json): Json => structuredClone(value);
const firstWithRegisters = (statement: Json): Json =>
  map(items(statement.get("outputs")).find(output => map(map(output).get("additionalRegisters")).size > 0));
const firstInput = (statement: Json): Json => map(items(statement.get("inputs"))[0]);
const edited = (edit: (statement: Json) => void) => { const statement = clone(sample); edit(statement); return supplyTransaction(statement); };

describe("the node supplier's copy of a transaction", () => {
  it("supplies every fixture transaction, and each block's copies reproduce its header's root", () => {
    let transactions = 0;
    for (const block of blocks) {
      const header = map(block.get("header")), statements = items(map(block.get("blockTransactions")).get("transactions"));
      const supplied = statements.map(supplyTransaction);
      supplied.forEach((view, position) => {
        expect(view).toBeDefined();
        expect(hex(view!.id)).toBe(map(statements[position]).get("id"));
        expect(hex(view!.id)).toBe(hex(blake2b(view!.unsigned, { dkLen: 32 })));
        expect(view!.witnessId).toHaveLength(31);
      });
      expect(sectionMatchesRoot(supplied.map(view => view!), Buffer.from(header.get("transactionsRoot") as string, "hex"))).toBe(true);
      transactions += supplied.length;
    }
    expect(transactions).toBeGreaterThan(20);
  });

  it.each([
    ["a stated id the copy does not hash to", (s: Json) => s.set("id", "00".repeat(32))],
    ["a register gap: R5 without R4", (s: Json) => { const r = map(firstWithRegisters(s).get("additionalRegisters")), v = r.get("R4")!; r.delete("R4"); r.set("R5", v); }],
    ["hex other than lowercase pairs", (s: Json) => map(firstWithRegisters(s).get("additionalRegisters")).set("R4", "0E")],
    ["a negative value", (s: Json) => map(items(s.get("outputs"))[0]).set("value", -1n)],
    ["a value beyond 64 bits", (s: Json) => map(items(s.get("outputs"))[0]).set("value", 1n << 64n)],
    ["a box id that is not 32 bytes", (s: Json) => firstInput(s).set("boxId", "00".repeat(31))],
    ["an extension key the node's signed byte cannot hold", (s: Json) => map(map(firstInput(s).get("spendingProof")).get("extension")).set("128", "0e00")],
    ["more extension entries than the node writes", (s: Json) => map(firstInput(s).get("spendingProof"))
      .set("extension", new Map(Array.from({ length: 128 }, (_, k) => [String(k), "0e00"])))],
    ["a missing field", (s: Json) => s.delete("dataInputs")],
  ])("leaves a statement unsupplied for %s", (_, edit) => {
    expect(supplyTransaction(clone(sample))).toBeDefined();
    expect(edited(edit)).toBeUndefined();
  });

  it("writes registers by name and an extension in its text's order", () => {
    const reversed = edited(s => { const o = firstWithRegisters(s); o.set("additionalRegisters", new Map([...map(o.get("additionalRegisters"))].reverse())); });
    expect(hex(reversed!.unsigned)).toBe(hex(supplyTransaction(sample)!.unsigned));
    const withExtension = (entries: [string, string][]): string => {
      const statement = clone(sample);
      map(firstInput(statement).get("spendingProof")).set("extension", new Map(entries));
      return hex(copyTransaction(statement)!.unsigned);
    };
    expect(withExtension([["1", "0e0101"], ["0", "0e0100"]])).toContain("0201" + "0e0101" + "00" + "0e0100");
    expect(withExtension([["0", "0e0100"], ["1", "0e0101"]])).toContain("0200" + "0e0100" + "01" + "0e0101");
  });

  it("copies a statement naming 30,000 distinct tokens in time linear in its tokens", () => {
    const template = map(items(sample.get("outputs"))[0]);
    const token = (i: number): Json => new Map<string, NodeJson>([["tokenId", createHash("sha256").update(String(i)).digest("hex")], ["amount", 1n]]);
    const timed = (outputs: number): number => {
      const statement = clone(sample);
      statement.set("outputs", Array.from({ length: outputs }, (_, o) => {
        const output = clone(template);
        output.set("assets", Array.from({ length: 120 }, (_, t) => token(o * 120 + t)));
        return output;
      }));
      const t0 = performance.now(), copy = copyTransaction(statement), ms = performance.now() - t0;
      expect(copy!.unsigned.length).toBeGreaterThan(outputs * 120 * 33);
      return ms;
    };
    timed(25);
    // Ten times the tokens: about ten times the time, where a lookup per asset over the id list is about a hundred.
    expect(timed(250) / Math.max(timed(25), 1)).toBeLessThan(40);
  });
});

describe("the order-keeping node JSON parser", () => {
  it("keeps text order for integer-like keys and integers exact above 2^53", () => {
    const parsed = map(parseNodeJson('{"extension" : {"1" : "0e0101", "0" : "0e0100"}, "value" : 9007199254740993}'));
    expect([...map(parsed.get("extension")).keys()]).toEqual(["1", "0"]);
    expect(parsed.get("value")).toBe(9007199254740993n);
  });
  it.each(['{"a":1,"a":2}', '{"a":1.5}', '{"a":"\\u0041"}', '{"a":1} x', '{"a":01}', "[1,]"])("refuses %s", bad => {
    expect(() => parseNodeJson(bad)).toThrow(SyntaxError);
  });
  it("refuses text that is not a block's transactions", () => {
    expect(() => supplyBlock('{"headerId":"00"}')).toThrow(/not a block's transactions/);
  });
});

describe("the node supplier's copy of a header", () => {
  const headers = blocks.map(block => map(block.get("header")));
  headers.push(map(parseNodeJson(readFileSync(new URL("mainnet-genesis-header.json", fixtures), "utf8"))));
  it("copies every fixture header, version 1 included, to bytes hashing to its id", () => {
    for (const header of headers) expect(hex(supplyHeader(header)!.id)).toBe(header.get("id"));
    expect(headers.some(header => header.get("version") === 1n)).toBe(true);
  });
  const v4 = headers.find(header => header.get("version") === 4n)!;
  const editedHeader = (edit: (header: Json) => void) => { const copy = clone(v4); edit(copy); return supplyHeader(copy); };
  it("reads an empty unparsedBytes as the node's zero length", () => {
    expect(editedHeader(header => header.set("unparsedBytes", ""))).toBeDefined();
  });
  it.each([
    ["wrongId", (h: Json) => h.set("id", "00".repeat(32))],
    ["unparsedBytes", (h: Json) => h.set("unparsedBytes", "00")],
    ["version5", (h: Json) => h.set("version", 5n)],
    ["missingNonce", (h: Json) => map(h.get("powSolutions")).delete("n")],
    ["shortStateRoot", (h: Json) => h.set("stateRoot", (h.get("stateRoot") as string).slice(2))],
    ["nBitsAboveU32", (h: Json) => h.set("nBits", 1n << 32n)],
  ])("leaves header %s unsupplied", (_, edit) => {
    expect(editedHeader(edit)).toBeUndefined();
  });
});

describe("the node supplier over HTTP", () => {
  const block = blocks.find(b => items(map(b.get("blockTransactions")).get("transactions")).length > 1)!;
  const header = map(block.get("header")), headerId = header.get("id") as string;
  const json = (value: unknown): string => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? `#${v}#` : v))
    .replace(/"#(-?\d+)#"/g, "$1");
  const plain = (value: NodeJson): unknown => value instanceof Map ? Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]))
    : Array.isArray(value) ? value.map(plain) : value;
  const served = (routes: Record<string, string | number>, seen: string[] = []) =>
    async (url: string): Promise<Response> => {
      const path = url.slice("http://node".length);
      seen.push(path);
      const route = routes[path];
      if (route === undefined) return new Response("", { status: 404 });
      return typeof route === "number" ? new Response("", { status: route }) : new Response(route);
    };

  it("serves a block's section as the reader takes it, and nothing for another block's", async () => {
    const text = json(plain(block.get("blockTransactions")!));
    const supplier = ergoNodeSupplier("http://node/", { fetch: served({ [`/blocks/${headerId}/transactions`]: text }) });
    const section = await supplier.section(Buffer.from(headerId, "hex"));
    expect(section).toBeDefined();
    expect(sectionMatchesRoot(section!.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId })),
      Buffer.from(header.get("transactionsRoot") as string, "hex"))).toBe(true);
    const other = "11".repeat(32);
    const misfiled = ergoNodeSupplier("http://node", { fetch: served({ [`/blocks/${other}/transactions`]: text }) });
    expect(await misfiled.section(Buffer.from(other, "hex"))).toBeUndefined();
    expect(await misfiled.section(Buffer.from("22".repeat(32), "hex"))).toBeUndefined();
  });

  it("asks chainSlice for (from - 1, to] and stops at a gap", async () => {
    const seen: string[] = [];
    const statement = plain(header) as Record<string, unknown>;
    const height = BigInt(statement["height"] as bigint);
    const supplier = ergoNodeSupplier("http://node", { batch: 2n, fetch: served({
      [`/blocks/chainSlice?fromHeight=${height - 1n}&toHeight=${height + 1n}`]: json([statement, { ...statement, height: height + 5n }]),
      "/info": json({ headersHeight: height + 1n }),
    }, seen) });
    expect(await supplier.tipHeight()).toBe(height + 1n);
    const got = await supplier.headers(height, height + 3n);
    expect(got.map(hex)).toEqual([hex(supplyHeader(header)!.bytes)]);
    expect(seen).toEqual(["/info", `/blocks/chainSlice?fromHeight=${height - 1n}&toHeight=${height + 1n}`]);
  });

  it("refuses a response over its byte budget and an error status", async () => {
    const big = ergoNodeSupplier("http://node", { maxResponseBytes: 10, fetch: served({ "/info": json({ headersHeight: 123456789012n }) }) });
    await expect(big.tipHeight()).rejects.toThrow(/over 10 bytes/);
    const failing = ergoNodeSupplier("http://node", { fetch: served({ "/info": 503 }) });
    await expect(failing.tipHeight()).rejects.toThrow(/503/);
  });
});

describe("the node supplier's publishing side", () => {
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
    const supplier = ergoNodeSupplier("http://node", { fetch });
    const boxes = await supplier.unspentBoxes(Buffer.from(TREE, "hex"));
    expect(boxes.map(hex)).toEqual([BOX_BYTES]);
    expect(hex(blake2b(boxes[0]!, { dkLen: 32 }))).toBe(BOX_ID);
    expect(calls).toEqual([{ method: "POST", body: JSON.stringify(TREE), url:
      "http://node/blockchain/box/unspent/byErgoTree?offset=0&limit=100&sortDirection=desc&includeUnconfirmed=true&excludeMempoolSpent=true" }]);
    const none = ergoNodeSupplier("http://node", { fetch: recording(() => new Response("", { status: 404 })).fetch });
    expect(await none.unspentBoxes(Buffer.from(TREE, "hex"))).toEqual([]);
  });

  it("shows a box only where the bytes served hash to its id", async () => {
    const answer = (bytes: string) => ergoNodeSupplier("http://node", { fetch: recording(() => new Response(`{ "boxId" : "${BOX_ID}", "bytes" : "${bytes}" }`)).fetch });
    expect(await answer(BOX_BYTES).hasBox(Buffer.from(BOX_ID, "hex"))).toBe(true);
    expect(await answer(`${BOX_BYTES}00`).hasBox(Buffer.from(BOX_ID, "hex"))).toBe(false);
    const missing = ergoNodeSupplier("http://node", { fetch: recording(() => new Response("", { status: 404 })).fetch });
    expect(await missing.hasBox(Buffer.from(BOX_ID, "hex"))).toBe(false);
  });

  it("takes a submission as accepted only where the node answers with the transaction's id", async () => {
    const id = new Uint8Array(32).fill(0xab);
    const { calls, fetch } = recording(() => new Response(`"${hex(id)}"`));
    await ergoNodeSupplier("http://node", { fetch }).submit(Uint8Array.of(1, 2, 3), id);
    expect(calls).toEqual([{ url: "http://node/transactions/bytes", method: "POST", body: '"010203"' }]);
    await expect(ergoNodeSupplier("http://node", { fetch }).submit(Uint8Array.of(1), new Uint8Array(32))).rejects.toThrow(/did not accept/);
    const refusing = recording(() => new Response('{ "error" : 400, "reason" : "bad.request", "detail" : "Can not parse transaction bytes: null" }', { status: 400 }));
    await expect(ergoNodeSupplier("http://node", { fetch: refusing.fetch }).submit(Uint8Array.of(0), id)).rejects.toThrow(/400/);
  });
});
