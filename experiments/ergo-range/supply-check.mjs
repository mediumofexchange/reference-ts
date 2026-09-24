// The supplier's copy (supply.mjs) over the hash-pinned fixtures: every fixture transaction is supplied, its copy
// hashes to its id, and each block's supplied ids and witness ids reproduce its header's transaction root; a statement
// the copy cannot reproduce is unsupplied, never misread, and text that is not the node's JSON is refused.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { copyTransaction, parseNodeJson, supplyBlock, supplyTransaction } from "./supply.mjs";
import { supplyHeader } from "./supply-header.mjs";

const here = import.meta.dirname;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const hex = bytes => Buffer.from(bytes).toString("hex");
const hash = (...parts) => blake2b(Buffer.concat(parts), { dkLen: 32 });
// scrypto's tree, as check.mjs states it: prefixes 0/1, an absent right sibling is zero bytes, one leaf still gets a parent.
const merkleRoot = leaves => {
  let level = leaves.map(leaf => hash(Buffer.of(0), leaf));
  do {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(Buffer.of(1), level[i], level[i + 1] ?? Buffer.alloc(0)));
    level = next;
  } while (level.length > 1);
  return level[0];
};
let checks = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

const manifest = JSON.parse(readFileSync(`${here}/fixtures/manifest.json`, "utf8"));
let transactions = 0, multiEntryExtensions = 0, withRegisters = 0, sample;
for (const fixture of manifest.fixtures) {
  const raw = readFileSync(`${here}/${fixture.file}`);
  equal(sha256(raw), fixture.sha256, "fixture pin checked before parsing");
  const block = parseNodeJson(raw.toString("utf8"));
  const header = block.get("header"), statements = block.get("blockTransactions").get("transactions");
  const supplied = statements.map(supplyTransaction);
  supplied.forEach((view, position) => {
    assert(view !== undefined, `${fixture.file} transaction ${position} is supplied`);
    equal(hex(view.id), statements[position].get("id"), "the copy hashes to the id the node states");
    equal(hex(view.id), hex(blake2b(view.unsigned, { dkLen: 32 })), "the id is the unsigned bytes' hash");
    equal(view.witnessId.length, 31, "a witness id is 31 bytes");
  });
  transactions += supplied.length;
  for (const statement of statements) {
    if (statement.get("inputs").some(input => input.get("spendingProof").get("extension").size > 1)) multiEntryExtensions++;
    if (statement.get("outputs").some(output => output.get("additionalRegisters").size > 0)) { withRegisters++; sample ??= statement; }
  }
  // Version 1 roots bind ids only; later versions bind the witness ids after them.
  const leaves = [...supplied.map(view => view.id), ...(header.get("version") > 1n ? supplied.map(view => view.witnessId) : [])];
  equal(hex(merkleRoot(leaves)), header.get("transactionsRoot"), `${fixture.file}: the supplied section reproduces the root`);
}
assert(withRegisters > 0, "a fixture transaction with registers exercises register copying");

// Refusals: each change the copy cannot reproduce leaves the statement unsupplied.
const edited = (edit) => {
  const statement = structuredClone(sample);
  edit(statement);
  return supplyTransaction(statement);
};
const firstWithRegisters = statement => statement.get("outputs").find(output => output.get("additionalRegisters").size > 0);
equal(supplyTransaction(structuredClone(sample)) !== undefined, true, "the unedited sample is supplied");
equal(edited(s => s.set("id", "00".repeat(32))), undefined, "a stated id the copy does not hash to");
equal(edited(s => { const r = firstWithRegisters(s).get("additionalRegisters"), v = r.get("R4"); r.delete("R4"); r.set("R5", v); }), undefined, "a register gap: R5 without R4");
equal(edited(s => firstWithRegisters(s).get("additionalRegisters").set("R4", "0E")), undefined, "hex other than lowercase pairs");
equal(edited(s => s.get("outputs")[0].set("value", -1n)), undefined, "a negative value");
equal(edited(s => s.get("outputs")[0].set("value", 1n << 64n)), undefined, "a value beyond 64 bits");
equal(edited(s => s.get("inputs")[0].set("boxId", "00".repeat(31))), undefined, "a box id that is not 32 bytes");
equal(edited(s => s.get("inputs")[0].get("spendingProof").get("extension").set("128", "0e00")), undefined, "an extension key the node's signed byte cannot hold");
equal(edited(s => s.get("inputs")[0].get("spendingProof").set("extension", new Map(Array.from({ length: 128 }, (_, k) => [String(k), "0e00"])))), undefined,
  "more extension entries than the node writes");
// Cost: the copy is linear in the statement. 30,000 distinct token ids (about a megabyte of JSON) copy in about the time
// of one pass; a lookup per asset over the id list, as an earlier draft did, took seconds.
{
  // 250 outputs of 120 tokens each, a box holding at most 255.
  const statement = structuredClone(sample), template = statement.get("outputs")[0];
  const token = i => new Map([["tokenId", createHash("sha256").update(String(i)).digest("hex")], ["amount", 1n]]);
  statement.set("outputs", Array.from({ length: 250 }, (_, o) => {
    const output = structuredClone(template);
    output.set("assets", Array.from({ length: 120 }, (_, t) => token(o * 120 + t)));
    return output;
  }));
  const t0 = performance.now();
  const copy = copyTransaction(statement);
  const ms = performance.now() - t0;
  equal(copy !== undefined && copy.unsigned.length > 30000 * 33, true, "a many-token statement is copied");
  assert(ms < 1000, `30,000 distinct tokens copy in under a second (took ${ms.toFixed(0)} ms)`);
  checks++;
}
equal(edited(s => s.delete("dataInputs")), undefined, "a missing field");
// Registers are placed by name, so the text's order of them does not matter; an extension's order does, and is kept.
equal(hex(edited(s => { const o = firstWithRegisters(s), r = o.get("additionalRegisters"); o.set("additionalRegisters", new Map([...r].reverse())); }).unsigned),
  hex(supplyTransaction(sample).unsigned), "register order in the text is immaterial");
const withExtension = entries => {
  const statement = structuredClone(sample);
  statement.get("inputs")[0].get("spendingProof").set("extension", new Map(entries));
  return copyTransaction(statement).unsigned;
};
const keyOneFirst = hex(withExtension([["1", "0e0101"], ["0", "0e0100"]])), keyZeroFirst = hex(withExtension([["0", "0e0100"], ["1", "0e0101"]]));
equal([keyOneFirst.includes("0201" + "0e0101" + "00" + "0e0100"), keyZeroFirst.includes("0200" + "0e0100" + "01" + "0e0101")], [true, true],
  "an extension is written in its text's order, entry count first");
equal(supplyTransaction(structuredClone(sample)).unsigned.length + 8, hex(withExtension([["1", "0e0101"], ["0", "0e0100"]])).length / 2, "two entries of a key byte and a 3-byte constant add eight bytes to an empty extension");
// The order-keeping parser: extension keys stay in text order, integers stay exact, anything else is refused.
const parsed = parseNodeJson('{"extension" : {"1" : "0e0101", "0" : "0e0100"}, "value" : 9007199254740993}');
equal([...parsed.get("extension").keys()], ["1", "0"], "text order kept for integer-like keys");
equal(parsed.get("value"), 9007199254740993n, "an integer above 2^53 is exact");
for (const bad of ['{"a":1,"a":2}', '{"a":1.5}', '{"a":"\\u0041"}', '{"a":1} x', '{"a":01}', "[1,]"]) {
  assert.throws(() => parseNodeJson(bad), SyntaxError, bad);
  checks++;
}
assert.throws(() => supplyBlock('{"headerId":"00"}'), /not a block's transactions/);
checks++;

// Headers: every fixture header of version 2–4 is copied to bytes hashing to its id; version 1 and every shape the
// copy cannot reproduce are unsupplied.
const fixtureHeaders = manifest.fixtures.map(fixture => parseNodeJson(readFileSync(`${here}/${fixture.file}`, "utf8")).get("header"));
fixtureHeaders.push(parseNodeJson(readFileSync(`${here}/fixtures/mainnet-genesis-header.json`, "utf8")));
let headersSupplied = 0;
for (const header of fixtureHeaders) {
  const supplied = supplyHeader(header);
  equal(supplied === undefined, header.get("version") < 2n, `header ${header.get("height")} is supplied exactly when its version is 2–4`);
  if (supplied !== undefined) { equal(hex(supplied.id), header.get("id"), "a supplied header hashes to its stated id"); headersSupplied++; }
}
assert(headersSupplied >= 3, "several fixture headers of versions 2–4");
const headerV4 = fixtureHeaders.find(header => header.get("version") === 4n);
const editedHeader = edit => { const copy = structuredClone(headerV4); edit(copy); return supplyHeader(copy); };
equal(editedHeader(header => header.set("unparsedBytes", "")) !== undefined, true, "an empty unparsedBytes is the node's zero length");
for (const [name, edit] of Object.entries({
  wrongId: header => header.set("id", "00".repeat(32)),
  unparsedBytes: header => header.set("unparsedBytes", "00"),
  version5: header => header.set("version", 5n),
  missingNonce: header => header.get("powSolutions").delete("n"),
  shortStateRoot: header => header.set("stateRoot", header.get("stateRoot").slice(2)),
  nBitsAboveU32: header => header.set("nBits", 1n << 32n),
})) equal(editedHeader(edit), undefined, `header ${name} is unsupplied`);

console.log(JSON.stringify({ status: "ok", checks, fixtures: manifest.fixtures.length, transactions, multiEntryExtensions, withRegisters, headersSupplied }));
