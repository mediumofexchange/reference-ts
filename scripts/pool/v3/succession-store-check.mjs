// Single-backing runtime succession acceptance with actual holder proofs.
// --ergo uses the actual publisher and a synthetic mining supplier. No live mode.
// --worker independently reconstructs the venue and reads public evidence only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { directoryRoot, encodeCommitment, encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR,
  signCommitment, encodeRevocation, signRevocation } from "../../../dist/venue-records.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeReceipt, decodeSnapshot, snapshotBytes, snapshotDigest } from "../../../dist/pool/v3/commitments.js";
import { decodeEvidencePackage, encodeEvidencePackage, encodeEvidenceDirectory } from "../../../dist/pool/v3/package.js";
import { decodeSegmentHeader } from "../../../dist/pool/v3/headers.js";
import { decodeTrail } from "../../../dist/pool/v3/trail.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { SERVED_PACKAGE_LIMITS, V3OperatorJournal, V3StoreError } from "../../../dist/pool/v3/store.js";
import { authorizeIssue, issueTask, spendTask } from "../../../dist/pool/v3/witness.js";
import { encodeRecord } from "../../../dist/pool/v3/records.js";
import { PROOF_OPTIONS, startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { field } from "../fixtures.mjs";
import { RELATION_KINDS, loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys } from "./candidate.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";
import { ERGO_CHAIN, ERGO_PROFILE } from "./ergo-check.mjs";

const here = import.meta.dirname, root = resolve(here, "../../.."), b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex"), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const label = b(12), lag = 2n;
const referenceFor = ergo => ergo ? { context: ERGO_SYNTHETIC_REFERENCE, profile: ERGO_PROFILE } : { context: LOCAL_REFERENCE, label, lag };
const summary = result => {
  assert(result.state !== undefined);
  return { supply: String(result.state.issued - result.state.burned), position: String(result.state.position),
    spentRoot: hex(result.state.spentRoot()), history: hex(result.state.history),
    canonical: { operator: hex(result.canonical.commitment.operator), sequence: String(result.canonical.commitment.sequence),
      index: String(result.canonical.index) }, carrying: result.carrying };
};

async function worker(directory, ergo) {
  const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
  const configuration = candidateConfiguration(manifest, codec), keys = readCandidateKeys(directory, manifest);
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
      const answer = await venue.sync([new BranchSupplier("succession-holder", input.venue.tip, ERGO_CHAIN)]);
      assert.equal(hex(answer.witnessedHeaderId), hex(readFileSync(join(directory, "ergo-pin.bin"))));
    } else venue = FixtureVenue.from(input.venue);
    process.stdout.write(JSON.stringify(summary(await readPackage(input.package, input.selection,
      { configuration, verifier, venue, reference: referenceFor(ergo) }))));
  } finally { await api.destroy(); }
}

async function acceptance(ergo) {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const scratch = realpathSync(join(root, "scratch")), build = realpathSync(mkdtempSync(join(scratch, "v3-succession-store-")));
  const checks = [], proofs = [], packages = [], transactions = [], started = performance.now(), journals = [];
  const test = async (name, fn) => { await fn(); checks.push(name); process.stderr.write(`passed: ${name}\n`); };
  const refusal = (action, code, check) => assert.rejects(action, error => error instanceof V3StoreError && error.code === code &&
    (check === undefined || error.check === check));
  const sources = sourceClosure(["scripts/pool/v3/succession-store-check.mjs", "scripts/pool/v3/compile.mjs", "scripts/pool/v3/candidate-manifest.json",
    ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
    "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
  const hashes = sourceHashes(sources);
  let api, prover, completed = false;
  try {
    const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
    const configuration = candidateConfiguration(manifest, codec), domain = codec.configurationHash(configuration);
    execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
    api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    const programs = Object.fromEntries(RELATION_KINDS.map(([, name]) => [name, JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"))]));
    for (const [kind, name] of RELATION_KINDS) writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS));
    readCandidateKeys(build, manifest);
    prover = await openV3Prover(api, programs, configuration);
    const prove = async (task, name) => { const began = performance.now(), record = await prover.prove(task);
      proofs.push({ name, kind: task.kind, bytes: record.proof.length, elapsedMs: Math.round(performance.now() - began) }); return record; };
    const reference = referenceFor(ergo), supplier = ergo ? new MiningSupplier("succession-synthetic", ERGO_CHAIN, verifyErgoProof) : undefined;
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
    const issuerSecret = b(15), aSecret = b(16), bSecret = b(18), ruleSecret = b(19);
    const issuer = ed25519.getPublicKey(issuerSecret), aKey = ed25519.getPublicKey(aSecret), bKey = ed25519.getPublicKey(bSecret);
    const terms = codec.encodeRootTerms({ obligor: issuer, operator: aKey, configuration: domain, venue: venue.id, interval: 80n,
      payout: { thing: "succession reference units", quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(ruleSecret) });
    const backing = codec.rootTermsName(terms), signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
    const create = (name, secret) => { const journal = new V3OperatorJournal(join(build, `${name}.db`),
      { configuration, secret, venue, reference, verifier: prover.verifier }); journals.push(journal); return journal; };
    const a = create("a", aSecret), successor = create("b", bSecret);
    const served = async journal => { const value = await journal.package(); packages.push(value.package.length); return {
      package: value.package, selection: { ...value.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      venue: ergo ? { tip: supplier.tip } : venue.export() }; };
    const read = input => readPackage(input.package, input.selection, { configuration, verifier: prover.verifier, venue, reference, witness: () => true });
    const fresh = input => {
      if (ergo) writeFileSync(join(build, "ergo-pin.bin"), pin);
      const child = spawnSync(process.execPath, [import.meta.filename, "--worker", build, ...(ergo ? ["--ergo"] : [])],
        { input: serialize(input), cwd: root, timeout: 300_000, windowsHide: true, maxBuffer: 1_048_576 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString()); return JSON.parse(child.stdout.toString());
    };
    const contextOf = input => {
      const trail = decodeEvidencePackage(input.package).filter(item => item.kind === 6).map(item => decodeTrail(item.payload))
        .find(item => { const header = decodeSegmentHeader(item.header); return hex(header.operator) === hex(input.selection.operator) && header.sequence === input.selection.sequence; });
      assert(trail !== undefined, "the selected empty opening must have its exact segment header");
      return { domain, header: decodeSegmentHeader(trail.header) };
    };
    const replace = async (secret, predecessor) => {
      // Include one publication lag before the lead floor, then one spare index.
      const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(secret), predecessor,
        effective: venue.witnessedIndex() + 3n * lag + 2n, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
      const message = replacementMessage(backing, fields), replacement = { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, secret) };
      await publishRecord(2, backing, encodeReplacement(backing, replacement));
      return { effective: fields.effective, link: replacementHash(backing, replacement) };
    };
    const force = async replacement => { const wait = replacement.effective - venue.witnessedIndex(); if (wait > 0n) await advance(wait); };
    const outputs = (seed, first, values) => values.map((value, index) => prepareExactOutput(seed, domain, b(first + index), backing, value));
    const funded = outputs(b(21), 31, [10n])[0], pad = outputs(b(21), 32, [0n])[0], tree = new NoteTree(); tree.append(funded.cm);
    const input = { note: funded, anchor: tree.root(), path: tree.path(0n) }, inputs = [input, { ...input, note: pad }];
    let publicA, publicB, finalInput, final;
    await test("A issues with a real proof and a fresh public reader verifies supply", async () => {
      await a.open("genesis", signed); await publish(a);
      const context = { domain, header: { domain, venue: venue.id, operator: aKey, sequence: 1n, entries: [{ backing, link: backing }] } };
      await a.submit(encodeRecord(authorizeIssue(await prove(issueTask(context, funded), "A issue 10"), issuerSecret)));
      await checkpoint(a, "issued"); publicA = await served(a);
      const result = await read(publicA); assert.equal(result.state.issued, 10n); assert.deepEqual(fresh(publicA), summary(result));
    });
    await test("unauthorized and pending takeover refuse; incumbent-self replacement cancels handover", async () => {
      await refusal(successor.takeover("not-appointed", signed, publicA.package), "STALE");
      await replace(bSecret, backing);
      await refusal(successor.takeover("pending", signed, publicA.package), "STALE");
      const cancel = await replace(aSecret, backing); await force(cancel);
      await refusal(successor.takeover("cancelled", signed, publicA.package), "STALE");
      await checkpoint(a, "after-cancellation"); publicA = await served(a);
    });
    let toB;
    await test("B takes over only at force from complete public ancestry and witnesses before service", async () => {
      toB = await replace(bSecret, backing); await force(toB);
      await refusal(a.commit("ended-a"), "STALE");
      const items = decodeEvidencePackage(publicA.package);
      for (const kind of [3, 4, 6]) await refusal(successor.takeover(`missing-${kind}`, signed,
        encodeEvidencePackage(items.filter(item => item.kind !== kind))), "UNAVAILABLE");
      const opening = await successor.takeover("takeover-b", signed, publicA.package);
      assert.equal(opening.sequence, 1n, "B has its own signed counter");
      assert.deepEqual(await successor.takeover("takeover-b", signed, publicA.package), opening);
      await refusal(successor.commit("before-adoption"), "STALE");
      await refusal(successor.adopt(), "UNAVAILABLE");
      await publish(successor); publicB = await served(successor);
      assert.deepEqual(await successor.adopt(), []);
      assert.deepEqual(fresh(publicB), summary(await read(publicB)));
    });
    await test("B spends the inherited note with a real proof and preserves A's finality", async () => {
      const result = await read(publicB), placed = result.state.path(funded.cm);
      assert(placed !== undefined); assert.equal(placed.anchor, tree.root());
      assert.deepEqual(placed.path, input.path);
      const context = contextOf(publicB), paid = outputs(b(22), 40, [7n, 3n, 0n, 0n]);
      const receipt = await successor.submit(encodeRecord(await prove(spendTask(context, inputs, paid), "B inherited spend")));
      assert.equal(decodeReceipt(receipt).after, 1n);
      await checkpoint(successor, "spent"); publicB = await served(successor);
      const state = await read(publicB); assert(state.state.hasNullifier(funded.nf)); assert.equal(state.state.issued, 10n);
      assert.deepEqual(fresh(publicB), summary(state));
      assert(state.carrying.filter(item => item.operator === hex(aKey)).every(item => item.class === "valid"));
    });
    await test("A reappointment imports B's state and keeps A's own counter and imported replay protection", async () => {
      const toA = await replace(aSecret, toB.link); await force(toA);
      await refusal(successor.commit("ended-b"), "STALE");
      const opening = await a.takeover("takeover-a", signed, publicB.package);
      assert.equal(opening.sequence, publicA.selection.sequence + 1n);
      await publish(a); const opened = await served(a), context = contextOf(opened); await a.adopt();
      const repeated = await prove(spendTask(context, inputs, outputs(b(22), 50, [6n, 4n, 0n, 0n])), "A imported double spend refused");
      await refusal(a.submit(encodeRecord(repeated)), "REFUSED", "SPENT");
      const late = encodeRecord(authorizeIssue(await prove(issueTask(context, outputs(b(21), 60, [1n])[0]), "A revoked issue refused"), issuerSecret));
      await publishRecord(3, issuer, encodeRevocation(signRevocation(issuerSecret)));
      await refusal(a.submit(late), "REFUSED", "REVOKED");
      await checkpoint(a, "reappointed"); finalInput = await served(a); final = summary(await read(finalInput));
      assert.equal(final.supply, "10"); assert.equal(final.position, "0"); assert.deepEqual(fresh(finalInput), final);
    });
    await test("an authentic hostile checkpoint is excluded only with complete authenticated evidence", async () => {
      const items = decodeEvidencePackage(finalInput.package), state = await read(finalInput);
      const original = items.filter(item => item.kind === 4).map(item => decodeSnapshot(item.payload)).find(snapshot => hex(snapshot.segment) === hex(state.canonical.segment));
      assert(original !== undefined);
      const invalid = { ...original, issued: original.issued + 1n }, directory = [{ name: backing, digest: snapshotDigest(invalid) }];
      const hostile = signCommitment(aSecret, finalInput.selection.sequence + 1n, directoryRoot(directory));
      await publishRecord(1, aKey, encodeCommitment(hostile));
      const extra = [{ kind: 3, payload: encodeEvidenceDirectory(directory) }, { kind: 4, payload: snapshotBytes(invalid) }];
      const all = [...items, ...extra].sort((left, right) => left.kind - right.kind || hash(left.payload).localeCompare(hash(right.payload)));
      const evidence = { ...finalInput, package: encodeEvidencePackage(all),
        selection: { ...finalInput.selection, judgingIndex: venue.witnessedIndex() }, venue: ergo ? { tip: supplier.tip } : venue.export() };
      const answer = await read(evidence); assert.equal(answer.carrying.at(-1).class, "excluded"); assert.equal(answer.carrying.at(-1).check, "SNAPSHOT");
      assert.equal(answer.state.issued, 10n); assert.deepEqual(fresh(evidence), summary(answer));
      const inherited = all.find(item => item.kind === 6 && hex(decodeSegmentHeader(decodeTrail(item.payload).header).operator) === hex(bKey));
      assert(inherited !== undefined);
      await assert.rejects(read({ ...evidence, package: encodeEvidencePackage(all.filter(item => item !== inherited)) }),
        error => error.status === "unresolved-evidence");
      packages.push(evidence.package.length); final = summary(answer);
    });
    checkCandidateSources(manifest); assert.deepEqual(sourceHashes(sources), hashes, "sources changed during acceptance");
    assert(Math.max(...packages) + 360 <= Number(SERVED_PACKAGE_LIMITS.maxBytes));
    const report = { status: "passed", specification: V3_SPECIFICATION,
      evidence: ergo ? "synthetic-ergo-runtime-real-proofs" : "local-runtime-real-proofs",
      limits: ["candidate configuration only", "single backing", "no live broadcasts", "no persistence or configuration adoption claim", "empty recovery block; forced recovery acceptance is separate"],
      checks, proofs, transactions, maxPackageBytes: Math.max(...packages), receiptHeadroomBytes: 360, final,
      elapsedMs: Math.round(performance.now() - started), sourceSha256Lf: hashes };
    writeFileSync(join(root, "docs", `pool-v3-succession-store${ergo ? "-ergo" : ""}-verification.json`), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n"); completed = true;
  } finally {
    for (const journal of journals) journal.close(); await prover?.close(); await api?.destroy();
    if (completed) { assert(build.startsWith(scratch + sep)); rmSync(build, { recursive: true, force: true }); }
    else process.stderr.write(`Succession acceptance scratch retained after failure: ${build}\n`);
  }
}

if (process.argv[2] === "--worker") {
  assert(process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === "--ergo"));
  await worker(process.argv[3], process.argv[4] === "--ergo");
} else {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--ergo"), "succession-store-check takes only --ergo");
  await acceptance(process.argv[2] === "--ergo");
}
