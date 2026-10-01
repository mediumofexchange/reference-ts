// Multi-backing runtime journal acceptance with actual holder proofs (slice 7 M2-3):
// one segment over two backings, a split at one backing's term end, and an
// elective rejoin after the witnessed tail, each read per backing by a fresh process;
// a wallet pays in the rejoined scope from a note imported from the split segment.
// --ergo uses the actual publisher and a synthetic mining supplier. No live mode.
// --worker independently reconstructs the venue and reads public evidence only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { serialize, deserialize } from "node:v8";
import { UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../../../dist/record-venue.js";
import { ErgoVenue } from "../../../dist/ergo.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../../../dist/ergo-profile.js";
import { ErgoPublisher, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { BranchSupplier, MiningSupplier, plainBox } from "../../../dist/ergo-synthetic.js";
import { encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR } from "../../../dist/venue-records.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeReceipt } from "../../../dist/pool/v3/commitments.js";
import { decodeEvidencePackage } from "../../../dist/pool/v3/package.js";
import { decodeSegmentHeader, segmentIdentity } from "../../../dist/pool/v3/headers.js";
import { decodeTrail } from "../../../dist/pool/v3/trail.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { V3OperatorJournal, V3StoreError } from "../../../dist/pool/v3/store.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { authorizeIssue, issueTask, spendTask } from "../../../dist/pool/v3/witness.js";
import { decodeRecord, encodeRecord } from "../../../dist/pool/v3/records.js";
import { identifierOf } from "../../../dist/pool/field.js";
import { PROOF_OPTIONS, startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { field } from "../fixtures.mjs";
import { RELATION_KINDS, loadManifest, checkSources, adoptedDomain, readKeys } from "./manifest.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";
import { ERGO_CHAIN, ERGO_PROFILE } from "./ergo-check.mjs";

const here = import.meta.dirname, root = resolve(here, "../../.."), b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex");
const label = b(12), lag = 2n;
const referenceFor = ergo => ergo ? { context: ERGO_SYNTHETIC_REFERENCE, profile: ERGO_PROFILE } : { context: LOCAL_REFERENCE, label, lag };
const summary = result => {
  assert(result.state !== undefined);
  return { issued: String(result.state.issued), burned: String(result.state.burned), position: String(result.state.position),
    spentRoot: hex(result.state.spentRoot()), history: hex(result.state.history),
    canonical: { operator: hex(result.canonical.commitment.operator), sequence: String(result.canonical.commitment.sequence),
      index: String(result.canonical.index) }, carrying: result.carrying };
};

async function worker(directory, ergo) {
  const manifest = loadManifest(); checkSources(manifest);
  const keys = readKeys(directory, manifest);
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; assert(length <= 4_194_304, "worker input budget"); chunks.push(chunk); }
  const input = deserialize(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(input).sort(), ["package", "selection", "venue"]);
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  try {
    const backend = new UltraHonkVerifierBackend(api), verifier = { verify: (kind, publicInputs, proof) =>
      backend.verifyProof({ proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind) }, PROOF_OPTIONS) };
    let venue;
    if (ergo) {
      venue = new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context);
      const answer = await venue.sync([new BranchSupplier("scope-holder", input.venue.tip, ERGO_CHAIN)]);
      assert.equal(hex(answer.witnessedHeaderId), hex(readFileSync(join(directory, "ergo-pin.bin"))));
    } else venue = FixtureVenue.from(input.venue);
    process.stdout.write(JSON.stringify(summary(await readPackage(input.package, input.selection,
      { verifier, venue, reference: referenceFor(ergo) }))));
  } finally { await api.destroy(); }
}

async function acceptance(ergo) {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const scratch = realpathSync(join(root, "scratch")), build = realpathSync(mkdtempSync(join(scratch, "v3-scope-store-")));
  const checks = [], proofs = [], packages = [], transactions = [], started = performance.now(), journals = [];
  const test = async (name, fn) => { await fn(); checks.push(name); process.stderr.write(`passed: ${name}\n`); };
  const refusal = (action, code, check) => assert.rejects(action, error => error instanceof V3StoreError && error.code === code &&
    (check === undefined || error.check === check));
  const sources = sourceClosure(["scripts/pool/v3/scope-store-check.mjs", "scripts/pool/v3/compile.mjs", 
    ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
    "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
  const hashes = sourceHashes(sources);
  let api, prover, completed = false; const wallets = [];
  try {
    const manifest = loadManifest(); checkSources(manifest);
    const domain = adoptedDomain();
    execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
    api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    const programs = Object.fromEntries(RELATION_KINDS.map(([, name]) => [name, JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"))]));
    for (const [kind, name] of RELATION_KINDS) writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS));
    readKeys(build, manifest);
    prover = await openV3Prover(api, programs);
    const prove = async (task, name) => { const began = performance.now(), record = await prover.prove(task);
      proofs.push({ name, kind: task.kind, bytes: record.proof.length, elapsedMs: Math.round(performance.now() - began) }); return record; };
    const reference = referenceFor(ergo), supplier = ergo ? new MiningSupplier("scope-synthetic", ERGO_CHAIN, verifyErgoProof) : undefined;
    const publisher = ergo ? new ErgoPublisher({ secretKey: b(17), suppliers: [supplier.mempool] }) : undefined;
    const venue = ergo ? new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context, {}, publisher) : FixtureVenue.reference(label, lag);
    let pin;
    const advance = async count => {
      if (ergo) {
        assert(count >= 0n && count <= 1024n);
        for (const tx of supplier.mempool.pool) transactions.push({ unsignedBytes: tx.unsigned.length });
        supplier.mine(Number(count)); const synced = await venue.sync([supplier]); assert.equal(synced.unresolvedIndex, undefined); pin = synced.witnessedHeaderId;
      } else venue.advance(venue.witnessedIndex() + count);
    };
    if (ergo) { supplier.mempool.fund(plainBox(publisher.tree, 200_000_000n, ERGO_CHAIN.anchor.height)); await advance(lag); }
    const publishRecord = async (kind, subject, bytes) => { await venue.publishRecord(kind, subject, bytes); if (ergo) await advance(lag); };
    const publish = async journal => { const commitment = await journal.publish(); if (ergo) await advance(lag); return commitment; };
    const checkpoint = async (journal, id) => { await journal.commit(id); return publish(journal); };
    const aSecret = b(16), bSecret = b(18), ruleSecret = b(19), aKey = ed25519.getPublicKey(aSecret), bKey = ed25519.getPublicKey(bSecret);
    const backingOf = (thing, issuer) => {
      const terms = codec.encodeRootTerms({ obligor: ed25519.getPublicKey(issuer), operator: aKey, configuration: domain, venue: venue.id,
        interval: 80n, payout: { thing, quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(ruleSecret) });
      return { name: codec.rootTermsName(terms), issuer, signed: { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuer) } };
    };
    const x = backingOf("scope reference x units", b(15)), y = backingOf("scope reference y units", b(14));
    const create = (name, secret) => { const journal = new V3OperatorJournal(join(build, `${name}.db`),
      { secret, venue, reference, verifier: prover.verifier }); journals.push(journal); return journal; };
    const a = create("a", aSecret), successor = create("b", bSecret);
    const wallet = name => { const opened = new V3Wallet(join(build, `${name}.db`), { verifier: prover.verifier, venue, reference });
      wallets.push(opened); return opened; };
    const payer = wallet("payer"), receiver = wallet("receiver");
    const served = async (journal, backing) => { const value = await journal.package(backing.name); packages.push(value.package.length); return {
      package: value.package, selection: { ...value.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      venue: ergo ? { tip: supplier.tip } : venue.export() }; };
    const read = input => readPackage(input.package, input.selection, { verifier: prover.verifier, venue, reference });
    const fresh = input => {
      if (ergo) writeFileSync(join(build, "ergo-pin.bin"), pin);
      const child = spawnSync(process.execPath, [import.meta.filename, "--worker", build, ...(ergo ? ["--ergo"] : [])],
        { input: serialize(input), cwd: root, timeout: 300_000, windowsHide: true, maxBuffer: 1_048_576 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString()); return JSON.parse(child.stdout.toString());
    };
    // Both backings' fresh-process verdicts equal the in-process reads; shared history is one.
    const both = async (journal, supplies) => {
      const results = [];
      for (const [backing, issued] of [[x, supplies[0]], [y, supplies[1]]]) {
        const input = await served(journal, backing), result = summary(await read(input));
        assert.equal(result.issued, String(issued)); assert.deepEqual(fresh(input), result); results.push(result);
      }
      assert.equal(results[0].history, results[1].history);
      return results;
    };
    // The served commitment's segment: the operator's latest header opened at or before its sequence.
    const contextOf = async (journal, backing) => {
      const input = await served(journal, backing);
      const header = decodeEvidencePackage(input.package).filter(item => item.kind === 6)
        .map(item => decodeSegmentHeader(decodeTrail(item.payload).header))
        .filter(h => hex(h.operator) === hex(input.selection.operator) && h.sequence <= input.selection.sequence)
        .reduce((best, h) => best === undefined || h.sequence > best.sequence ? h : best, undefined);
      assert(header !== undefined, "the served commitment must have its segment header");
      return { domain, header };
    };
    const replace = async (secret, predecessor) => {
      // Include one publication lag before the lead floor, then one spare index.
      const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(secret), predecessor,
        effective: venue.witnessedIndex() + 3n * lag + 2n, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
      const message = replacementMessage(x.name, fields), replacement = { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, secret) };
      await publishRecord(2, x.name, encodeReplacement(x.name, replacement));
      return { effective: fields.effective, link: replacementHash(x.name, replacement) };
    };
    const force = async replacement => { const wait = replacement.effective - venue.witnessedIndex(); if (wait > 0n) await advance(wait); };
    const output = (backing, seed, id, value) => prepareExactOutput(seed, domain, b(id), backing.name, value);
    const input = (note, tree, leaf) => ({ note, anchor: tree.root(), path: tree.path(leaf) });
    const fundedX = output(x, b(21), 31, 10n), fundedY = output(y, b(21), 32, 20n), shared = new NoteTree();
    shared.appendAll([fundedX.cm, fundedY.cm]);
    const paidX = [7n, 3n, 0n, 0n].map((value, i) => output(x, b(22), 40 + i, value));
    const paidY = [15n, 5n, 0n, 0n].map((value, i) => output(y, b(22), 50 + i, value));
    let toB, publicA, final;
    await test("A opens one segment over two backings, issues each with a real proof, and fresh readers verify both supplies", async () => {
      await a.open("genesis", [x.signed, y.signed]); await publish(a);
      const context = await contextOf(a, x);
      assert.deepEqual(context.header.entries.map(entry => hex(entry.backing)), [x.name, y.name].map(hex).sort());
      await a.submit(encodeRecord(authorizeIssue(await prove(issueTask(context, fundedX), "A issue x 10"), x.issuer)));
      await a.submit(encodeRecord(authorizeIssue(await prove(issueTask(context, fundedY), "A issue y 20"), y.issuer)));
      await checkpoint(a, "issued"); publicA = await served(a, x);
      await both(a, [10n, 20n]);
    });
    await test("B takes x from the shared checkpoint while A continues y alone from the same checkpoint", async () => {
      toB = await replace(bSecret, x.name); await force(toB);
      await refusal(a.commit("ended"), "STALE");
      await refusal(a.rescope("keep-ended", { keep: [x.name, y.name] }), "STALE");
      assert.equal((await successor.takeover("take-x", x.signed, publicA.package)).sequence, 1n);
      assert.equal((await a.rescope("split", { keep: [y.name] })).sequence, 3n);
      await refusal(a.commit("before-adoption"), "STALE");
      for (const journal of [successor, a]) { await publish(journal); assert.deepEqual(await journal.adopt(), []); }
      const [contextB, contextA] = [await contextOf(successor, x), await contextOf(a, y)];
      for (const [context, backing, link] of [[contextB, x, toB.link], [contextA, y, y.name]]) {
        assert.equal(context.header.entries.length, 1); const [entry] = context.header.entries;
        assert.equal(hex(entry.backing), hex(backing.name)); assert.equal(hex(entry.link), hex(link));
        assert.equal(hex(entry.opening.operator), hex(aKey)); assert.equal(entry.opening.sequence, publicA.selection.sequence);
      }
      const spendX = await prove(spendTask(contextB, [input(fundedX, shared, 0n), input(output(x, b(21), 33, 0n), shared, 0n)], paidX), "B x spend");
      const spendY = await prove(spendTask(contextA, [input(fundedY, shared, 1n), input(output(y, b(21), 34, 0n), shared, 1n)], paidY), "A y spend");
      assert.equal(decodeReceipt(await successor.submit(encodeRecord(spendX))).position, 1n);
      assert.equal(decodeReceipt(await a.submit(encodeRecord(spendY))).position, 1n);
      await checkpoint(successor, "spent-x"); await checkpoint(a, "spent-y");
      for (const [journal, backing, issued] of [[successor, x, 10n], [a, y, 20n]]) {
        const evidence = await served(journal, backing), result = summary(await read(evidence));
        assert.equal(result.issued, String(issued)); assert.equal(result.position, "1"); assert.deepEqual(fresh(evidence), result);
      }
    });
    await test("an elective rejoin waits for the witnessed tail; the joined scope spends x and y under distinct roots", async () => {
      const toA = await replace(aSecret, toB.link); await force(toA);
      await refusal(successor.commit("ended-b"), "STALE");
      const evidence = (await served(successor, x)).package, split = await contextOf(a, y);
      const funding = payer.request("fund-y", y.name, 5n);
      await a.submit(encodeRecord(authorizeIssue(await prove(issueTask(split, funding), "A issue y 5 to the wallet before rejoin"), y.issuer)));
      const rejoin = { take: [x.signed], keep: [y.name], evidence };
      await refusal(a.rescope("rejoin", rejoin), "STALE", "TAIL");
      await checkpoint(a, "issued-y");
      const opening = await a.rescope("rejoin", rejoin);
      assert.deepEqual(await a.rescope("rejoin", rejoin), opening);
      await publish(a); assert.deepEqual(await a.adopt(), []);
      const joined = await contextOf(a, x);
      assert.deepEqual(joined.header.entries.map(entry => hex(entry.opening.operator)).sort(), [aKey, bKey].map(hex).sort());
      const treeX = new NoteTree(), treeY = new NoteTree(); treeX.appendAll(paidX.map(o => o.cm)); treeY.appendAll(paidY.map(o => o.cm));
      assert.notEqual(treeX.root(), treeY.root());
      const mixed = [output(x, b(23), 60, 7n), output(y, b(23), 61, 15n), output(x, b(23), 62, 0n), output(y, b(23), 63, 0n)];
      const spend = await prove(spendTask(joined, [input(paidX[0], treeX, 0n), input(paidY[0], treeY, 0n)], mixed), "A joined mixed spend");
      assert.equal(decodeReceipt(await a.submit(encodeRecord(spend))).position, 1n);
      await checkpoint(a, "mixed");
      assert(summary(await read(await served(a, y))).position === "1");
    });
    await test("a wallet restores its imported y note from the rejoined package and pays a request with a real proof in that scope", async () => {
      const joined = await contextOf(a, y), held = (await served(a, y)).package;
      const before = await payer.sync(held, y.signed);
      assert.deepEqual(before.holdings.map(h => [h.value, h.status]), [[5n, "available"]]);
      const invoice = receiver.request("invoice", y.name, 3n);
      const payment = await payer.prepare("shop", { request: invoice, value: 3n }, held, y.signed, task => prove(task, "wallet y spend in joined scope"));
      const p = decodeRecord(payment.record).publicInputs;
      assert.equal(hex(identifierOf(p[2], p[3])), hex(segmentIdentity(joined.header)));
      const receipt = await payer.submit("shop", { submit: async bytes => decodeReceipt(await a.submit(bytes)) });
      assert.equal(receipt.position, 2n);
      await checkpoint(a, "wallet");
      const paid = (await served(a, y)).package;
      assert.equal((await receiver.fulfill("invoice", paid, y.signed)).request.cm, invoice.cm);
      const after = await payer.sync(paid, y.signed);
      assert.deepEqual(after.holdings.map(h => [h.value, h.status]), [[2n, "available"]]);
      assert.equal(payer.payment("shop").status, "final");
      final = await both(a, [10n, 25n]);
      assert(final.every(result => result.position === "2" && result.carrying.every(item => item.class === "valid")));
    });
    checkSources(manifest); assert.deepEqual(sourceHashes(sources), hashes, "sources changed during acceptance");
    const report = { status: "passed", specification: V3_SPECIFICATION,
      evidence: ergo ? "synthetic-ergo-runtime-real-proofs" : "local-runtime-real-proofs",
      limits: ["the adopted configuration on reference venues only", "two backings, one operator per term", "one wallet payment, in the rejoined scope", "no live broadcasts",
        "no persistence claim", "empty recovery blocks; forced recovery over a scope is oracle-proof only"],
      checks, proofs, transactions, maxPackageBytes: Math.max(...packages),
      final: { x: final[0], y: final[1] }, elapsedMs: Math.round(performance.now() - started), sourceSha256Lf: hashes };
    writeFileSync(join(root, "docs", `pool-v3-scope-store${ergo ? "-ergo" : ""}-verification.json`), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n"); completed = true;
  } finally {
    for (const opened of [...journals, ...wallets]) opened.close(); await prover?.close(); await api?.destroy();
    if (completed) { assert(build.startsWith(scratch + sep)); rmSync(build, { recursive: true, force: true }); }
    else process.stderr.write(`Scope acceptance scratch retained after failure: ${build}\n`);
  }
}

if (process.argv[2] === "--worker") {
  assert(process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === "--ergo"));
  await worker(process.argv[3], process.argv[4] === "--ergo");
} else {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--ergo"), "scope-store-check takes only --ergo");
  await acceptance(process.argv[2] === "--ergo");
}
