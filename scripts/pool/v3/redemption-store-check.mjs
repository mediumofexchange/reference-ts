// Slice 9 M9d1 acceptance: redemption through the wallet with real proofs. The operator's journal serves wallets
// over its HTTP service; each wallet operation runs in a fresh process that opens its wallet database, proves with
// its own prover and syncs its kept evidence from the service: issue, payment and fulfillment, then a demand, the
// backer's acceptance (published, C3.4), the settlement and a burn under service, each act but the burn retried
// exactly in another process without evidence, prover or signer. With the operator offline past the terms' silence
// (a gap, C2b.3.2) the holder demands and settles by publication and reads both final by force; a holder-only reader
// confirms supply and force in a fresh process. A wallet restored from the seed alone finds its standing demands and
// settles one and withdraws the other (C3.6, C2.10.8). In the gap, hostile releases with real proofs: one published
// after its acceptance deadline has no force but counts towards the next settlement's disclosure count (C3.5), a timely
// copy whose presenter signature is forged has no force, and a release whose output another demand's settlement created
// first is `TAKEN`, leaving the backer's dishonour past the deadline (C3.8). --ergo uses the synthetic mining supplier
// and actual publisher. Abrupt exits inside the acts are `wallet-crash.mjs`'s (stand-in proofs).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { ed25519 } from "@noble/curves/ed25519.js";
import { commitmentOf, ownerOf } from "../../../dist/pool/notes.js";
import { deriveSettlementOwnerSecret, prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { ownedNotes, seedWitness } from "../../../dist/pool/v3/holdings.js";
import { readFrontier, readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeRecord, encodePublication, statementHash } from "../../../dist/pool/v3/records.js";
import { authorizeAcceptance, authorizeSettlement, demandTask, settleTask } from "../../../dist/pool/v3/witness.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { createV3Service } from "../../../dist/pool/v3/service-http.js";
import { V3OperatorJournal } from "../../../dist/pool/v3/store.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { startBackend } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY, readParameters } from "../prepare-crs.mjs";
import { v3Codec as codec } from "./codec.mjs";
import { drillMode, drillWorker, openDrill, workerVenue } from "./drill.mjs";
import { RELATION_KINDS } from "./manifest.mjs";

const b = n => new Uint8Array(32).fill(n);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
// Public fixture keys and local service credentials, never funds.
const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const TOKENS = { walletToken: "11".repeat(32), adminToken: "22".repeat(32) }, SILENCE = 16n;
// A holder that keeps no wallet, only a seed: its demands and settlements are built here to stage C3.8's taken release.
const takerSeed = b(71), presenters = [b(18), b(19)];
const hex = bytes => Buffer.from(bytes).toString("hex");
const output = act => decodeRecord(act.record).publicInputs[14];
const FLAG = { local: [], ergo: ["--ergo"] };

const summary = result => ({ supply: String(result.state.issued - result.state.burned), position: String(result.state.position),
  canonicalIndex: String(result.canonical.index), force: result.force.map(f => ({ index: String(f.index), kind: f.record.kind, sha256: digest(f.bytes) })) });

/**
 * One wallet process: `--wallet <build> [--ergo]`, its steps on stdin. It holds its role's database, its own prover
 * and verifier over the build's programs, and its own view of the venue; under service it syncs its kept evidence
 * from the operator's service before its steps, in a gap it reads with the package its last sync kept. `retry`
 * gives it no sync, evidence, prover or signer: an exact retry must need none. Each step's refusal is reported, not thrown.
 */
async function walletWorker(argv) {
  assert(argv.length === 1 || (argv.length === 2 && argv[1] === "--ergo"), "wallet worker takes a build directory and a mode flag");
  const directory = argv[0], mode = argv[1] === "--ergo" ? "ergo" : "local";
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = deserialize(Buffer.concat(chunks));
  const api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
  const programs = Object.fromEntries(RELATION_KINDS.map(([, circuit]) => [circuit, JSON.parse(readFileSync(join(directory, `${circuit}.json`), "utf8"))]));
  const prover = await openV3Prover(api, programs);
  let wallet;
  try {
    const { venue, reference } = await workerVenue(directory, mode, input);
    const path = join(directory, `${input.role}.db`), options = { venue, reference, verifier: prover.verifier };
    if (input.seedOf !== undefined && !existsSync(path)) {
      // The device is lost: this wallet starts from the other's seed alone, with none of its saved acts.
      const lost = new V3Wallet(join(directory, `${input.seedOf}.db`), options), seed = lost.recoverySeed(); lost.close();
      wallet = V3Wallet.restoreSeed(path, options, seed); seed.fill(0);
    } else wallet = new V3Wallet(path, options);
    const refuse = () => { throw new Error("an exact retry asks for no prover or signer"); };
    const proofs = [], prove = input.retry ? refuse : async task => {
      const began = performance.now(), record = await prover.prove(task);
      proofs.push({ kind: task.kind, bytes: record.proof.length, elapsedMs: Math.round(performance.now() - began) }); return record;
    };
    const sign = input.retry || input.role !== "backer" ? refuse : message => ed25519.sign(message, issuerSecret);
    const published = [], publisher = { publishRecord: async (kind, subject, bytes) => { published.push({ kind, subject, bytes }); } };
    let served = input.package;
    if (input.url !== undefined && !input.retry) {
      const client = new V3ServiceClient(input.url, TOKENS.walletToken, { operator, reference });
      served = (await wallet.supply(evidence => client.sync(input.signed.backing, evidence))).package;
    }
    const evidence = input.retry ? new Uint8Array() : served, terms = input.signed.signed;
    const service = { submit: record => new V3ServiceClient(input.url, TOKENS.walletToken, { operator, reference }).submit(record) };
    const operations = {
      sync: () => wallet.sync(served, terms),
      request: (alias, value) => wallet.request(alias, input.signed.backing, value),
      issue: (alias, request, value) => wallet.issue(alias, request, value, evidence, terms, prove, sign),
      prepare: (alias, request, value) => wallet.prepare(alias, { request, value }, evidence, terms, prove),
      fulfill: alias => wallet.fulfill(alias, served, terms),
      demand: (alias, quantity, deadline) => wallet.demand(alias, quantity, deadline, evidence, terms, prove),
      accept: (alias, demand, deadline) => wallet.accept(alias, demand, deadline, evidence, terms, sign),
      settle: (alias, acceptance) => wallet.settle(alias, acceptance, evidence, terms, prove),
      withdraw: (alias, demand) => wallet.withdraw(alias, demand, evidence, terms),
      burn: (alias, quantity) => wallet.burn(alias, quantity, evidence, terms, prove),
      submit: alias => wallet.submit(alias, service),
      publish: alias => wallet.publish(alias, publisher),
      publishAcceptance: alias => wallet.publishAcceptance(alias, publisher),
      presentation: demand => wallet.presentation(demand, served, terms),
      act: alias => wallet.act(alias),
    };
    const results = [];
    for (const [operation, ...args] of input.steps) {
      try { results.push({ value: await operations[operation](...args) }); }
      catch (error) { results.push({ error: { name: error.name, code: error.code, check: error.check, message: error.message } }); }
    }
    // The backend logs to stdout, so the answer goes to the file the drill named.
    writeFileSync(join(directory, "wallet-answer.bin"), serialize({ results, published, proofs, package: served }));
  } finally { wallet?.close(); await prover.close(); await api.destroy(); }
}

async function acceptance(mode) {
  const drill = await openDrill(mode, { name: "redemption-store", script: import.meta.filename });
  const { venue, domain, build, lag, advance } = drill;
  let journal, server, completed = false;
  try {
    const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 80n,
      payout: { thing: "redemption reference units", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: SILENCE, challengeWindow: 5n } });
    const backing = codec.rootTermsName(terms), signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
    journal = new V3OperatorJournal(join(build, "journal.db"), { secret: operatorSecret, venue, reference: drill.reference, verifier: drill.verifier });
    await journal.open("genesis", signed); await drill.publish(journal);
    server = createV3Service(journal, TOKENS);
    await new Promise((done, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", done); });
    let url = `http://127.0.0.1:${server.address().port}/`;
    const packages = {}, children = [];
    /** One wallet process for `role`; publications it made are published at the venue as a relay would. */
    const run = async (role, steps, { retry = false, seedOf } = {}) => {
      drill.writeReaderInputs(build);
      const read = venue.witnessedIndex();
      const input = { role, steps, retry, seedOf, signed: { backing, signed }, ...drill.venueInput(),
        ...(url === undefined ? { package: packages[role] } : { url }) };
      const began = performance.now();
      const answer = join(build, "wallet-answer.bin"); rmSync(answer, { force: true });
      await new Promise((done, failed) => {
        const child = spawn(process.execPath, [import.meta.filename, "--wallet", build, ...FLAG[mode]], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
        const err = [];
        child.stderr.on("data", chunk => err.push(chunk));
        child.on("error", failed);
        child.on("close", code => code === 0 ? done() : failed(new Error(`${role} process exited ${code}: ${Buffer.concat(err)}`)));
        child.stdin.end(serialize(input));
      });
      const { results, published, proofs, package: served } = deserialize(readFileSync(answer));
      for (const proof of proofs) drill.proofs.push({ name: `${role}: ${steps.map(([operation, alias]) => `${operation} ${alias}`).join(", ")}`, ...proof });
      children.push({ role, steps: steps.map(([operation]) => operation).join(","), retry, elapsedMs: Math.round(performance.now() - began) });
      if (served !== undefined) packages[role] = served;
      for (const p of published) {
        // A venue witnesses a publication made at the read's index no earlier than the lag after it: the fixture is
        // moved there first; the synthetic chain mines it.
        if (mode === "local" && venue.witnessedIndex() < read + lag - 1n) await advance(read + lag - 1n - venue.witnessedIndex());
        await drill.publishRecord(p.kind, p.subject, p.bytes);
      }
      return results;
    };
    const ok = results => results.map((result, i) => { assert.equal(result.error, undefined, `step ${i}: ${JSON.stringify(result.error)}`); return result.value; });
    const checkpoint = id => drill.checkpoint(journal, id);
    const holdings = view => view.holdings.map(h => [String(h.value), h.status]).sort();
    let offline;
    /** Every release the venue witnessed for `demand`, read from the package the operator served last: its output,
     * whether it had force and the check that refused it. */
    const releases = async demand => (await readFrontier(offline.package, signed, venue.witnessedIndex(),
      { venue, reference: drill.reference, verifier: drill.verifier, answers: true })).answers
      .filter(a => a.release !== undefined && hex(a.acceptance.demand) === hex(demand))
      .map(a => [String(a.release.output), a.release.force, a.release.check ?? null]);
    /** Publish a record built here as a wallet's `publish` would be relayed: on the fixture no earlier than the lag after `read`. */
    const relay = async (read, kind, fields) => {
      if (mode === "local" && venue.witnessedIndex() < read + lag - 1n) await advance(read + lag - 1n - venue.witnessedIndex());
      await drill.publishRecord(4, backing, encodePublication({ domain, backing, kind, ...fields }));
    };

    await drill.test("real-proof issue, payment and fulfillment through wallet processes over the operator's service", async () => {
      const [request] = ok(await run("holder", [["request", "fund", 10n]]));
      const [view, issued] = ok(await run("backer", [["sync"], ["issue", "issue", request, 10n], ["submit", "issue"]]));
      assert.deepEqual(view.holdings, []);
      const [retried, saved] = ok(await run("backer", [["issue", "issue", request, 10n], ["act", "issue"]], { retry: true }));
      assert.deepEqual(retried, saved); assert.deepEqual(retried.record, issued.record); assert.notEqual(saved.receipt, undefined);
      await checkpoint("issued");
      const [invoice] = ok(await run("shop", [["request", "invoice", 3n]]));
      const [funded, payment] = ok(await run("holder", [["sync"], ["prepare", "pay", invoice, 3n], ["submit", "pay"]]));
      assert.deepEqual(holdings(funded), [["10", "available"]]);
      assert.equal(payment.status, "prepared");
      await checkpoint("paid");
      const [fulfilled, received] = ok(await run("shop", [["fulfill", "invoice"], ["sync"]]));
      assert.equal(fulfilled.request.opening.value, 3n);
      assert.deepEqual(holdings(received), [["3", "available"]]);
      const [change] = ok(await run("holder", [["sync"]]));
      assert.deepEqual(holdings(change), [["7", "available"]]);
      const [, final] = ok(await run("backer", [["sync"], ["act", "issue"]]));
      assert.equal(final.status, "final");
    });

    await drill.test("demand, published acceptance, settlement and burn through wallet processes; each but the burn retried exactly", async () => {
      const at = venue.witnessedIndex(), deadline = at + 40n;
      const [, demand] = ok(await run("shop", [["sync"], ["demand", "redeem", 3n, deadline], ["submit", "redeem"]]));
      assert.equal(demand.kind, 4);
      const [retried, saved] = ok(await run("shop", [["demand", "redeem", 3n, deadline], ["act", "redeem"]], { retry: true }));
      assert.deepEqual(retried, saved); assert.deepEqual(retried.record, demand.record);
      await checkpoint("demanded");
      const [locked] = ok(await run("shop", [["sync"]]));
      assert.deepEqual(holdings(locked), [["3", "locked"]]);
      assert.equal(locked.demands.length, 1);
      const [, acceptance] = ok(await run("backer", [["sync"], ["accept", "answer", demand.demand, deadline - 10n], ["publishAcceptance", "answer"]]));
      assert.deepEqual(ok(await run("backer", [["accept", "answer", demand.demand, deadline - 10n]], { retry: true })), [acceptance]);
      const [, settled] = ok(await run("shop", [["sync"], ["settle", "settle", acceptance], ["submit", "settle"]]));
      assert.equal(settled.kind, 6);
      const [again, kept] = ok(await run("shop", [["settle", "settle", acceptance], ["act", "settle"]], { retry: true }));
      assert.deepEqual(again, kept); assert.deepEqual(again.record, settled.record);
      await checkpoint("settled");
      const [emptied, final] = ok(await run("shop", [["sync"], ["act", "settle"]]));
      assert.deepEqual(emptied.holdings, []);
      assert.equal(final.status, "final");
      // C3.8 from a third wallet's view of the public record: settled, never overdue, the published acceptance listed.
      const [, reading] = ok(await run("holder", [["sync"], ["presentation", demand.demand]]));
      assert.equal(reading.ended.by, "settlement"); assert.equal(reading.overdue, undefined); assert.equal(reading.acceptances.length, 1);
      const [backed, burnt] = ok(await run("backer", [["sync"], ["burn", "retire", 3n], ["submit", "retire"]]));
      assert.deepEqual(holdings(backed), [["3", "available"]]);
      assert.equal(burnt.kind, 3);
      await checkpoint("burnt");
      const [, retired] = ok(await run("backer", [["sync"], ["act", "retire"]]));
      assert.equal(retired.status, "final");
      const input = drill.served(await journal.package()), answer = summary(await readPackage(input.package, input.selection,
        { verifier: drill.verifier, venue, reference: drill.reference }));
      assert.equal(answer.supply, "7");
      assert.deepEqual(drill.fresh(input), answer);
    });

    await drill.test("a wallet restored from the seed alone finds its standing demands, settles one and withdraws the other", async () => {
      const [four, five] = ok(await run("holder", [["request", "fund-4", 4n], ["request", "fund-5", 5n]]));
      // Two notes for the seed-only holder of the taken-release case, issued while the service runs.
      const taker = [b(72), b(73)].map(id => prepareExactOutput(takerSeed, domain, id, backing, 2n));
      ok(await run("backer", [["sync"], ...[["4", four, 4n], ["5", five, 5n], ["t0", taker[0], 2n], ["t1", taker[1], 2n]].flatMap(([id, out, value]) =>
        [["issue", `issue-${id}`, { domain, opening: out.opening, cm: out.cm, capsule: out.capsule }, value], ["submit", `issue-${id}`]])]));
      await checkpoint("funded");
      const deadline = venue.witnessedIndex() + 40n;
      const [, held, , other] = ok(await run("holder", [["sync"], ["demand", "four", 4n, deadline], ["submit", "four"],
        ["demand", "five", 5n, deadline], ["submit", "five"]]));
      await checkpoint("demanded-twice");
      const [found, none] = ok(await run("restored", [["sync"], ["act", "four"]], { seedOf: "holder" }));
      assert.equal(none, undefined);
      assert.deepEqual(found.demands.map(d => [hex(d.id), d.quantity]).sort(), [[hex(held.demand), 4n], [hex(other.demand), 5n]].sort());
      assert.deepEqual(holdings(found), [["4", "locked"], ["5", "locked"], ["7", "available"]]);
      const [, acceptance] = ok(await run("backer", [["sync"], ["accept", "answer-4", held.demand, deadline - 10n], ["publishAcceptance", "answer-4"]]));
      const [, settled, , withdrawn] = ok(await run("restored", [["sync"], ["settle", "settle-4", acceptance], ["submit", "settle-4"],
        ["withdraw", "back-5", other.demand], ["submit", "back-5"]]));
      assert.deepEqual([settled.kind, withdrawn.kind], [6, 5]);
      // The lost device, found again, proves the same settlement: one statement, so either copy's admission decides both.
      const [, lost] = ok(await run("holder", [["sync"], ["settle", "lost-4", acceptance]]));
      assert.deepEqual(lost.statement, settled.statement); assert.notDeepEqual(lost.record, settled.record);
      await checkpoint("restored-acts");
      const [after, s, w] = ok(await run("restored", [["sync"], ["act", "settle-4"], ["act", "back-5"]]));
      assert.deepEqual(after.demands, []); assert.deepEqual(holdings(after), [["5", "available"], ["7", "available"]]);
      assert.deepEqual([s.status, w.status], ["final", "final"]);
      const [again, l, d, reading] = ok(await run("holder", [["sync"], ["act", "lost-4"], ["act", "four"], ["presentation", other.demand]]));
      assert.deepEqual(holdings(again), [["5", "available"], ["7", "available"]]);
      assert.deepEqual([l.status, d.status, reading.ended.by, reading.overdue], ["final", "final", "withdrawal", undefined]);
    });

    await drill.test("with the operator offline past silence the holder demands and settles by publication, final by force", async () => {
      const saved = offline = await journal.package(), canonical = venue.witnessedIndex();
      for (const role of ["holder", "backer"]) ok(await run(role, [["sync"]]));
      await new Promise(done => server.close(done)); server = undefined; url = undefined;
      await advance(canonical + SILENCE - lag + 1n - venue.witnessedIndex());
      const [refused] = await run("backer", [["issue", "late", ok(await run("holder", [["request", "late", 1n]]))[0], 1n]]);
      assert.equal(refused.error?.code, "SILENCE");
      const at = venue.witnessedIndex(), deadline = at + 40n;
      const [gap] = ok(await run("holder", [["demand", "gap", 7n, deadline], ["publish", "gap"]]));
      const [locked, forced] = ok(await run("holder", [["sync"], ["act", "gap"]]));
      assert.deepEqual(holdings(locked), [["5", "available"], ["7", "locked"]]);
      assert.equal(forced.status, "final");
      const [, answer] = ok(await run("backer", [["sync"], ["accept", "gap-answer", gap.demand, deadline - 10n]]));
      const [released] = ok(await run("holder", [["settle", "gap-settle", answer], ["publish", "gap-settle"]]));
      assert.equal(released.kind, 6);
      const [emptied, final, reading] = ok(await run("holder", [["sync"], ["act", "gap-settle"], ["presentation", gap.demand]]));
      assert.deepEqual(holdings(emptied), [["5", "available"]]);
      assert.equal(final.status, "final");
      assert.equal(reading.ended.by, "settlement");
      const [burn] = await run("backer", [["burn", "gap-retire", 7n]]);
      assert.equal(burn.error?.code, "SILENCE");
      const input = { package: saved.package, selection: { ...saved.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        ...drill.venueInput() };
      const result = summary(await readPackage(input.package, input.selection, { verifier: drill.verifier, venue, reference: drill.reference }));
      assert.deepEqual(result.force.map(f => f.kind), [4, 6]);
      assert.equal(result.supply, "20");
      assert.deepEqual(drill.fresh(input), result);
    });

    await drill.test("in the gap a release after its acceptance deadline has no force but counts; a timely forged one has none; the next takes a new rho_out", async () => {
      const at = venue.witnessedIndex(), deadline = at + 60n;
      const [demand] = ok(await run("holder", [["demand", "hostile", 5n, deadline], ["publish", "hostile"]]));
      const now = venue.witnessedIndex();
      const [, early] = ok(await run("backer", [["sync"], ["accept", "early", demand.demand, now + lag + 1n]]));
      const [, late] = ok(await run("holder", [["sync"], ["settle", "late", early]]));
      await advance(early.deadline - venue.witnessedIndex());
      ok(await run("holder", [["publish", "late"]]));
      const [, failed] = ok(await run("holder", [["sync"], ["act", "late"]]));
      assert.equal(failed.status, "failed");
      assert.deepEqual(await releases(demand.demand), [[String(output(late)), false, "DEADLINE"]]);
      const [, later] = ok(await run("backer", [["sync"], ["accept", "later", demand.demand, venue.witnessedIndex() + 20n], ["publishAcceptance", "later"]]));
      const [, again] = ok(await run("holder", [["sync"], ["settle", "again", later]]));
      // The late release counted (C3.5): the same nullifiers into a new rho_out, not only a new owner.
      const [l, a] = [late, again].map(act => decodeRecord(act.record).publicInputs);
      assert.deepEqual(a.slice(12, 14), l.slice(12, 14)); assert.notEqual(a[9], l[9]);
      // Witnessed first and in time, a copy with another release signature: its proof verifies, the presenter did not sign it.
      const copy = decodeRecord(again.record), authorization = copy.authorization.slice(); authorization.fill(7, 72);
      await relay(venue.witnessedIndex(), 3, { record: { ...copy, authorization } });
      ok(await run("holder", [["publish", "again"]]));
      const [after, final] = ok(await run("holder", [["sync"], ["act", "again"]]));
      assert.deepEqual([holdings(after), final.status], [[], "final"]);
      assert.deepEqual(await releases(demand.demand), [[String(output(late)), false, "DEADLINE"],
        [String(output(again)), false, "SIGNATURE"], [String(output(again)), true, null]]);
    });

    await drill.test("in the gap a release whose output another demand's settlement created first is TAKEN; past the deadline the backer's dishonour", async () => {
      // The seed-only holder reads its notes and the snapshot from the package the operator served last.
      const read = await readFrontier(offline.package, signed, venue.witnessedIndex(),
        { venue, reference: drill.reference, verifier: drill.verifier, witness: seedWitness(takerSeed, domain) });
      const notes = ownedNotes(takerSeed, domain, backing, read.canonical.state), context = { domain, header: read.canonical.header };
      assert.deepEqual(notes.map(n => n.opening.value), [2n, 2n]);
      const held = notes.map((note, i) => { const input = { note, anchor: note.anchor, path: note.path };
        return [input, { ...input, note: prepareExactOutput(takerSeed, domain, b(80 + i), backing, 0n) }]; });
      const deadline = venue.witnessedIndex() + 40n, demands = [];
      for (const [i, inputs] of held.entries()) {
        const at = venue.witnessedIndex(), record = await drill.prove(demandTask(context, inputs, { backing, quantity: 2n,
          presenter: ed25519.getPublicKey(presenters[i]), instant: at, deadline }), `taker demand ${i}`);
        demands.push(record); await relay(at, 1, { record });
      }
      const ids = demands.map(statementHash);
      // K accepts the first demand and publishes it; the holder proves its release to the acceptance's owner.
      const opening = { backing, value: 2n, owner: ownerOf(deriveSettlementOwnerSecret(b(22), domain, ids[0], deadline - 5n).value), rho: 42n }, cm = commitmentOf(domain, opening);
      const acceptance = authorizeAcceptance({ domain, demand: ids[0], owner: opening.owner, deadline: deadline - 5n }, issuerSecret);
      await relay(venue.witnessedIndex(), 2, { acceptance });
      const release = authorizeSettlement(await drill.prove(settleTask(context, held[0], { opening, cm }, ids[0]), "taken release"),
        acceptance, presenters[0]);
      // Before it is witnessed, a settlement of the second demand under an acceptance K signed naming the same owner
      // creates the same output (owner, rho_out and value) with force.
      const taking = authorizeSettlement(await drill.prove(settleTask(context, held[1], { opening, cm }, ids[1]), "taking settlement"),
        authorizeAcceptance({ domain, demand: ids[1], owner: opening.owner, deadline: deadline - 5n }, issuerSecret), presenters[1]);
      await relay(venue.witnessedIndex(), 3, { record: taking });
      await relay(venue.witnessedIndex(), 3, { record: release });
      assert.deepEqual(await releases(ids[1]), [[String(cm), true, null]]);
      assert.deepEqual(await releases(ids[0]), [[String(cm), false, "TAKEN"]]);
      await advance(deadline + 1n - venue.witnessedIndex());
      const [, taken, settled] = ok(await run("backer", [["sync"], ["presentation", ids[0]], ["presentation", ids[1]]]));
      assert.deepEqual(taken.acceptances.map(a => [a.timely, a.taken]), [[true, true]]);
      assert.deepEqual([taken.ended, taken.overdue?.reading, settled.ended?.by], [undefined, "dishonour", "settlement"]);
      const input = { package: offline.package, selection: { ...offline.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        ...drill.venueInput() };
      const result = summary(await readPackage(input.package, input.selection, { verifier: drill.verifier, venue, reference: drill.reference }));
      assert.deepEqual(result.force.map(f => f.kind), [4, 6, 4, 6, 4, 4, 6]);
      assert.equal(result.supply, "20");
      assert.deepEqual(drill.fresh(input), result);
    });

    drill.report({
      limits: ["the adopted configuration on reference venues only", "single backing", "no live broadcasts",
        "process restarts between operations; abrupt exits inside acts are wallet-crash.mjs's, with stand-in proofs",
        "hostile releases staged in the gap only"],
      checks: drill.checks, proofs: drill.proofs, processes: children, transactions: drill.transactions, maxPackageBytes: Math.max(...drill.packages) });
    completed = true;
  } finally {
    if (server !== undefined) await new Promise(done => server.close(done));
    journal?.close();
    await drill.close(completed);
  }
}

if (process.argv[2] === "--wallet") await walletWorker(process.argv.slice(3));
else if (process.argv[2] === "--worker") await drillWorker(process.argv.slice(3),
  async (input, options) => summary(await readPackage(input.package, input.selection, options)));
else await acceptance(drillMode(process.argv.slice(2), "redemption-store-check"));
