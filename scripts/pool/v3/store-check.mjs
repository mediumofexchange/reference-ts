// Real-proof acceptance for the v3 operator journal (runtime plan slice 1, M2a–b):
// the backer issues, the payer wallet pays with a fee and change, another burns, each
// proven by the runtime prover and admitted by src/pool/v3/store.ts on the local
// reference venue, or --ergo through the actual publisher and a synthetic mining
// supplier; the payer wallet and holders spend notes they restore from the served package;
// a fresh seedless process verifies supply from the package and the venue alone.
// --testnet explicitly publishes on the own live testnet node, never in CI.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { serialize } from "node:v8";
import { Barretenberg, BackendType, UltraHonkBackend } from "@aztec/bb.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../../../dist/record-venue.js";
import { ErgoVenue } from "../../../dist/ergo.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../../../dist/ergo-profile.js";
import { ErgoPublisher, verifyErgoProof } from "../../../dist/ergo-publisher.js";
import { MiningSupplier, plainBox } from "../../../dist/ergo-synthetic.js";
import { prepareExactOutput, recoverCapsule } from "../../../dist/pool/v3/capsules.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { copyPaymentRequest } from "../../../dist/pool/v3/wallet-request.js";
import { decodeReceipt, encodeReceipt } from "../../../dist/pool/v3/commitments.js";
import { createV3Service } from "../../../dist/pool/v3/service-http.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { CandidateVenueError } from "../../../dist/pool/v3/guard.js";
import { openV3Prover, ProverError } from "../../../dist/pool/v3/prover.js";
import { V3OperatorJournal, V3StoreError } from "../../../dist/pool/v3/store.js";
import { authorizeIssue, burnTask, issueTask, spendTask } from "../../../dist/pool/v3/witness.js";
import { encodeRecord } from "../../../dist/pool/v3/records.js";
import { PROOF_OPTIONS, startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { PACKAGE_LIMITS, recordReader, replayEvidencePackage } from "./local-replay.mjs";
import { RELATION_KINDS, loadCandidateManifest, checkCandidateSources, candidateConfiguration, readCandidateKeys } from "./candidate.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";
import { publicArtifactFiles } from "./public-artifacts.mjs";
import { ERGO_CHAIN, ERGO_PROFILE, ERGO_EVIDENCE_KIND, ergoRecord } from "./ergo-check.mjs";

const here = import.meta.dirname, root = resolve(here, "../../..");
assert(process.argv.length === 2 || (process.argv.length === 3 && ["--ergo", "--testnet"].includes(process.argv[2])), "store-check takes only --ergo or --testnet");
const withErgo = process.argv[2] === "--ergo";
const withTestnet = process.argv[2] === "--testnet";
// Literal dynamic import is included by report provenance, while ordinary
// checks cannot open a live publisher implicitly.
const testnet = withTestnet ? await import("./testnet.mjs") : undefined;
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
const sources = sourceClosure(["scripts/pool/v3/store-check.mjs", "scripts/pool/v3/local-worker.mjs", "scripts/pool/v3/compile.mjs",
  "scripts/pool/v3/candidate-manifest.json",
  ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
  "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
const sourceSha256Lf = sourceHashes(sources), runStarted = performance.now();
let api, journal, receiverWallet, payerWallet, serviceServer, serviceClient;
async function stopService() {
  if (serviceServer === undefined) return;
  const server = serviceServer; serviceServer = undefined;
  await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
try {
  const live = withTestnet ? await testnet.openTestnet() : undefined;
  const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
  const configuration = candidateConfiguration(manifest, codec);
  execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
  checkCandidateSources(manifest);
  const parameters = await readParameters(PARAMETER_DIRECTORY);
  api = await startBackend(parameters);
  const programs = Object.fromEntries(RELATION_KINDS.map(([, name]) => [name, JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"))]));
  // The fresh reader process reads the keys from the build directory and checks them against the manifest itself.
  for (const [kind, name] of RELATION_KINDS) {
    writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS));
  }
  readCandidateKeys(build, manifest);
  const prover = await openV3Prover(api, programs, configuration);
  async function prove(task, label) {
    const start = performance.now(), record = await prover.prove(task);
    metrics.push({ label, kind: task.kind, proofBytes: record.proof.length, elapsedMs: Math.round(performance.now() - start) });
    return record;
  }

  // The parties: a backer (K), the operator it names, and three holders' seeds.
  const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
  const operatorSeed = b(23);
  const label = b(12), lag = live?.venue.lag() ?? 2n;
  const reference = live?.reference ?? (withErgo ? { context: ERGO_SYNTHETIC_REFERENCE, profile: ERGO_PROFILE } : { context: LOCAL_REFERENCE, label, lag });
  const supplier = withErgo ? new MiningSupplier("journal-synthetic", ERGO_CHAIN, verifyErgoProof) : undefined;
  const publisher = withErgo ? new ErgoPublisher({ secretKey: b(17), suppliers: [supplier.mempool] }) : undefined;
  const venue = live?.venue ?? (withErgo ? new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context, {}, publisher) : FixtureVenue.reference(label, lag));
  const evidenceKind = withTestnet ? testnet.TESTNET_EVIDENCE_KIND : withErgo ? ERGO_EVIDENCE_KIND : "fixture-verifier";
  let pin;
  async function mineAndSync() {
    supplier.mine(Number(ERGO_PROFILE.depth + 1n));
    const synced = await venue.sync([supplier]);
    assert(synced.witnessedHeaderId instanceof Uint8Array, "the synthetic chain must witness a block");
    assert.equal(synced.unresolvedIndex, undefined);
    pin = synced.witnessedHeaderId;
  }
  if (withErgo) {
    // Invented funding is only for the synthetic mempool's balance/proof checks.
    supplier.mempool.fund(plainBox(publisher.tree, 100_000_000n, ERGO_CHAIN.anchor.height));
    await mineAndSync();
  }
  const verifier = { configuration, reference, verify: (kind, inputs, proof) => prover.verifier.verify(kind, inputs, proof),
    record: data => withTestnet ? testnet.testnetRecord(live.selection(), live.pin)
      : withErgo ? ergoRecord(data, { pin }) : recordReader(FixtureVenue.from(data), evidenceKind) };
  // The range-replay harness needs a venue-presence marker. Testnet's marker
  // is reader-owned and empty: its factory always fetches node bytes itself.
  const replay = input => replayEvidencePackage(withTestnet ? { ...input, venue: {} } : input, verifier, codec);
  const domain = codec.configurationHash(configuration);
  const termsBytes = codec.encodeRootTerms({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n },
    operator, configuration: domain, venue: venue.id, interval: withTestnet ? BigInt(testnet.TESTNET_LIMITS.maxBlocks) : 10n });
  const signed = { terms: termsBytes, signature: ed25519.sign(codec.rootTermsSignatureMessage(termsBytes), issuerSecret) };
  const backing = codec.rootTermsName(termsBytes);
  const receiverPath = join(build, "receiver.db"), receiverOptions = { configuration, venue, reference, verifier: prover.verifier };
  receiverWallet = new V3Wallet(receiverPath, receiverOptions);
  const receiverSeed = receiverWallet.recoverySeed();
  const paidRequest = receiverWallet.request("payment", backing, 7n);
  receiverWallet.close();
  receiverWallet = new V3Wallet(receiverPath, receiverOptions);
  assert.deepEqual(receiverWallet.request("payment", backing, 7n), paidRequest);
  assert.deepEqual(Object.keys(paidRequest).sort(), ["capsule", "cm", "domain", "opening"]);
  const payerRequest = copyPaymentRequest(paidRequest, { domain, backing, value: 7n });
  const header = { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] }, context = { domain, header };
  // Each output is its recipient's own exact request (C4.1–C4.3); the fee is the operator's (pool-fees C1.2.4).
  const request = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  // The payer wallet requests its own funding; it later selects, pads and prepares change itself.
  payerWallet = new V3Wallet(join(build, "payer.db"), receiverOptions);
  const payerSeed = payerWallet.recoverySeed(), funded = payerWallet.request("funding", backing, 10n);
  const fundedNote = recoverCapsule(payerSeed, domain, funded.cm, funded.capsule);
  const paid = { ...recoverCapsule(receiverSeed, domain, paidRequest.cm, paidRequest.capsule), capsule: paidRequest.capsule }, fee = request(operatorSeed, 33, 1n);
  const feeRequest = copyPaymentRequest({ domain, opening: fee.opening, cm: fee.cm, capsule: fee.capsule }, { domain, backing, value: 1n });
  const pad = request(payerSeed, 36, 0n);
  const burnChange = request(receiverSeed, 37, 2n), receiverPad = request(receiverSeed, 38, 0n);
  const journalPath = join(build, "journal.db"), options = { configuration, secret: operatorSecret, venue, reference, verifier: prover.verifier };
  const credentials = { walletToken: randomBytes(32).toString("hex"), adminToken: randomBytes(32).toString("hex") };
  async function serve() {
    await stopService();
    serviceServer = createV3Service(journal, credentials);
    await new Promise((resolve, reject) => serviceServer.listen(0, "127.0.0.1", resolve).once("error", reject));
    serviceClient = new V3ServiceClient(`http://127.0.0.1:${serviceServer.address().port}/`, credentials.walletToken,
      { domain, operator, reference }, credentials.adminToken);
  }
  const submit = async bytes => encodeReceipt(await serviceClient.submit(bytes));

  /** The reader's own input: the served package, its selection judged at the venue's current index, and the venue's records. */
  async function served(seed) {
    const { selection, package: bytes } = await serviceClient.package(backing);
    return { selection: { ...selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" }, package: bytes,
      ...(withTestnet ? {} : { venue: withErgo ? { tip: supplier.tip } : venue.export() }), ...(seed === undefined ? {} : { seed }) };
  }
  /** A holder's note as the reader restores it from public evidence, joined to the holder's own request. */
  async function restored(seed, prepared) {
    const result = await replay(await served(seed));
    assert.equal(result.status, "selected-local-replay");
    const found = result.candidates.find(c => BigInt(c.cm) === prepared.cm);
    assert(found !== undefined, "the holder's note is not restored");
    assert.equal(BigInt(found.value), prepared.opening.value);
    return { note: prepared, anchor: BigInt(found.anchor), path: { siblings: found.siblings.map(BigInt), right: found.right } };
  }
  async function publish() {
    const before = venue.witnessedIndex(), commitment = await serviceClient.publish();
    if (withErgo) {
      assert.equal(venue.witnessedIndex(), before, "mempool acceptance cannot advance the venue's clock");
      assert.equal(supplier.mempool.pool.length, 1, "one actual signed transaction per new commitment");
      await mineAndSync();
      assert.equal(supplier.mempool.pool.length, 0);
      assert.equal(venue.witnessedIndex(), before + lag);
    }
    if (withTestnet) {
      assert.equal(venue.witnessedIndex(), before, "mempool acceptance cannot advance the venue's clock");
      await live.waitFor(commitment);
      assert(venue.witnessedIndex() > before, "the actual commitment must be witnessed in a later block");
      pin = live.pin;
    }
    return commitment;
  }
  async function checkpoint(id) { await serviceClient.commit(id); return publish(); }

  const records = {}, receipts = {};
  let spent;
  await test("the prover refuses artifacts whose keys are not the configuration's", async () => {
    const changed = { ...configuration, circuits: { ...configuration.circuits, spend: { ...configuration.circuits.spend, vk: b(9) } } };
    const error = await openV3Prover(api, programs, changed).then(() => undefined, e => e);
    assert(error instanceof ProverError); assert.equal(error.code, "IDENTITY");
  });
  await test("the prover refuses a backend instance startBackend did not start (pool-v3 §4)", async () => {
    const unchecked = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, skipSrsInit: true });
    try {
      await assert.rejects(openV3Prover(unchecked, programs, configuration),
        { name: "ParameterError", code: "UNCHECKED", message: "the backend instance was not started from checked parameters" });
    } finally { await unchecked.destroy(); }
  });
  await test("the journal runs only on a venue whose identity recomputes from its reference preimage", () => {
    assert.throws(() => new V3OperatorJournal(join(build, "refused.db"), { ...options, venue: new FixtureVenue(b(12), 0n, lag) }), CandidateVenueError);
    const wrongReference = withTestnet || withErgo ? { ...reference, profile: { ...reference.profile, depth: reference.profile.depth + 1n } } : { ...reference, lag: 3n };
    assert.throws(() => new V3OperatorJournal(join(build, "refused.db"), { ...options, reference: wrongReference }), CandidateVenueError);
  });
  journal = new V3OperatorJournal(journalPath, options);
  await test("the operator opens and publishes the genesis segment the backer's terms name", async () => {
    const opening = await journal.open("genesis", signed);
    assert.equal(opening.sequence, 1n);
    await serve();
    await refusal(journal.submit(new Uint8Array(0)), "REFUSED", "MALFORMED");
    await publish();
  });
  await test("the backer proves and signs issue 10 to the payer's request; the journal admits, commits and publishes", async () => {
    records.issue = encodeRecord(authorizeIssue(await prove(issueTask(context, funded), "issue 10"), issuerSecret));
    receipts.issue = await submit(records.issue);
    assert.equal(decodeReceipt(receipts.issue).position, 1n);
    await checkpoint("after-issue");
  });
  let payerView;
  await test("the payer wallet pays 7 to the receiver and a fee of 1 to the operator's request from its restored note, change 2", async () => {
    spent = await restored(payerSeed, fundedNote);
    const order = { request: payerRequest, value: 7n, fee: { request: feeRequest, value: 1n } };
    const payment = await payerWallet.prepare("receiver", order, (await serviceClient.package(backing)).package, signed,
      task => prove(task, "pay 7, fee 1, change 2"));
    assert.deepEqual(payment.inputs, [fundedNote.nf]);
    records.pay = payment.record;
    receipts.pay = encodeReceipt(await payerWallet.submit("receiver", serviceClient));
    assert.equal(decodeReceipt(receipts.pay).position, 2n);
    await checkpoint("after-pay");
    payerView = await payerWallet.sync((await serviceClient.package(backing)).package, signed);
    assert.equal(payerWallet.payment("receiver").status, "final");
    assert.deepEqual(payerView.holdings.map(h => [h.value, h.status]), [[2n, "available"]]);
  });
  await test("the receiver independently replays the HTTP service package and durably fulfills its saved exact request once", async () => {
    const input = await served();
    const fulfillment = await receiverWallet.fulfill("payment", input.package, signed);
    assert.deepEqual(fulfillment.request, paidRequest);
    assert.equal(fulfillment.judgingIndex, venue.witnessedIndex());
    receiverWallet.close();
    receiverWallet = new V3Wallet(receiverPath, receiverOptions);
    assert.deepEqual(receiverWallet.fulfillment("payment"), fulfillment);
    await assert.rejects(receiverWallet.fulfill("payment", input.package, signed), { code: "CONFLICT" });
  });
  await test("the receiver burns 5 of its restored 7 with change 2", async () => {
    const input = await restored(receiverSeed, paid);
    records.burn = encodeRecord(await prove(burnTask(context, 5n, [input, { ...input, note: receiverPad }], burnChange), "burn 5, change 2"));
    receipts.burn = await submit(records.burn);
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
    for (const kind of ["issue", "pay", "burn"]) assert.deepEqual(await submit(records[kind]), receipts[kind]);
    const again = encodeRecord(authorizeIssue(await prove(issueTask(context, funded), "issue 10 again"), issuerSecret));
    assert.notDeepEqual(again, records.issue);
    assert.deepEqual(await submit(again), receipts.issue);
    assert.deepEqual(await serviceClient.commit("after-burn"), await serviceClient.publish());
    if (withTestnet) {
      assert.equal(live.submitted.length, 4, "exactly four live commitments, no transaction for retries");
      assert.equal(new Set(live.submitted).size, 4);
    }
  });
  const audit = await replay(await served());
  const holders = { receiver: receiverSeed, payer: payerSeed, operator: operatorSeed };
  const holdings = {};
  for (const [name, seed] of Object.entries(holders)) holdings[name] = await replay(await served(seed));
  const receiptReads = {};
  await test("the reader derives supply 10 minus 5 and reads each original receipt as final", async () => {
    assert.equal(audit.status, "selected-local-replay"); assert.equal(audit.rangeEvidence, evidenceKind);
    assert.deepEqual([audit.audit.issued, audit.audit.burned, audit.audit.outstanding, audit.audit.records], ["10", "5", "5", "3"]);
    assert.equal(audit.audit.range.carrying.length, 4);
    for (const kind of ["issue", "pay", "burn"]) {
      // A receipt query (§12 kind 10) over the served package: the reader finds the receipt's exact event in a valid checkpoint.
      const input = await served(), items = [...codec.decodeEvidencePackage(input.package, PACKAGE_LIMITS), { kind: 10, payload: receipts[kind] }]
        .sort((a, b) => a.kind - b.kind || Buffer.compare(sha(a.payload), sha(b.payload)));
      const read = await replay({ ...input, package: codec.encodeEvidencePackage(items, PACKAGE_LIMITS) });
      assert.equal(read.status, "receipt-status"); assert.equal(read.receipt.status, "final");
      receiptReads[kind] = read.receipt;
    }
  });
  await test("receiver, payer and operator restore exactly their unspent notes from their seeds", () => {
    const values = result => result.candidates.map(c => [BigInt(c.cm), c.value]);
    assert.deepEqual(values(holdings.receiver), [[burnChange.cm, "2"]]);
    assert.deepEqual(values(holdings.payer), [[payerView.holdings[0].cm, "2"]]);
    assert.deepEqual(values(holdings.operator), [[fee.cm, "1"]]);
    for (const result of Object.values(holdings)) assert.deepEqual(result.audit, audit.audit);
  });
  await prover.close();
  await api.destroy(); api = undefined;
  // The fresh reader holds this pin beside its keys, independently of the served package.
  if (withErgo || withTestnet) writeFileSync(join(build, "ergo-pin.bin"), pin);
  if (withTestnet) writeFileSync(join(build, "testnet-reader.json"), JSON.stringify(live.readerConfig()));
  // Asynchronous, so the in-process loopback service keeps its connection
  // timers: a blocked loop let an overdue keep-alive close race the next fetch.
  const worker = async (input, directory = build) => {
    const url = pathToFileURL(directory + sep).href;
    const child = spawn(process.execPath, [join(here, "local-worker.mjs"), url, ...(withTestnet ? ["--testnet"] : withErgo ? ["--ergo"] : [])], {
      timeout: withTestnet ? testnet.TESTNET_LIMITS.workerMs : 120_000, cwd: build, windowsHide: true });
    const stdout = [], stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    const closed = once(child, "close");
    child.stdin.end(serialize(input));
    const [status, signal] = await closed, output = Buffer.concat(stdout);
    assert.equal(signal, null, "worker timed out"); assert.equal(status, 0, Buffer.concat(stderr).toString());
    assert(output.length <= 1_048_576, "worker output budget");
    return JSON.parse(output.toString());
  };
  const fresh = {};
  await test("a fresh seedless process verifies the same supply from the package and the venue alone", async () => {
    const input = await served();
    assert.deepEqual(Object.keys(input).sort(), withTestnet ? ["package", "selection"] : ["package", "selection", "venue"]);
    fresh.audit = await worker(input);
    assert.deepEqual(fresh.audit, audit);
  });
  if (!withTestnet) await test("a fresh process restores the receiver's note from its seed and public bytes", async () => {
    fresh.receiver = await worker(await served(receiverSeed));
    assert.deepEqual(fresh.receiver, holdings.receiver);
  });
  if (withErgo || withTestnet) await test("the fresh reader refuses a wrong independent pin and a withheld carrying section", async () => {
    const input = await served();
    const refused = result => {
      assert.equal(result.status, "unresolved-evidence"); assert.equal(result.audit, null);
      assert.deepEqual(result.candidates, []); assert.equal(result.spendable, false);
      assert.equal(result.fullV3Replay, false);
      return result;
    };
    const wrongPin = new Uint8Array(pin); wrongPin[0] ^= 1;
    try {
      writeFileSync(join(build, "ergo-pin.bin"), wrongPin);
      fresh.wrongPin = refused(await worker(input));
    } finally { writeFileSync(join(build, "ergo-pin.bin"), pin); }
    if (withTestnet) {
      // Withhold the last commitment's actual carrying block, which need not
      // equal the judging block after live-chain progress during proving.
      const carrying = audit.audit.range.carrying.at(-1);
      const withheldHeader = hex(await live.headerId(BigInt(carrying.index)));
      try {
        writeFileSync(join(build, "testnet-reader.json"), JSON.stringify({ ...live.readerConfig(), withheldHeader }));
        fresh.withheldSection = refused(await worker(input));
      } finally { writeFileSync(join(build, "testnet-reader.json"), JSON.stringify(live.readerConfig())); }
      return;
    }
    // At depth 1 the tip's parent is the witnessed block carrying the last commitment.
    // Keep that header and all ancestry intact, withholding only its transaction section.
    assert.equal(hex(input.venue.tip.parent.id), hex(pin));
    fresh.withheldSection = refused(await worker({ ...input,
      venue: { tip: { ...input.venue.tip, parent: { ...input.venue.tip.parent, section: [] } } } }));
  });
  const finalPackage = await serviceClient.package(backing);
  await test("a reopened journal reads its rows to the same package and replies, and its audit proves them again", async () => {
    journal.close();
    // Reopening verifies no proof: under a verifier that accepts none the journal still loads, and only its audit refuses.
    journal = new V3OperatorJournal(journalPath, { ...options, verifier: { verify: () => false } });
    assert.deepEqual((await journal.package(backing)).package, finalPackage.package);
    await refusal(journal.audit(), "STORAGE", "PROOF");
    journal.close();
    const reopenApi = await startBackend(parameters);
    try {
      const again = await openV3Prover(reopenApi, programs, configuration);
      try {
        journal = new V3OperatorJournal(journalPath, { ...options, verifier: again.verifier });
        await serve();
        assert.deepEqual(await serviceClient.package(backing), finalPackage);
        for (const kind of ["issue", "pay", "burn"]) assert.deepEqual(await submit(records[kind]), receipts[kind]);
        await journal.audit();
      } finally { await again.close(); }
    } finally { await reopenApi.destroy(); }
  });

  let publicBundle;
  if (withTestnet) {
    // Retain only public replay inputs, independently selected trust inputs
    // and checked public bytecode/keys. No journal, witness, seed or funding key.
    const directory = join(scratch, "pool-v3-testnet-reader"), input = await served();
    assert.deepEqual(Object.keys(input).sort(), ["package", "selection"]);
    const files = new Map([["input.bin", serialize(input)],
      ["testnet-reader.json", Buffer.from(JSON.stringify(live.readerConfig(), null, 2) + "\n")],
      ["ergo-pin.bin", pin],
      ...publicArtifactFiles(build, manifest)]);
    const launcher = 'import { spawnSync } from "node:child_process";\n' +
      'import { readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n' +
      'const child = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/pool/v3/local-worker.mjs", import.meta.url)), ' +
      'new URL("./", import.meta.url).href, "--testnet"], { input: readFileSync(new URL("input.bin", import.meta.url)), ' +
      `stdio: ["pipe", "inherit", "inherit"], windowsHide: true, timeout: ${testnet.TESTNET_LIMITS.workerMs} });\n` +
      'if (child.error) throw child.error;\nprocess.exitCode = child.status ?? 1;\n';
    files.set("replay.mjs", Buffer.from(launcher));
    const totalBytes = [...files.values()].reduce((sum, value) => sum + value.length, 0);
    assert(totalBytes <= 4_194_304, "public testnet reader bundle budget");
    mkdirSync(directory, { recursive: true });
    for (const [name, value] of files) writeFileSync(join(directory, name), value);
    assert.deepEqual(await worker(input, directory), fresh.audit, "the retained public bundle must replay independently");
    publicBundle = { directory: "scratch/pool-v3-testnet-reader", totalBytes,
      replay: "node scratch/pool-v3-testnet-reader/replay.mjs",
      sha256: Object.fromEntries([...files].map(([name, value]) => [name, hex(sha(value))])) };
  }
  assert.deepEqual(sourceHashes(sources), sourceSha256Lf, "acceptance sources changed during the run");
  const elapsedMs = Math.round(performance.now() - runStarted);
  if (withTestnet) assert(elapsedMs < testnet.TESTNET_LIMITS.runMs, "testnet run time budget");
  const report = { schema: withTestnet ? "moe-v3-testnet-journal-1" : "moe-v3-operator-journal-1",
    specification: V3_SPECIFICATION, node: process.version, platform: process.platform, elapsedMs,
    candidateDomain: hex(domain), backing: hex(backing), venue: { context: reference.context, lag: lag.toString(), id: hex(venue.id),
      ...(withTestnet ? { ...live.readerConfig(), witnessedBlock: hex(pin), tipHeight: live.tipHeight.toString(),
        anchorContextSha256: hex(sha(Buffer.concat(live.context))), funding: "throwaway testnet key", publisher: "ErgoPublisher",
        submittedTransactions: live.submitted, budgets: testnet.TESTNET_LIMITS }
      : withErgo ? { anchor: hex(ERGO_PROFILE.anchor), depth: ERGO_PROFILE.depth.toString(), witnessedBlock: hex(pin),
        tipHeight: supplier.tip.height.toString(), funding: "invented synthetic box", publisher: "ErgoPublisher" } : { label: hex(label) }) },
    checks, metrics, packageBytes: finalPackage.package.length, recordBytes: Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.length])),
    venueRecords: audit.audit.range.carrying.length, sourceSha256Lf, audit, holdings, receiptReads, fresh,
    ...(publicBundle === undefined ? {} : { publicBundle }),
    limits: [withTestnet
      ? "Explicit live testnet only, own node v6.0.6, depth 2. The independently selected already-final anchor and its pre-anchor ancestry are trust inputs. Header work, testnet difficulty, linkage and transaction sections after that anchor are verified by ErgoVenue. The fresh seedless reader holds its manifest, keys, endpoint, profile and witnessed pin outside the package and fetches node bytes itself. No mainnet, adopted domain, deployment or production finality claim."
      : withErgo
      ? "Candidate configuration from the independently held manifest; actual ErgoPublisher transactions mined by a synthetic supplier and read through ErgoVenue under a recomputed synthetic reference identity. The seedless reader independently holds the witnessed block pin: difficulty 1 permits anyone to re-mine a heavier chain. Invented funding; no live node, network deployment, adopted domain or real-chain finality."
      : "Candidate configuration from the independently held manifest and a local reference venue whose identity the guard recomputes; no adopted domain, chain venue or finality.",
      "One genesis segment of one backing: no imports, recovery kinds, replacement, second backing or silence/non-service clause. The journal reads the venue's full ranges on every operation.",
      "The payer wallet restores its note from the served package, selects and pads its inputs, prepares its own change and zero outputs beside the receiver's and operator's exact requests, proves through the runtime prover, saves and submits the exact record, and reconciles it final. The receiver wallet persists an exact request and final fulfillment across reopening. Submission, commitment, publication and evidence retrieval use the authenticated loopback v3 service. Receiver invitation transport and fee quotes remain outside this fixture; the burn and hostile cases restore paths and prove through the existing reader/prover.",
      "Restart replay is exercised once here; restarts mid-publication and exact retry across restarts are slice 5."] };
  const reportName = withTestnet ? "pool-v3-testnet-results.json" : "pool-v3-store-results.json";
  writeFileSync(join(scratch, reportName), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS: ${checks.length} operator journal checks, ${metrics.length} real proofs; scratch/${reportName}`);
} finally {
  await stopService();
  receiverWallet?.close(); payerWallet?.close();
  try { journal?.close(); } catch { /* already closed */ }
  if (api) await api.destroy();
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error("unsafe store build cleanup");
  rmSync(target, { recursive: true, force: true });
}
