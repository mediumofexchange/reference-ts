// The runtime's Ergo publisher (src/ergo-publisher.ts) on a live node. TESTNET ONLY: the script refuses any node
// whose /info does not report the testnet, and the funding key is the experiment's throwaway key from an ignored
// file under scratch/. It is run explicitly, never by `check` or CI, because it submits transactions.
//
// Checks:
// - a commitment, a replacement and a revocation record, each really signed by its own key, are published as three
//   transactions chained in the mempool (each spends the previous one's change), built and signed by the runtime
//   alone (@noble/curves; no Ergo library);
// - before each submission the node checks the transaction (/transactions/checkBytes) and refuses the same bytes
//   with one byte of the first proof changed;
// - publishing a record again returns the transaction already sent and submits nothing;
// - once each transaction is `--depth` blocks deep, its block's section, fetched from the node and accepted only
//   where it reproduces the header's transaction root, carries exactly the three records at their kinds, subjects
//   and ordinals under the profile's attribution.
// The testnet has no verified header view here (the runtime's header rules are the mainnet's), so the outputs'
// creation height is the node's full height and the header is the node's word; the root binds the section to it.
// Usage, from the repository root on Node 24 with the own testnet node (extraIndex) running:
//   node experiments/ergo-range/publisher-check.mjs [--node http://127.0.0.1:9052]
//     [--wallet scratch/ergo-testnet/wallet.json] [--depth 2] [--max-wait 60] [--out docs/ergo-publisher-verification.json]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";

const here = import.meta.dirname, root = resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const nodeUrl = option("--node", "http://127.0.0.1:9052").replace(/\/$/, "");
const walletFile = resolve(root, option("--wallet", "scratch/ergo-testnet/wallet.json"));
const depth = BigInt(option("--depth", "2")), maxWaitMinutes = Number(option("--max-wait", "60")), out = option("--out");
assert(depth >= 1n && depth < 64n && maxWaitMinutes > 0, "usage: [--depth d] [--max-wait min]");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
const fileHash = file => hex(sha256(readFileSync(join(root, file))));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The sources are hashed now, before any work, so the report names the files that produced it.
const files = Object.fromEntries(["experiments/ergo-range/publisher-check.mjs", "experiments/ergo-range/package.json",
  "experiments/ergo-range/package-lock.json", "tsconfig.json"].map(file => [file, fileHash(file)]));

async function node(method, path, body) {
  const response = await fetch(`${nodeUrl}${path}`, { method, signal: AbortSignal.timeout(30000),
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { status: response.status, text: await response.text() };
}
const info = JSON.parse((await node("GET", "/info")).text);
assert.equal(info.network, "testnet", "the node is not a testnet node");

mkdirSync(join(root, "scratch"), { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "ergo-publisher-check-")));
const url = pathToFileURL(build + sep).href;
let report;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert(!config.error, "TypeScript configuration unreadable");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(["src/ergo-publisher.ts", "src/ergo-supplier.ts", "src/ergo-profile.ts", "src/ergo-headers.ts",
    "src/commitment.ts", "src/replacement.ts", "src/revocation.ts"].map(f => join(root, f)), {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0, "the runtime compiles");
  assert.equal(program.emit().emitSkipped, false);
  // Every repository source the compilation reads is bound.
  for (const source of program.getSourceFiles()) {
    const path = resolve(source.fileName);
    if (path.startsWith(root + sep) && !path.includes(`${sep}node_modules${sep}`)) files[path.slice(root.length + 1).replace(/\\/g, "/")] = fileHash(path.slice(root.length + 1));
  }
  const { ErgoPublisher, payToPublicKeyTree, DEFAULT_ERGO_FEE, DEFAULT_MIN_VALUE_PER_BYTE } = await import(new URL("src/ergo-publisher.js", url));
  const { ergoNodeSupplier } = await import(new URL("src/ergo-supplier.js", url));
  const { attributeSection, ergoOrdinal, ownErgoProfile } = await import(new URL("src/ergo-profile.js", url));
  const { parseErgoHeader } = await import(new URL("src/ergo-headers.js", url));
  const { encodeCommitment, signCommitment } = await import(new URL("src/commitment.js", url));
  const { encodeReplacement, replacementMessage, ROLE_OPERATOR } = await import(new URL("src/replacement.js", url));
  const { encodeRevocation, signRevocation } = await import(new URL("src/revocation.js", url));

  const minValuePerByte = BigInt(info.parameters.minValuePerByte);
  assert.equal(minValuePerByte, DEFAULT_MIN_VALUE_PER_BYTE, "the testnet's minValuePerByte is the runtime default");
  const wallet = JSON.parse(readFileSync(walletFile, "utf8"));
  assert.equal(wallet.network, "testnet");
  const secretKey = Buffer.from(wallet.secretHex, "hex");
  const tree = payToPublicKeyTree(secp256k1.getPublicKey(secretKey, true));
  assert.equal(hex(tree), wallet.ergoTree);

  // Three locations and a fourth, pay-to-public-key trees of keys derived here; the anchor is only named.
  const derived = label => sha256(`moe/experiment/ergo-publisher/${label}`);
  const location = k => payToPublicKeyTree(secp256k1.getPublicKey(derived(`location/${k}`), true));
  const startHeight = BigInt(info.fullHeight);
  const [startHeader] = await ergoNodeSupplier(nodeUrl).headers(startHeight, startHeight);
  const profile = ownErgoProfile({ anchor: blake2b(startHeader, { dkLen: 32 }), depth, scripts: { 1: location(1), 2: location(2), 3: location(3), 4: location(4) } });

  // The records, each signed by its own key.
  const operatorSecret = derived("operator"), backerSecret = derived("backer"), successorSecret = derived("successor");
  const commitment = signCommitment(operatorSecret, 1n, derived("root"));
  const backingName = derived("backing");
  const unsigned = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(successorSecret), predecessor: backingName,
    effective: 1_000n, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
  const message = replacementMessage(backingName, unsigned);
  const replacement = { ...unsigned, signature: ed25519.sign(message, backerSecret), successorSignature: ed25519.sign(message, successorSecret) };
  const revocation = signRevocation(backerSecret);
  const records = [
    { kind: 1, name: "commitment", subject: commitment.operator, record: encodeCommitment(commitment) },
    { kind: 2, name: "replacement", subject: backingName, record: encodeReplacement(backingName, replacement) },
    { kind: 3, name: "revocation", subject: revocation.obligor, record: encodeRevocation(revocation) },
  ];
  assert.deepEqual(records.map(r => r.record.length), [136, 233, 96]);

  // The node, checked before every submission: the true bytes pass, one changed proof byte fails.
  const supplier = ergoNodeSupplier(nodeUrl, { name: "own testnet node" });
  const checks = [];
  const checking = {
    name: supplier.name, unspentBoxes: t => supplier.unspentBoxes(t), hasBox: id => supplier.hasBox(id),
    async submit(signed, id) {
      const corrupted = Uint8Array.from(signed);
      corrupted[1 + 32 + 1 + 30] ^= 0x01; // inside the first input's proof, after its count, id and length
      const bad = await node("POST", "/transactions/checkBytes", hex(corrupted));
      const good = await node("POST", "/transactions/checkBytes", hex(signed));
      checks.push({ id: hex(id), corruptedStatus: bad.status, trueStatus: good.status, trueAnswer: good.text.replace(/\s+/g, "") });
      return supplier.submit(signed, id);
    },
  };
  const submitted = [];
  const counting = { ...checking, submit: (signed, id) => { submitted.push(hex(id)); return checking.submit(signed, id); } };
  const publisher = new ErgoPublisher({ secretKey, suppliers: [counting] });

  const publications = [];
  for (const r of records) {
    const publication = await publisher.publish({ location: profile.scripts[r.kind], subject: r.subject, record: r.record, height: startHeight });
    publications.push({ ...r, publication });
  }
  // Chained: each publication after the first spends the one before's change.
  for (let i = 1; i < publications.length; i++) {
    assert.deepEqual(publications[i].publication.inputs.map(hex), [hex(publications[i - 1].publication.change.id)]);
  }
  assert(checks.every(c => c.corruptedStatus === 400 && c.trueStatus === 200), "the node checked every transaction and refused every corruption");
  // Publishing again returns the same transaction and submits nothing.
  const again = await publisher.publish({ location: profile.scripts[1], subject: records[0].subject, record: records[0].record, height: startHeight });
  assert.equal(hex(again.id), hex(publications[0].publication.id));
  assert.equal(submitted.length, 3, "a repeated publication submits nothing");
  // The node's answer to the same bytes a second time, recorded as it is.
  const duplicate = await node("POST", "/transactions/bytes", hex(publications[0].publication.signed));

  // Wait for every transaction to be `depth` blocks deep.
  const deadline = Date.now() + maxWaitMinutes * 60_000;
  const inclusion = new Map();
  for (;;) {
    for (const { publication } of publications) {
      if (inclusion.has(hex(publication.id))) continue;
      const answer = await node("GET", `/blockchain/transaction/byId/${hex(publication.id)}`);
      if (answer.status === 200) inclusion.set(hex(publication.id), BigInt(JSON.parse(answer.text).inclusionHeight));
    }
    const full = BigInt(JSON.parse((await node("GET", "/info")).text).fullHeight);
    if (inclusion.size === publications.length && [...inclusion.values()].every(h => full >= h + depth)) break;
    assert(Date.now() < deadline, "the transactions were not final in time");
    await sleep(20_000);
  }

  // Read each including block back under the profile: the section counts only where it reproduces the header's root.
  const readBack = [];
  for (const height of [...new Set(inclusion.values())].sort((a, b) => (a < b ? -1 : 1))) {
    const [bytes] = await supplier.headers(height, height);
    const header = parseErgoHeader(bytes);
    const section = await supplier.section(header.id);
    const objects = attributeSection(profile, section, header.transactionsRoot);
    assert(objects !== undefined, "the section reproduces its header's root");
    readBack.push({ height: height.toString(), headerId: hex(header.id), transactions: section.length,
      objects: objects.map(o => ({ kind: o.kind, subject: hex(o.subject), ordinal: o.ordinal.toString(), recordSha256: hex(sha256(o.record)) })) });
    for (const { kind, subject, record, publication } of publications) {
      if (inclusion.get(hex(publication.id)) !== height) continue;
      const position = section.findIndex(t => hex(blake2b(t.unsigned, { dkLen: 32 })) === hex(publication.id));
      const found = objects.filter(o => o.kind === kind && hex(o.subject) === hex(subject));
      assert.equal(found.length, 1, `one kind-${kind} object under its subject`);
      assert.equal(hex(found[0].record), hex(record));
      assert.equal(found[0].ordinal, ergoOrdinal(position, 0));
    }
  }

  report = {
    status: "Live testnet run of the runtime publisher: three records signed by their own keys, published as chained transactions " +
      "built and signed without an Ergo library, checked by the node (a changed proof byte refused), not resubmitted when published " +
      "again, and read back from each including block under the profile's attribution with exact bytes.",
    node: { url: nodeUrl, name: info.name, appVersion: info.appVersion, network: info.network, startHeight: startHeight.toString(),
      minValuePerByte: minValuePerByte.toString() },
    fee: DEFAULT_ERGO_FEE.toString(),
    profile: { depth: depth.toString(), locations: Object.fromEntries(Object.entries(profile.scripts).map(([k, v]) => [k, hex(v)])) },
    publications: publications.map(({ kind, name, subject, record, publication }) => ({
      kind, name, subject: hex(subject), recordBytes: record.length, recordSha256: hex(sha256(record)), txId: hex(publication.id),
      inputs: publication.inputs.map(hex), unsignedBytes: publication.unsigned.length, signedBytes: publication.signed.length,
      change: publication.change?.value.toString() ?? null, inclusionHeight: inclusion.get(hex(publication.id)).toString(),
    })),
    nodeChecks: checks,
    republished: { txId: hex(again.id), submissions: submitted.length },
    duplicateSubmission: { status: duplicate.status, answer: duplicate.text.replace(/\s+/g, " ").slice(0, 300) },
    readBack,
    files,
    limitations: [
      "Testnet acceptance is not mainnet acceptance; the transaction rules exercised (signatures, value balance, minimum box value, " +
        "fee, creation heights) are the same node release's, but no mainnet transaction was sent.",
      "The creation height is the node's full height and the headers are the node's word: the runtime's verified header view " +
        "follows the mainnet's rules only. The root binds each section to its header.",
      "One node, the own one, was the only supplier; propagation to other nodes and miners was not measured separately.",
    ],
  };
} finally {
  rmSync(build, { recursive: true, force: true });
}
const text = JSON.stringify(report, null, 2) + "\n";
if (out) writeFileSync(resolve(root, out), text);
console.log(text);
