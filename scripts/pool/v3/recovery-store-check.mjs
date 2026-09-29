// Runtime slice-3 acceptance: real holder/backer proofs, journal service,
// disappearance, publication force, return and exact adoption. --ergo uses
// the synthetic mining supplier and actual publisher. Live publication requires
// both --testnet and --authorized-testnet and a pre-submission count/spend guard.
// --worker is a fresh holder-only runtime reader: no journal or private seed.
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
import { DEFAULT_ERGO_FEE, ErgoPublisher, readPlainBox, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { BranchSupplier, MiningSupplier, plainBox } from "../../../dist/ergo-synthetic.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../../../dist/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../../../dist/pool/v3/capsules.js";
import { readPackage, PACKAGE_LIMITS } from "../../../dist/pool/v3/package-reader.js";
import { decodeReceipt } from "../../../dist/pool/v3/commitments.js";
import { decodeEvidencePackage, encodeEvidencePackage } from "../../../dist/pool/v3/package.js";
import { TRAIL_LIMITS } from "../../../dist/pool/v3/reader.js";
import { decodeTrail } from "../../../dist/pool/v3/trail.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { V3OperatorJournal } from "../../../dist/pool/v3/store.js";
import { authorizeAcceptance, authorizeIssue, authorizeSettlement, demandTask, issueTask, requestTask, settleTask,
  withdrawalRecord } from "../../../dist/pool/v3/witness.js";
import { encodePublication, encodeRecord, statementHash } from "../../../dist/pool/v3/records.js";
import { PROOF_OPTIONS, startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { field } from "../fixtures.mjs";
import { RELATION_KINDS, loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys } from "./candidate.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";
import { ERGO_CHAIN, ERGO_PROFILE } from "./ergo-check.mjs";
import { publicArtifactFiles } from "./public-artifacts.mjs";

const here = import.meta.dirname, root = resolve(here, "../../.."), b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex"), digest = bytes => createHash("sha256").update(bytes).digest("hex");
const label = b(12), lag = 2n;
const referenceFor = ergo => ergo ? { context: ERGO_SYNTHETIC_REFERENCE, profile: ERGO_PROFILE } : { context: LOCAL_REFERENCE, label, lag };
// This report reads one backing, so its state carries exactly one adoption index.
const onlyAdoptionIndex = state => { assert.equal(state.adoptionIndices.size, 1); return [...state.adoptionIndices.values()][0]; };
const summary = result => {
  assert(result.state !== undefined, "expected a complete state, not a receipt-only result");
  return { supply: String(result.state.issued - result.state.burned), position: String(result.state.position),
    adoptionIndex: String(onlyAdoptionIndex(result.state)), spentRoot: hex(result.state.spentRoot()),
    history: hex(result.state.history), canonicalIndex: String(result.canonical.index),
    force: result.force.map(f => ({ index: String(f.index), kind: f.record.kind, sha256: digest(f.bytes) })),
    clock: result.clock, nonService: result.ranges.nonService };
};

async function worker(directory, ergo, liveMode = false) {
  const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
  const configuration = candidateConfiguration(manifest, codec), keys = readCandidateKeys(directory, manifest);
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; assert(length <= 4_194_304, "worker input budget"); chunks.push(chunk); }
  const input = deserialize(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(input).sort(), liveMode ? ["package", "selection"] : ["package", "selection", "venue"]);
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  try {
    const backend = new UltraHonkVerifierBackend(api), verifier = { verify: (kind, publicInputs, proof) =>
      backend.verifyProof({ proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind) }, PROOF_OPTIONS) };
    let venue, reference = referenceFor(ergo);
    if (liveMode) {
      const testnet = await import("./testnet.mjs"), selected = testnet.readTestnetSelection(join(directory, "testnet-reader.json"));
      assert.equal(input.selection.judgingIndex, selected.judgingIndex);
      venue = await testnet.testnetVenue(selected, new Uint8Array(readFileSync(join(directory, "ergo-pin.bin"))));
      assert(venue !== undefined, "independent testnet pin unavailable");
      reference = { context: selected.profile.reference, profile: selected.profile };
    } else if (ergo) {
      venue = new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context);
      const answer = await venue.sync([new BranchSupplier("holder-only", input.venue.tip, ERGO_CHAIN)]);
      assert.equal(hex(answer.witnessedHeaderId), hex(readFileSync(join(directory, "ergo-pin.bin"))));
    } else venue = FixtureVenue.from(input.venue);
    process.stdout.write(JSON.stringify(summary(await readPackage(input.package, input.selection,
      { configuration, verifier, venue, reference }))));
  } finally { await api.destroy(); }
}

async function acceptance(ergo, liveMode = false) {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const scratch = realpathSync(join(root, "scratch")), build = realpathSync(mkdtempSync(join(scratch, "v3-recovery-store-")));
  const checks = [], proofs = [], packages = [], transactions = [], started = performance.now();
  const test = async (name, fn) => { await fn(); checks.push(name); process.stderr.write(`passed: ${name}\n`); };
  const sources = sourceClosure(["scripts/pool/v3/recovery-store-check.mjs", "scripts/pool/v3/compile.mjs", "scripts/pool/v3/candidate-manifest.json",
    ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
    "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
  const hashes = sourceHashes(sources);
  let api, prover, journal, completed = false;
  try {
    const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
    const configuration = candidateConfiguration(manifest, codec), domain = codec.configurationHash(configuration);
    execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
    api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    const programs = Object.fromEntries(RELATION_KINDS.map(([, name]) => [name, JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"))]));
    for (const [kind, name] of RELATION_KINDS) writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS));
    readCandidateKeys(build, manifest);
    prover = await openV3Prover(api, programs, configuration);
    const prove = async (task, name) => { const began = performance.now(), r = await prover.prove(task);
      proofs.push({ name, kind: task.kind, bytes: r.proof.length, elapsedMs: Math.round(performance.now() - began) }); return r; };
    const testnet = liveMode ? await import("./testnet.mjs") : undefined;
    const budget = liveMode ? (await import("./recovery-testnet.mjs")).recoveryPublicationBudget() : undefined;
    const live = liveMode ? await testnet.openTestnet({ authorizeSubmission: budget.authorizeSubmission }) : undefined;
    const reference = live?.reference ?? referenceFor(ergo), supplier = ergo ? new MiningSupplier("recovery-synthetic", ERGO_CHAIN, verifyErgoProof) : undefined;
    const publisher = ergo ? new ErgoPublisher({ secretKey: b(17), suppliers: [supplier.mempool] }) : undefined;
    const venue = live?.venue ?? (ergo ? new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context, {}, publisher) : FixtureVenue.reference(label, lag));
    const runLag = venue.lag();
    let pin;
    const advance = async count => {
      if (liveMode) { await live.waitUntil(venue.witnessedIndex() + count); pin = live.pin; }
      else if (ergo) {
        for (const tx of supplier.mempool.pool) transactions.push({ unsignedBytes: tx.unsigned.length });
        supplier.mine(Number(count)); const synced = await venue.sync([supplier]); assert.equal(synced.unresolvedIndex, undefined); pin = synced.witnessedHeaderId;
      }
      else venue.advance(venue.witnessedIndex() + count);
    };
    const step = liveMode ? runLag : ergo ? lag : 1n;
    if (ergo) { supplier.mempool.fund(plainBox(publisher.tree, 200_000_000n, ERGO_CHAIN.anchor.height)); await advance(lag); }
    const publish = async () => { const c = await journal.publish(); if (liveMode) { await live.waitFor(c); pin = live.pin; }
      else if (ergo) await advance(lag); return c; };
    const checkpoint = async id => { await journal.commit(id); return publish(); };
    const issuerSecret = b(15), operatorSecret = b(16), presenterSecret = b(18);
    const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret), silence = 16n;
    const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: liveMode ? 1024n : 80n,
      payout: { thing: "recovery reference units", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: silence, challengeWindow: 5n }, nonService: { duration: 2n, count: 1n, window: liveMode ? 128n : 12n } });
    const backing = codec.rootTermsName(terms), signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const funded = [31, 32].map(id => prepareExactOutput(b(21), domain, b(id), backing, 10n));
    const pads = [33, 34].map(id => prepareExactOutput(b(21), domain, b(id), backing, 0n)), tree = new NoteTree(); tree.appendAll(funded.map(o => o.cm));
    const held = index => { const input = { note: funded[index], anchor: tree.root(), path: tree.path(BigInt(index)) }; return [input, { ...input, note: pads[index] }]; };
    const demand = async (index, instant, deadline, secret, name) => {
      if (liveMode) { await live.sync(); instant = venue.witnessedIndex(); }
      const result = await prove(demandTask(context, held(index),
        { backing, quantity: 10n, presenter: ed25519.getPublicKey(secret), instant, deadline }), name);
      if (liveMode) {
        await live.sync();
        assert(venue.witnessedIndex() <= instant + runLag, "demand proof aged beyond its publication window; no automatic new publication");
      }
      return result;
    };
    const settlement = async (index, d, deadline, secret, name) => {
      const id = statementHash(d), ownerSecret = deriveSettlementOwnerSecret(b(22), domain, id, deadline).value;
      const opening = { backing, value: 10n, owner: ownerOf(ownerSecret), rho: BigInt(42 + index) }, output = { opening, cm: commitmentOf(domain, opening) };
      return authorizeSettlement(await prove(settleTask(context, held(index), output, id), name),
        authorizeAcceptance({ domain, demand: id, owner: opening.owner, deadline }, issuerSecret), secret);
    };
    journal = new V3OperatorJournal(join(build, "journal.db"), { configuration, secret: operatorSecret, venue, reference, verifier: prover.verifier });
    const served = async () => { const s = await journal.package(); packages.push(s.package.length); return {
      package: s.package, selection: { ...s.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      ...(liveMode ? {} : { venue: ergo ? { tip: supplier.tip } : venue.export() }) }; };
    const read = input => readPackage(input.package, input.selection, { configuration, verifier: prover.verifier, venue, reference });
    const fresh = input => {
      if (liveMode) { writeFileSync(join(build, "ergo-pin.bin"), live.pin); writeFileSync(join(build, "testnet-reader.json"), JSON.stringify(live.readerConfig())); }
      else if (ergo) writeFileSync(join(build, "ergo-pin.bin"), pin);
      const child = spawnSync(process.execPath, [import.meta.filename, "--worker", build, ...(liveMode ? ["--testnet"] : ergo ? ["--ergo"] : [])],
        { input: serialize(input), cwd: root, timeout: 300_000, windowsHide: true, maxBuffer: 1_048_576 });
      assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString()); return JSON.parse(child.stdout.toString());
    };
    await test("real-proof issue and service redemption leave outstanding supply unchanged", async () => {
      await journal.open("genesis", signed); await publish();
      for (const [i, output] of funded.entries()) await journal.submit(encodeRecord(authorizeIssue(await prove(issueTask(context, output), `issue ${i}`), issuerSecret)));
      await checkpoint("issued");
      const now = venue.witnessedIndex(), deadline = now + runLag + (liveMode ? 128n : 8n);
      const first = await demand(0, now, deadline, presenterSecret, "service demand withdrawn");
      await journal.submit(encodeRecord(first)); await journal.submit(encodeRecord(withdrawalRecord(context, statementHash(first), presenterSecret)));
      const secondSecret = liveMode ? b(23) : presenterSecret;
      const second = await demand(0, now - 1n, deadline, secondSecret, "service demand settled");
      await journal.submit(encodeRecord(second));
      const settled = encodeRecord(await settlement(0, second, liveMode ? deadline - 1n : now + lag, secondSecret,
        liveMode ? "service settlement inside witnessed deadline" : "service settlement at inclusive horizon"));
      if (liveMode) await live.sync();
      const receipt = await journal.submit(settled); assert.deepEqual(await journal.submit(settled), receipt);
      await checkpoint("service-settled");
      const input = await served(), answer = summary(await read(input)); assert.equal(answer.supply, "20");
      assert.deepEqual(fresh(input), answer);
    });
    const canonicalIndex = venue.witnessedIndex();
    const publication = (kind, record) => encodePublication({ domain, backing, kind, record });
    const publishRecovery = async (kind, record) => {
      const bytes = publication(kind, record); await venue.publishRecord(4, backing, bytes);
      if (liveMode) { await live.waitForRecord(4, backing, bytes); pin = live.pin; }
      else if (ergo) await advance(lag);
    };
    await test("a real segment-free request counts once against canonical holder evidence", async () => {
      const request = await prove(requestTask(domain, held(1)[0], 0n), "unanswered request");
      await publishRecovery(5, request); await advance(2n);
      const input = await served(), result = await read(input);
      assert.equal(result.ranges.nonService.count, "1"); assert.equal(result.ranges.nonService.fires, true);
      assert.deepEqual(fresh(input), summary(result));
    });
    let saved, expectedAdoption;
    await test("silence refuses service and holder-only evidence derives publication force", async () => {
      saved = await served();
      const remaining = canonicalIndex + silence + 1n - venue.witnessedIndex();
      if (remaining > 0n) await advance(remaining);
      await assert.rejects(journal.commit("retired"), error => error.code === "STALE" && error.check === "SILENCE");
      const now = venue.witnessedIndex(), recoveryDeadline = now + (liveMode ? 128n : 30n);
      const first = await demand(1, now + step - lag, recoveryDeadline, presenterSecret, "forced first demand");
      await publishRecovery(1, first);
      const withdrawal = withdrawalRecord(context, statementHash(first), presenterSecret); await publishRecovery(4, withdrawal);
      const second = await demand(1, venue.witnessedIndex() + step - lag, recoveryDeadline + 1n, b(19), "forced second demand");
      await publishRecovery(1, second);
      saved = { ...saved, selection: { ...saved.selection, judgingIndex: venue.witnessedIndex() },
        ...(liveMode ? {} : { venue: ergo ? { tip: supplier.tip } : venue.export() }) };
      const forced = await read(saved); assert.deepEqual(forced.force.map(f => f.record.kind), [4, 5, 4]);
      assert.deepEqual(fresh(saved), summary(forced));
      const settled = await settlement(1, second, recoveryDeadline, b(19), liveMode ? "forced settlement before return" : "forced settlement at return index");
      if (liveMode) await publishRecovery(3, settled);
      const opening = await journal.return("return"); assert.deepEqual(await journal.return("return"), opening);
      await assert.rejects(journal.adopt(), error => error.code === "UNAVAILABLE");
      if (liveMode) await publish();
      else {
        await journal.publish();
        if (ergo) { await venue.publishRecord(4, backing, publication(3, settled)); await advance(lag); }
        else venue.witness(4, backing, venue.witnessedIndex(), publication(3, settled));
      }
      const expected = [first, withdrawal, second, settled].map(encodeRecord), adopted = await journal.adopt();
      expectedAdoption = expected;
      assert.deepEqual(adopted.map(bytes => decodeReceipt(bytes).statementHash), [first, withdrawal, second, settled].map(statementHash));
      assert.deepEqual(await journal.adopt(), adopted);
      await checkpoint("adopted");
    });
    let final;
    await test("fresh runtime reader verifies exact adoption and refuses missing ancestry", async () => {
      const input = await served(), result = await read(input); final = summary(result);
      assert.equal(final.supply, "20"); assert.equal(final.position, "4");
      assert(result.state.hasNullifier(funded[1].nf)); assert.deepEqual(fresh(input), final);
      const items = decodeEvidencePackage(input.package, PACKAGE_LIMITS);
      assert(items.filter(item => item.kind === 6).some(item => {
        const records = decodeTrail(item.payload, TRAIL_LIMITS).records;
        return records.length === expectedAdoption.length && records.every((bytes, i) => hex(bytes) === hex(expectedAdoption[i]));
      }), "the return segment carries the exact adopted proof and signature bytes in venue order");
      for (const kind of [3, 4, 6]) await assert.rejects(read({ ...input,
        package: encodeEvidencePackage(items.filter(item => item.kind !== kind), PACKAGE_LIMITS) }), error => error.status === "unresolved-evidence");
      assert(Math.max(...packages) + 360 <= Number(PACKAGE_LIMITS.maxBytes), "complete ancestry plus receipt headroom must fit the reference package budget");
    });
    checkCandidateSources(manifest); assert.deepEqual(sourceHashes(sources), hashes, "sources changed during acceptance");
    let funding;
    if (liveMode) {
      funding = budget.report(); assert.equal(funding.transactions.length, 10);
      const directory = join(scratch, "pool-v3-recovery-testnet-reader"), input = await served();
      mkdirSync(directory, { recursive: true });
      for (const [name, bytes] of publicArtifactFiles(build, manifest)) writeFileSync(join(directory, name), bytes);
      writeFileSync(join(directory, "input.bin"), serialize(input));
      writeFileSync(join(directory, "ergo-pin.bin"), live.pin);
      writeFileSync(join(directory, "testnet-reader.json"), JSON.stringify(live.readerConfig(), null, 2) + "\n");
      writeFileSync(join(directory, "readback.json"), JSON.stringify(final, null, 2) + "\n");
    }
    if (ergo) {
      assert.equal(transactions.length, 10, "five checkpoints and five recovery publications");
      const change = (await supplier.mempool.unspentBoxes(publisher.tree)).map(bytes => readPlainBox(bytes, publisher.tree));
      assert(change.every(box => box !== undefined));
      const spent = 200_000_000n - change.reduce((sum, box) => sum + box.value, 0n);
      funding = { initialNanoErg: "200000000", spentNanoErg: String(spent),
        feeNanoErg: String(DEFAULT_ERGO_FEE * BigInt(transactions.length)), recordMinimumNanoErg: String(spent - DEFAULT_ERGO_FEE * BigInt(transactions.length)) };
    }
    const report = { status: "passed", specification: V3_SPECIFICATION, evidence: liveMode ? "live-testnet-runtime-real-proofs" : ergo ? "synthetic-ergo-runtime-real-proofs" : "local-runtime-real-proofs",
      limits: ["candidate configuration only", "single backing", liveMode ? "live testnet only; same-index return covered synthetically" : "no live broadcasts", "no persistence or adoption claim"],
      checks, proofs, transactions, funding, maxPackageBytes: Math.max(...packages), receiptHeadroomBytes: 360, final,
      elapsedMs: Math.round(performance.now() - started), sourceSha256Lf: hashes };
    writeFileSync(join(root, "docs", `pool-v3-recovery-store${liveMode ? "-testnet" : ergo ? "-ergo" : ""}-verification.json`), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n"); completed = true;
  } finally {
    journal?.close(); await prover?.close(); await api?.destroy();
    if (completed) { assert(build.startsWith(scratch + sep)); rmSync(build, { recursive: true, force: true }); }
    else process.stderr.write(`Recovery acceptance scratch retained after failure: ${build}\n`);
  }
}

if (process.argv[2] === "--worker") {
  assert(process.argv.length === 4 || (process.argv.length === 5 && ["--ergo", "--testnet"].includes(process.argv[4])));
  await worker(process.argv[3], process.argv[4] === "--ergo", process.argv[4] === "--testnet");
} else {
  const liveMode = process.argv.length === 4 && process.argv[2] === "--testnet" && process.argv[3] === "--authorized-testnet";
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--ergo") || liveMode,
    "recovery-store-check takes --ergo or explicit --testnet --authorized-testnet");
  await acceptance(process.argv[2] === "--ergo", liveMode);
}
