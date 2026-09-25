// Real-proof acceptance for the v3 operator journal (runtime plan slice 1, M2a):
// the backer issues, a holder pays with a fee and change, another burns, each
// proven by the runtime prover and admitted by src/pool/v3/store.ts on the local
// reference venue; holders spend notes they restore from the served package;
// a fresh seedless process verifies supply from the package and the venue alone.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { serialize } from "node:v8";
import { Barretenberg, BackendType, UltraHonkBackend } from "@aztec/bb.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../../../dist/record-venue.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { decodeReceipt } from "../../../dist/pool/v3/commitments.js";
import { CandidateVenueError } from "../../../dist/pool/v3/guard.js";
import { openV3Prover, ProverError } from "../../../dist/pool/v3/prover.js";
import { V3OperatorJournal, V3StoreError } from "../../../dist/pool/v3/store.js";
import { authorizeIssue, burnTask, issueTask, spendTask } from "../../../dist/pool/v3/witness.js";
import { encodeRecord } from "../../../dist/pool/v3/records.js";
import { PROOF_OPTIONS } from "../../../dist/pool/proof-verifier.js";
import { PACKAGE_LIMITS, recordReader, replayEvidencePackage } from "./local-replay.mjs";
import { RELATION_KINDS, loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys } from "./candidate.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";

const here = import.meta.dirname, root = resolve(here, "../../..");
assert.equal(process.argv.length, 2, "store-check takes no options");
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(join(root, "scratch"));
const build = realpathSync(mkdtempSync(join(scratch, "pool-v3-store-")));
const checks = [], metrics = [], b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex");
const sha = bytes => createHash("sha256").update(bytes).digest();
const test = async (name, fn) => { await fn(); checks.push(name); };
const refusal = async (action, code, check) => {
  const error = await action.then(() => undefined, e => e);
  assert(error instanceof V3StoreError, `expected a journal refusal, got ${error}`);
  assert.equal(error.code, code); assert.equal(error.check, check);
};
let api, journal;
try {
  const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
  const configuration = candidateConfiguration(manifest, codec);
  execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
  checkCandidateSources(manifest);
  const crsPath = join(scratch, "private-payment-crs");
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
  const programs = Object.fromEntries(RELATION_KINDS.map(([, name]) => [name, JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"))]));
  // The fresh reader process reads the keys from the build directory and checks them against the manifest itself.
  for (const [kind, name] of RELATION_KINDS) {
    writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS));
  }
  readCandidateKeys(build, manifest);
  const prover = await openV3Prover(api, programs, configuration, { crsPath });
  const verifier = { configuration, verify: (kind, inputs, proof) => prover.verifier.verify(kind, inputs, proof),
    record: data => recordReader(FixtureVenue.from(data), "fixture-verifier") };
  async function prove(task, label) {
    const start = performance.now(), record = await prover.prove(task);
    metrics.push({ label, kind: task.kind, proofBytes: record.proof.length, elapsedMs: Math.round(performance.now() - start) });
    return record;
  }

  // The parties: a backer (K), the operator it names, and three holders' seeds.
  const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
  const payerSeed = b(21), receiverSeed = b(22), operatorSeed = b(23);
  const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag };
  const venue = FixtureVenue.reference(label, lag), domain = codec.configurationHash(configuration);
  const termsBytes = codec.encodeRootTerms({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n },
    operator, configuration: domain, venue: venue.id, interval: 10n });
  const signed = { terms: termsBytes, signature: ed25519.sign(codec.rootTermsSignatureMessage(termsBytes), issuerSecret) };
  const backing = codec.rootTermsName(termsBytes);
  const header = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] }, context = { domain, header };
  // Each output is its recipient's own exact request (C4.1–C4.3); the fee is the operator's (pool-fees C1.2.4).
  const request = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  const funded = request(payerSeed, 31, 10n), paid = request(receiverSeed, 32, 7n), fee = request(operatorSeed, 33, 1n);
  const change = request(payerSeed, 34, 2n), zero = request(payerSeed, 35, 0n), pad = request(payerSeed, 36, 0n);
  const burnChange = request(receiverSeed, 37, 2n), receiverPad = request(receiverSeed, 38, 0n);
  const journalPath = join(build, "journal.db"), options = { configuration, secret: operatorSecret, venue, reference, verifier: prover.verifier };

  /** The reader's own input: the served package, its selection judged at the venue's current index, and the venue's records. */
  async function served(seed) {
    const { selection, package: bytes } = await journal.package();
    return { selection: { ...selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" }, package: bytes,
      venue: venue.export(), ...(seed === undefined ? {} : { seed }) };
  }
  /** A holder's note as the reader restores it from public evidence, joined to the holder's own request. */
  async function restored(seed, prepared) {
    const result = await replayEvidencePackage(await served(seed), verifier, codec);
    assert.equal(result.status, "selected-local-replay");
    const found = result.candidates.find(c => BigInt(c.cm) === prepared.cm);
    assert(found !== undefined, "the holder's note is not restored");
    assert.equal(BigInt(found.value), prepared.opening.value);
    return { note: prepared, anchor: BigInt(found.anchor), path: { siblings: found.siblings.map(BigInt), right: found.right } };
  }
  async function checkpoint(id) { await journal.commit(id); return journal.publish(); }

  const records = {}, receipts = {};
  let spent;
  await test("the prover refuses artifacts whose keys are not the configuration's", async () => {
    const changed = { ...configuration, circuits: { ...configuration.circuits, spend: { ...configuration.circuits.spend, vk: b(9) } } };
    const error = await openV3Prover(api, programs, changed, { crsPath }).then(() => undefined, e => e);
    assert(error instanceof ProverError); assert.equal(error.code, "IDENTITY");
  });
  await test("the journal runs only on a venue whose identity recomputes from its reference preimage", () => {
    assert.throws(() => new V3OperatorJournal(join(build, "refused.db"), { ...options, venue: new FixtureVenue(b(12), 0n, lag) }), CandidateVenueError);
    assert.throws(() => new V3OperatorJournal(join(build, "refused.db"), { ...options, reference: { ...reference, lag: 3n } }), CandidateVenueError);
  });
  journal = new V3OperatorJournal(journalPath, options);
  await test("the operator opens and publishes the genesis segment the backer's terms name", async () => {
    const opening = await journal.open("genesis", signed);
    assert.equal(opening.sequence, 1n);
    await refusal(journal.submit(new Uint8Array(0)), "REFUSED", "MALFORMED");
    await journal.publish();
  });
  await test("the backer proves and signs issue 10 to the payer's request; the journal admits, commits and publishes", async () => {
    records.issue = encodeRecord(authorizeIssue(await prove(issueTask(context, funded), "issue 10"), issuerSecret));
    receipts.issue = await journal.submit(records.issue);
    assert.equal(decodeReceipt(receipts.issue).position, 1n);
    await checkpoint("after-issue");
  });
  await test("the payer spends its restored note: 7 to the receiver, a fee of 1 to the operator's request, change 2", async () => {
    const input = spent = await restored(payerSeed, funded);
    records.pay = encodeRecord(await prove(spendTask(context, [input, { ...input, note: pad }], [paid, fee, change, zero]), "pay 7, fee 1, change 2"));
    receipts.pay = await journal.submit(records.pay);
    assert.equal(decodeReceipt(receipts.pay).position, 2n);
    await checkpoint("after-pay");
  });
  await test("the receiver burns 5 of its restored 7 with change 2", async () => {
    const input = await restored(receiverSeed, paid);
    records.burn = encodeRecord(await prove(burnTask(context, 5n, [input, { ...input, note: receiverPad }], burnChange), "burn 5, change 2"));
    receipts.burn = await journal.submit(records.burn);
    assert.equal(decodeReceipt(receipts.burn).position, 3n);
    await checkpoint("after-burn");
  });
  await test("admission refuses a real proof moved to another statement, a changed public input and a valid double spend", async () => {
    // An admitted statement returns its original receipt whatever proof comes with it (§7.2), so these are new statements.
    // The same proof for an issue of 11 instead of 10: signed again by K, so only the proof can refuse it.
    const issue = codec.decodeRecord(records.issue), inflated = [...issue.publicInputs]; inflated[7] = 11n;
    await refusal(journal.submit(encodeRecord(authorizeIssue({ ...issue, publicInputs: inflated }, issuerSecret))), "REFUSED", "PROOF");
    // The payer's spent note again, under its still-accepted anchor, into fresh outputs: a valid proof of a double spend.
    const again = [request(receiverSeed, 51, 7n), request(operatorSeed, 52, 1n), request(payerSeed, 53, 2n), request(payerSeed, 54, 0n)];
    const double = await prove(spendTask(context, [spent, { ...spent, note: pad }], again), "double spend refused");
    await refusal(journal.submit(encodeRecord({ ...double, proof: codec.decodeRecord(records.pay).proof })), "REFUSED", "PROOF");
    await refusal(journal.submit(encodeRecord(double)), "REFUSED", "SPENT");
  });
  await test("exact retries return original replies, a new proof of an admitted statement included", async () => {
    for (const kind of ["issue", "pay", "burn"]) assert.deepEqual(await journal.submit(records[kind]), receipts[kind]);
    const again = encodeRecord(authorizeIssue(await prove(issueTask(context, funded), "issue 10 again"), issuerSecret));
    assert.notDeepEqual(again, records.issue);
    assert.deepEqual(await journal.submit(again), receipts.issue);
    assert.deepEqual(await journal.commit("after-burn"), await journal.publish());
  });
  const audit = await replayEvidencePackage(await served(), verifier, codec);
  const holders = { receiver: receiverSeed, payer: payerSeed, operator: operatorSeed };
  const holdings = {};
  for (const [name, seed] of Object.entries(holders)) holdings[name] = await replayEvidencePackage(await served(seed), verifier, codec);
  const receiptReads = {};
  await test("the reader derives supply 10 minus 5 and reads each original receipt as final", async () => {
    assert.equal(audit.status, "selected-local-replay"); assert.equal(audit.rangeEvidence, "fixture-verifier");
    assert.deepEqual([audit.audit.issued, audit.audit.burned, audit.audit.outstanding, audit.audit.records], ["10", "5", "5", "3"]);
    assert.equal(audit.audit.range.carrying.length, 4);
    for (const kind of ["issue", "pay", "burn"]) {
      // A receipt query (§12 kind 10) over the served package: the reader finds the receipt's exact event in a valid checkpoint.
      const input = await served(), items = [...codec.decodeEvidencePackage(input.package, PACKAGE_LIMITS), { kind: 10, payload: receipts[kind] }]
        .sort((a, b) => a.kind - b.kind || Buffer.compare(sha(a.payload), sha(b.payload)));
      const read = await replayEvidencePackage({ ...input, package: codec.encodeEvidencePackage(items, PACKAGE_LIMITS) }, verifier, codec);
      assert.equal(read.status, "receipt-status"); assert.equal(read.receipt.status, "final");
      receiptReads[kind] = read.receipt;
    }
  });
  await test("receiver, payer and operator restore exactly their unspent notes from their seeds", () => {
    const values = result => result.candidates.map(c => [BigInt(c.cm), c.value]);
    assert.deepEqual(values(holdings.receiver), [[burnChange.cm, "2"]]);
    assert.deepEqual(values(holdings.payer), [[change.cm, "2"]]);
    assert.deepEqual(values(holdings.operator), [[fee.cm, "1"]]);
    for (const result of Object.values(holdings)) assert.deepEqual(result.audit, audit.audit);
  });
  await prover.close();
  await api.destroy(); api = undefined;
  const url = pathToFileURL(build + sep).href;
  const worker = input => {
    const child = spawnSync(process.execPath, [join(here, "local-worker.mjs"), url], {
      input: serialize(input), timeout: 120_000, cwd: build, windowsHide: true, maxBuffer: 1_048_576 });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  };
  const fresh = {};
  await test("a fresh seedless process verifies the same supply from the package and the venue alone", async () => {
    const input = await served();
    assert.deepEqual(Object.keys(input).sort(), ["package", "selection", "venue"]);
    fresh.audit = worker(input);
    assert.deepEqual(fresh.audit, audit);
  });
  await test("a fresh process restores the receiver's note from its seed and public bytes", async () => {
    fresh.receiver = worker(await served(receiverSeed));
    assert.deepEqual(fresh.receiver, holdings.receiver);
  });
  const finalPackage = await journal.package();
  await test("a reopened journal replays its commands to the same package and replies", async () => {
    journal.close();
    // Reopening re-verifies every admitted proof: under a verifier that accepts none the journal does not load.
    journal = new V3OperatorJournal(journalPath, { ...options, verifier: { verify: () => false } });
    await refusal(journal.package(), "STORAGE");
    journal.close();
    const reopenApi = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
    try {
      const again = await openV3Prover(reopenApi, programs, configuration, { crsPath });
      try {
        journal = new V3OperatorJournal(journalPath, { ...options, verifier: again.verifier });
        assert.deepEqual(await journal.package(), finalPackage);
        for (const kind of ["issue", "pay", "burn"]) assert.deepEqual(await journal.submit(records[kind]), receipts[kind]);
      } finally { await again.close(); }
    } finally { await reopenApi.destroy(); }
  });

  const sources = sourceClosure(["scripts/pool/v3/store-check.mjs", "scripts/pool/v3/local-worker.mjs", "scripts/pool/v3/compile.mjs",
    "scripts/pool/v3/candidate-manifest.json",
    ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
    "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
  const report = { schema: "moe-v3-operator-journal-1", specification: V3_SPECIFICATION, node: process.version, platform: process.platform,
    candidateDomain: hex(domain), backing: hex(backing), venue: { context: LOCAL_REFERENCE, label: hex(label), lag: lag.toString(), id: hex(venue.id) },
    checks, metrics, packageBytes: finalPackage.package.length, recordBytes: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.length])),
    venueRecords: venue.export().records.length, sourceSha256Lf: sourceHashes(sources), audit, holdings, receiptReads, fresh,
    limits: ["Candidate configuration from the independently held manifest and a local reference venue whose identity the guard recomputes; no adopted domain, chain venue or finality.",
      "One genesis segment of one backing: no imports, recovery kinds, replacement, second backing or silence/non-service clause. The journal reads the venue's full ranges on every operation.",
      "Holders are this script: the payer and receiver restore paths through the reader and prove with the runtime prover; no wallet store, request transport or fee quote.",
      "Restart replay is exercised once here; restarts mid-publication and exact retry across restarts are slice 5."] };
  writeFileSync(join(scratch, "pool-v3-store-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS: ${checks.length} operator journal checks, ${metrics.length} real proofs; scratch/pool-v3-store-results.json`);
} finally {
  try { journal?.close(); } catch { /* already closed */ }
  if (api) await api.destroy();
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error("unsafe store build cleanup");
  rmSync(target, { recursive: true, force: true });
}
