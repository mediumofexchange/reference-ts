// M5b.5 acceptance with real proofs, past the old ceiling of one package in
// memory (one megabyte, about 67 statements): the journal admits a longer
// history and serves it by stream; the payer wallet syncs its own evidence file
// over HTTP, reads from its kept replay file and pays from kept witnesses, so
// the circuits check each kept path; a fresh seedless process verifies the
// whole history from its own files; and with the operator offline a holder
// forces redemption from its kept files alone, the operator returns and adopts,
// and the wallet re-proves the payment the silence lapsed. Local reference
// venue only. --reader is that fresh process: no journal, seed or witness.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { serialize, deserialize } from "node:v8";
import { UltraHonkBackend } from "@aztec/bb.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../../../dist/record-venue.js";
import { ownerOf, commitmentOf } from "../../../dist/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../../../dist/pool/v3/capsules.js";
import { decodeReceipt } from "../../../dist/pool/v3/commitments.js";
import { EvidenceStore } from "../../../dist/pool/v3/evidence-store.js";
import { ownedNotes, seedWitness } from "../../../dist/pool/v3/holdings.js";
import { decodeEvidencePackage } from "../../../dist/pool/v3/package.js";
import { readFrontier } from "../../../dist/pool/v3/package-reader.js";
import { openV3Prover, POOL_V3_CIRCUITS } from "../../../dist/pool/v3/prover.js";
import { decodeRecord, encodePublication, encodeRecord, statementHash } from "../../../dist/pool/v3/records.js";
import { ReplayStore } from "../../../dist/pool/v3/replay-store.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { createV3Service } from "../../../dist/pool/v3/service-http.js";
import { V3OperatorJournal } from "../../../dist/pool/v3/store.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { authorizeAcceptance, authorizeIssue, authorizeSettlement, demandTask, issueTask, settleTask,
  withdrawalRecord } from "../../../dist/pool/v3/witness.js";
import { PROOF_OPTIONS, proofVerifier, startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { RELATION_KINDS, loadManifest, checkSources, adoptedDomain, readKeys } from "./manifest.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";

const here = import.meta.dirname, root = resolve(here, "../../.."), b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex");
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag };
/** What one package in a reader's memory held before M5b: its byte budget and the statements that fit it. */
const OLD_PACKAGE_BYTES = 1_048_576, OLD_STATEMENTS = 67;
/** The fresh reader's verifier instances. */
const READER_INSTANCES = 2;
/** The history: one note to the holder, ISSUES to the payer, then PAYMENTS in rounds of ROUND per checkpoint. */
const ISSUES = 36, PAYMENTS = 36, ROUND = 12, HISTORY = 1 + ISSUES + PAYMENTS;
const programsOf = build => Object.fromEntries(RELATION_KINDS.map(([, name]) => [name, JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"))]));
const summary = result => {
  const c = result.canonical; assert(c !== undefined, "expected a canonical checkpoint");
  return { supply: String(c.state.issued - c.state.burned), position: String(c.state.position), sequence: String(c.commitment.sequence),
    canonicalIndex: String(c.index), segment: hex(c.segment), spentRoot: hex(c.state.spentRoot()), history: hex(c.state.history),
    force: result.force.map(f => ({ index: String(f.index), kind: f.record.kind })), clock: result.clock ?? null };
};

/** A fresh seedless process: its own evidence and kept replay files in `directory`, the runtime verifier over
 * keys it derives from artifacts it checks against the manifest, and the terms and venue it is handed beside
 * (never from the service). With a service it syncs first; without one it reads what its files hold. */
async function reader(build, directory) {
  const manifest = loadManifest(); checkSources(manifest);
  const domain = adoptedDomain();
  readKeys(build, manifest);
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; assert(length <= 4_194_304, "reader input budget"); chunks.push(chunk); }
  const input = deserialize(Buffer.concat(chunks));
  assert(["signed,venue", "service,signed,venue"].includes(Object.keys(input).sort().join(",")));
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  let runtime, evidence, store;
  try {
    // Two instances, declared, so the read verifies ahead of its replay (M5b.6).
    runtime = await proofVerifier(api, POOL_V3_CIRCUITS, programsOf(build), { instances: READER_INSTANCES });
    let verified = 0;
    const verifier = { identities: runtime.identities, parallel: runtime.parallel,
      verify: (kind, inputs, proof) => { verified++; return runtime.verify(kind, inputs, proof); } };
    const venue = FixtureVenue.from(input.venue), terms = codec.decodeRootTerms(input.signed.terms), backing = codec.rootTermsName(input.signed.terms);
    evidence = new EvidenceStore(join(directory, "evidence.db"));
    store = new ReplayStore(join(directory, "replay.db"), { digest: join(directory, "replay.db.sha256") });
    const own = join(directory, "own.bin");
    if (input.service !== undefined) {
      const client = new V3ServiceClient(input.service.url, input.service.token, { domain, operator: terms.operator, reference });
      writeFileSync(own, (await client.sync(backing, evidence)).package);
    }
    const began = performance.now();
    const result = await readFrontier(new Uint8Array(readFileSync(own)), input.signed, venue.witnessedIndex(),
      { verifier, venue, reference, evidence, store });
    process.stdout.write(JSON.stringify({ summary: summary(result), verified, instances: runtime.parallel, readMs: Math.round(performance.now() - began),
      maxRssBytes: process.resourceUsage().maxRSS * 1024, heapUsedBytes: process.memoryUsage().heapUsed }));
  } finally { store?.close(); evidence?.close(); await runtime?.close(); await api.destroy(); }
}

async function acceptance() {
  mkdirSync(join(root, "scratch"), { recursive: true });
  const scratch = realpathSync(join(root, "scratch")), build = realpathSync(mkdtempSync(join(scratch, "v3-history-store-")));
  const checks = [], proofs = new Map(), measures = {}, started = performance.now();
  const test = async (name, fn) => { await fn(); checks.push(name); process.stderr.write(`passed: ${name}\n`); };
  const sources = sourceClosure(["scripts/pool/v3/history-store-check.mjs", "scripts/pool/v3/compile.mjs", 
    ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
    "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
  const hashes = sourceHashes(sources);
  let api, prover, journal, payer, receiver, restored, holderEvidence, holderReplay, server, client, completed = false;
  const stopService = async () => {
    if (server === undefined) return;
    const closing = server; server = undefined;
    await new Promise((done, failed) => { closing.close(error => error ? failed(error) : done()); closing.closeAllConnections(); });
  };
  try {
    const manifest = loadManifest(); checkSources(manifest);
    const domain = adoptedDomain();
    execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
    api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    const programs = programsOf(build);
    for (const [kind, name] of RELATION_KINDS) writeFileSync(join(build, `${kind}.vk`), await new UltraHonkBackend(programs[name].bytecode, api).getVerificationKey(PROOF_OPTIONS));
    readKeys(build, manifest);
    prover = await openV3Prover(api, programs);
    const prove = async task => {
      const began = performance.now(), record = await prover.prove(task), ms = Math.round(performance.now() - began);
      const entry = proofs.get(task.kind) ?? { kind: task.kind, count: 0, bytes: record.proof.length, totalMs: 0, maxMs: 0 };
      assert.equal(record.proof.length, entry.bytes);
      proofs.set(task.kind, { ...entry, count: entry.count + 1, totalMs: entry.totalMs + ms, maxMs: Math.max(entry.maxMs, ms) });
      return record;
    };
    const unused = async () => { throw new Error("nothing is proven here"); };

    // The wallets' and the holder's verifier and venue count what a read verifies and asks.
    const venue = FixtureVenue.reference(label, lag), counts = { verified: 0, asked: 0 };
    const counting = { identities: prover.verifier.identities, verify: (kind, inputs, proof) => { counts.verified++; return prover.verifier.verify(kind, inputs, proof); } };
    const seen = { get id() { return venue.id; }, lag: () => venue.lag(), witnessedIndex: () => venue.witnessedIndex(),
      range: (request, limits) => { counts.asked++; return venue.range(request, limits); } };
    const measure = async action => {
      const before = { ...counts }, began = performance.now(), value = await action();
      return { value, verified: counts.verified - before.verified, asked: counts.asked - before.asked, ms: Math.round(performance.now() - began) };
    };
    const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
    const silence = 16n;
    const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 80n,
      payout: { thing: "history reference units", quantumExponent: 0, perUnit: 1n }, silence: { noCommitmentDuration: silence, challengeWindow: 5n } });
    const backing = codec.rootTermsName(terms), signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
    const genesis = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const options = { venue: seen, reference, verifier: counting };
    const open = name => new V3Wallet(join(build, `${name}.db`), options);
    payer = open("payer"); receiver = open("receiver");
    // The holder keeps no wallet: a seed, its own evidence file and its own kept replay file with that seed's witnesses.
    const holderSeed = b(71), holderNote = prepareExactOutput(holderSeed, domain, b(72), backing, 10n), holderPad = prepareExactOutput(holderSeed, domain, b(73), backing, 0n);
    holderEvidence = new EvidenceStore(join(build, "holder.evidence"));
    holderReplay = new ReplayStore(join(build, "holder.replay"), { digest: join(build, "holder.replay.sha256") });
    let holderOwn;
    const holderRead = () => readFrontier(holderOwn, signed, venue.witnessedIndex(),
      { ...options, evidence: holderEvidence, store: holderReplay, witness: seedWitness(holderSeed, domain) });
    const holderNotes = result => ownedNotes(holderSeed, domain, backing, result.canonical.state);

    const journalPath = join(build, "journal.db"), journalOptions = { secret: operatorSecret, venue, reference, verifier: prover.verifier };
    journal = new V3OperatorJournal(journalPath, journalOptions);
    const credentials = { walletToken: randomBytes(32).toString("hex"), adminToken: randomBytes(32).toString("hex") }, requests = [];
    const serve = async () => {
      await stopService();
      server = createV3Service(journal, credentials);
      server.prependListener("request", (request, response) => {
        const entry = { url: request.url ?? "", bytes: 0 }, write = response.write.bind(response); requests.push(entry);
        response.write = (chunk, ...rest) => { entry.bytes += chunk.length; return write(chunk, ...rest); };
      });
      await new Promise((done, failed) => server.listen(0, "127.0.0.1", done).once("error", failed));
      client = new V3ServiceClient(`http://127.0.0.1:${server.address().port}/`, credentials.walletToken, { domain, operator, reference }, credentials.adminToken);
    };
    const fetched = () => requests.findLast(entry => entry.url.startsWith("/evidence"));
    const checkpoint = async id => { await client.commit(id); return client.publish(); };
    /** Sync the wallet's evidence file from the service, then read with the read's own package. */
    const synced = async wallet => {
      const served = await wallet.supply(evidence => client.sync(backing, evidence));
      assert.deepEqual(decodeEvidencePackage(served.package).map(item => item.kind), [1, 2]);
      return { served, view: await wallet.sync(served.package, signed) };
    };
    const values = view => view.holdings.map(h => [h.value, h.status]).sort(([a, s], [c, t]) => Number(a - c) || s.localeCompare(t));
    const holdings = view => view.holdings.map(h => [String(h.cm), String(h.value), h.status]).sort();
    const notes = (...groups) => groups.flatMap(([count, value, status = "available"]) => Array.from({ length: count }, () => [value, status]));
    /** The fresh reader process over `directory`, online or from its files alone, with the venue as it stands. */
    const fresh = async (directory, online) => {
      mkdirSync(directory, { recursive: true });
      const child = spawn(process.execPath, [import.meta.filename, "--reader", build, directory], { cwd: root, windowsHide: true, timeout: 600_000 });
      const stdout = [], stderr = [];
      child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
      const closed = once(child, "close"), before = requests.length;
      child.stdin.end(serialize({ venue: venue.export(), signed, ...(online ? { service: { url: client.baseUrl, token: credentials.walletToken } } : {}) }));
      const [status, signal] = await closed;
      assert.equal(signal, null, "the reader timed out"); assert.equal(status, 0, Buffer.concat(stderr).toString());
      const evidence = requests.slice(before).filter(entry => entry.url.startsWith("/evidence"));
      assert.equal(evidence.length, online ? 1 : 0);
      return { ...JSON.parse(Buffer.concat(stdout).toString()), fetchedBytes: evidence[0]?.bytes ?? 0 };
    };

    let own, last;
    await test(`the journal admits ${HISTORY} real-proof statements and the payer pays ${PAYMENTS} times from its kept witnesses`, async () => {
      assert(HISTORY > OLD_STATEMENTS);
      await journal.open("genesis", signed); await serve(); await client.publish();
      await client.submit(encodeRecord(authorizeIssue(await prove(issueTask(genesis, holderNote)), issuerSecret)));
      for (let i = 0; i < ISSUES; i++) {
        await client.submit(encodeRecord(authorizeIssue(await prove(issueTask(genesis, payer.request(`fund-${i}`, backing, 2n))), issuerSecret)));
      }
      await checkpoint("issued");
      const first = await measure(() => synced(payer)); own = first.value.served;
      // The first read verifies every record once, the holder's issue included.
      assert.equal(first.verified, 1 + ISSUES);
      assert.deepEqual(values(first.value.view), notes([ISSUES, 2n]));
      measures.payerFirstRead = { statements: 1 + ISSUES, verified: first.verified, ms: first.ms, fetchedBytes: fetched().bytes };
      const rounds = [];
      for (let i = 0; i < PAYMENTS; i++) {
        const order = { request: receiver.request(`invoice-${i}`, backing, 1n), value: 1n };
        // Preparing reads the kept state: it verifies the wallet's own new proof only and asks the venue nothing.
        const prepared = await measure(() => payer.prepare(`pay-${i}`, order, own.package, signed, prove));
        assert.deepEqual([prepared.verified, prepared.asked], [1, 0]);
        last = await payer.submit(`pay-${i}`, client);
        assert.equal(last.position, BigInt(2 + ISSUES + i));
        if ((i + 1) % ROUND !== 0) continue;
        await checkpoint(`paid-${i + 1}`);
        // A later sync fetches and verifies the round's records only.
        const next = await measure(() => synced(payer)); own = next.value.served;
        assert.equal(next.verified, ROUND);
        assert(fetched().url.endsWith(`&after=${own.selection.sequence - 1n}`));
        assert(fetched().bytes < ROUND * (prepared.value.record.length + 64) + 4_096, "a later sync fetches the new records and the new checkpoint's objects");
        for (let paid = i + 1 - ROUND; paid <= i; paid++) assert.equal(payer.payment(`pay-${paid}`).status, "final");
        rounds.push({ verified: next.verified, asked: next.asked, ms: next.ms, fetchedBytes: fetched().bytes });
      }
      measures.payerLaterReads = rounds;
      // Twelve two-unit notes were never spent; twelve one-unit change notes remain from the first and third rounds
      // (the second round spent the first's change exactly).
      const view = await payer.sync(own.package, signed);
      assert.deepEqual(values(view), notes([12, 1n], [12, 2n]));
    });

    const kept = join(build, "reader-kept"), readers = {};
    await test("a fresh seedless process syncs the whole history over HTTP, past the old package, and verifies every proof", async () => {
      readers.first = await fresh(kept, true);
      assert(readers.first.fetchedBytes > OLD_PACKAGE_BYTES, "the served history exceeds the old one-megabyte package");
      assert.equal(readers.first.verified, HISTORY);
      assert.deepEqual([readers.first.summary.supply, readers.first.summary.position, readers.first.summary.sequence],
        [String(10 + 2 * ISSUES), String(HISTORY), String(own.selection.sequence)]);
    });

    await test("a restarted payer fetches, verifies and asks nothing; the receiver syncs once and finds every invoice paid", async () => {
      const before = holdings(await payer.sync(own.package, signed));
      payer.close(); payer = open("payer");
      const again = await measure(() => synced(payer));
      assert.deepEqual([again.verified, again.asked], [0, 0]);
      assert(fetched().bytes < 1_500);
      assert.deepEqual(holdings(again.value.view), before);
      measures.payerRestart = { verified: again.verified, asked: again.asked, ms: again.ms, fetchedBytes: fetched().bytes };
      const first = await measure(() => synced(receiver));
      assert.equal(first.verified, HISTORY);
      assert.deepEqual(values(first.value.view), notes([PAYMENTS, 1n]));
      const fulfilled = await measure(async () => {
        for (let i = 0; i < PAYMENTS; i++) {
          assert.deepEqual((await receiver.fulfill(`invoice-${i}`, first.value.served.package, signed)).checkpoint, first.value.view.checkpoint);
        }
      });
      assert.equal(fulfilled.verified, 0);
      measures.receiver = { firstReadVerified: first.verified, firstReadMs: first.ms, fulfilled: PAYMENTS, fulfillMs: fulfilled.ms };
    });

    let pending, canonicalIndex, held, header;
    await test("the operator falls silent with an admitted payment uncommitted: service and new payments are refused", async () => {
      pending = await payer.prepare("pending", { request: receiver.request("pending-invoice", backing, 1n), value: 1n }, own.package, signed, prove);
      assert.equal((await payer.submit("pending", client)).position, BigInt(HISTORY + 1));
      // The holder's last sync and first read, while the service still answers.
      holderOwn = (await client.sync(backing, holderEvidence)).package;
      const first = await measure(holderRead), found = holderNotes(first.value);
      assert.equal(first.verified, HISTORY);
      assert.deepEqual(found.map(note => [note.cm, note.opening.value]), [[holderNote.cm, 10n]]);
      canonicalIndex = venue.witnessedIndex();
      await stopService();
      venue.advance(canonicalIndex + silence + 1n);
      await assert.rejects(journal.commit("late"), error => error.code === "STALE" && error.check === "SILENCE");
      const late = { request: receiver.request("late-invoice", backing, 1n), value: 1n };
      await assert.rejects(payer.prepare("late", late, own.package, signed, unused), { code: "SILENCE" });
      assert.equal(payer.payment("late"), undefined);
    });

    const forced = {};
    await test("with the service down, the holder forces redemption from its kept files and a fresh process reads the force", async () => {
      // The holder's note is the history's first output: its kept witness was updated through every later one.
      const read = await measure(holderRead), [note] = holderNotes(read.value);
      assert.deepEqual([read.verified, note.leaf], [0, 0n]);
      const input = { note, anchor: note.anchor, path: note.path };
      held = [input, { ...input, note: holderPad }]; header = read.value.canonical.header;
      const context = { domain, header }, presenters = [b(18), b(19)];
      const publish = (kind, record) => venue.publishRecord(4, backing, encodePublication({ domain, backing, kind, record }));
      const demand = (secret, deadline) => prove(demandTask(context, held,
        { backing, quantity: 10n, presenter: ed25519.getPublicKey(secret), instant: venue.witnessedIndex() + 1n - lag, deadline }));
      const deadline = venue.witnessedIndex() + 30n;
      forced.first = await demand(presenters[0], deadline); await publish(1, forced.first);
      forced.withdrawal = withdrawalRecord(context, statementHash(forced.first), presenters[0]); await publish(4, forced.withdrawal);
      forced.second = await demand(presenters[1], deadline + 1n); await publish(1, forced.second);
      assert.deepEqual((await holderRead()).force.map(f => f.record.kind), [4, 5, 4]);
      // The backer accepts and the holder settles to the backer's public opening (C3.4–5).
      const id = statementHash(forced.second), ownerSecret = deriveSettlementOwnerSecret(b(22), domain, id, deadline).value;
      const opening = { backing, value: 10n, owner: ownerOf(ownerSecret), rho: 42n };
      forced.settled = authorizeSettlement(await prove(settleTask(context, held, { opening, cm: commitmentOf(domain, opening) }, id)),
        authorizeAcceptance({ domain, demand: id, owner: opening.owner, deadline }, issuerSecret), presenters[1]);
      await publish(3, forced.settled);
      const after = await holderRead();
      assert.deepEqual(after.force.map(f => f.record.kind), [4, 5, 4, 6]);
      // Force changes no supply and no history; the fresh reader's kept files read it without the service.
      readers.offline = await fresh(kept, false);
      assert.deepEqual(readers.offline.summary.force, after.force.map(f => ({ index: String(f.index), kind: f.record.kind })));
      assert.deepEqual({ ...readers.offline.summary, force: [], clock: null }, { ...readers.first.summary, force: [], clock: null });
      assert.equal(readers.offline.verified, 3);
      // The payer's lapsed payment stays prepared and its input reserved: nothing became final.
      const view = await payer.sync(own.package, signed);
      assert.equal(payer.payment("pending").status, "prepared");
      assert.deepEqual(values(view), notes([11, 1n], [1, 1n, "reserved"], [12, 2n]));
    });

    let final;
    await test("the operator returns and adopts the forced block exactly; the wallet re-proves its lapsed payment and pays again", async () => {
      await journal.return("return");
      await assert.rejects(journal.adopt(), error => error.code === "UNAVAILABLE");
      await journal.publish();
      const expected = [forced.first, forced.withdrawal, forced.second, forced.settled], adopted = await journal.adopt();
      assert.deepEqual(adopted.map(bytes => decodeReceipt(bytes).statementHash), expected.map(statementHash));
      await serve(); await checkpoint("adopted");
      const returned = await measure(() => synced(payer)); own = returned.value.served;
      measures.payerAfterReturn = { verified: returned.verified, asked: returned.asked, ms: returned.ms, fetchedBytes: fetched().bytes };
      assert(fetched().bytes < 100_000, "the returned segment's evidence is fetched, not the imported history");
      assert.equal(payer.payment("pending").status, "prepared");
      // The same nullifiers, outputs and capsules, proven again against the returned segment from kept witnesses.
      const reproven = await payer.reprove("pending", own.package, signed, prove);
      assert.notDeepEqual(reproven.statement, pending.statement);
      assert.deepEqual(decodeRecord(reproven.record).publicInputs.slice(7), decodeRecord(pending.record).publicInputs.slice(7));
      assert.deepEqual(reproven.superseded.map(old => [old.record, old.receipt?.position]), [[pending.record, BigInt(HISTORY + 1)]]);
      assert.equal((await payer.submit("pending", client)).position, 5n);
      await payer.prepare("after-return", { request: receiver.request("after-invoice", backing, 1n), value: 1n }, own.package, signed, prove);
      assert.equal((await payer.submit("after-return", client)).position, 6n);
      const commitment = await checkpoint("returned");
      ({ served: own, view: final } = await synced(payer));
      assert.deepEqual(final.checkpoint, commitment);
      for (const name of ["pending", "after-return"]) assert.equal(payer.payment(name).status, "final");
      assert.deepEqual(values(final), notes([10, 1n], [12, 2n]));
      const paid = await receiver.supply(evidence => client.sync(backing, evidence));
      for (const name of ["pending-invoice", "after-invoice"]) assert.deepEqual((await receiver.fulfill(name, paid.package, signed)).checkpoint, commitment);
      await assert.rejects(receiver.fulfill("late-invoice", paid.package, signed), { code: "ABSENT" });
      // The holder's note is settled: its seed holds nothing, and the nullifier is in the adopted history.
      holderOwn = (await client.sync(backing, holderEvidence)).package;
      const holder = await holderRead();
      assert.deepEqual(holderNotes(holder), []);
      assert(holder.canonical.state.hasNullifier(held[0].note.nf));
      // The force stays listed at its original indices, now before the backing's adoption index (the opening's): it has no further effect.
      assert.deepEqual(holder.force.map(f => f.record.kind), [4, 5, 4, 6]);
      assert.equal(holder.canonical.state.adoptionIndices.get(hex(backing)), holder.force.at(-1).index + 1n);
    });

    await test("kept and fresh reads agree: the fresh process incrementally, a new one from nothing, and a wallet restored from the seed", async () => {
      readers.kept = await fresh(kept, true);
      readers.scratch = await fresh(join(build, "reader-scratch"), true);
      assert.deepEqual(readers.kept.summary, readers.scratch.summary);
      assert.deepEqual([readers.kept.summary.supply, readers.kept.summary.position, readers.kept.summary.force], [String(10 + 2 * ISSUES), "6", readers.offline.summary.force]);
      assert(readers.kept.verified < readers.scratch.verified && readers.kept.fetchedBytes < readers.scratch.fetchedBytes / 4);
      restored = V3Wallet.restoreSeed(join(build, "restored.db"), options, payer.recoverySeed());
      const first = await measure(() => synced(restored));
      assert.deepEqual(holdings(first.value.view), holdings(final));
      measures.restoredWallet = { verified: first.verified, ms: first.ms, fetchedBytes: fetched().bytes };
    });

    await test("a reopened journal reads its rows and its audit proves every record again", async () => {
      await stopService(); journal.close();
      journal = new V3OperatorJournal(journalPath, journalOptions);
      const began = performance.now(); await journal.audit();
      measures.journalAudit = { ms: Math.round(performance.now() - began) };
    });

    checkSources(manifest); assert.deepEqual(sourceHashes(sources), hashes, "sources changed during acceptance");
    const report = { status: "passed", specification: V3_SPECIFICATION, evidence: "local-runtime-real-proofs", node: process.version, platform: process.platform,
      limits: ["the adopted configuration on reference venues only", "single backing on the local reference venue; no chain venue or live broadcast",
        "one process holds the prover, the journal, its loopback service and both wallets; the seedless reader is its own process",
        "a history of tens of statements: past the old package, not the target scale", "no persistence-fault, adoption or custody claim"],
      history: { statements: HISTORY, oldStatements: OLD_STATEMENTS, oldPackageBytes: OLD_PACKAGE_BYTES, issues: 1 + ISSUES, payments: PAYMENTS, checkpoints: String(own.selection.sequence) },
      checks, proofs: [...proofs.values()].sort((a, c) => a.kind - c.kind), reads: measures, readers,
      process: { maxRssBytes: process.resourceUsage().maxRSS * 1024, heapUsedBytes: process.memoryUsage().heapUsed },
      elapsedMs: Math.round(performance.now() - started), sourceSha256Lf: hashes };
    writeFileSync(join(root, "docs", "pool-v3-history-store-verification.json"), JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n"); completed = true;
  } finally {
    await stopService().catch(() => {});
    for (const wallet of [payer, receiver, restored]) { try { wallet?.close(); } catch { /* already closed */ } }
    holderReplay?.close(); holderEvidence?.close();
    try { journal?.close(); } catch { /* already closed */ }
    await prover?.close(); await api?.destroy();
    if (completed) { assert(build.startsWith(scratch + sep)); rmSync(build, { recursive: true, force: true }); }
    else process.stderr.write(`History acceptance scratch retained after failure: ${build}\n`);
  }
}

if (process.argv[2] === "--reader") {
  assert.equal(process.argv.length, 5);
  await reader(process.argv[3], process.argv[4]);
} else {
  assert.equal(process.argv.length, 2, "history-store-check takes no argument");
  await acceptance();
}
