// Slice 9 M9d1 acceptance: redemption through the wallet with real proofs. The operator's journal serves wallets
// over its HTTP service; each wallet operation runs in a fresh process that opens its wallet database, proves with
// its own prover and syncs its kept evidence from the service: issue, payment and fulfillment, then a demand, the
// backer's acceptance (published, C3.4), the settlement and a burn under service, each act but the burn retried
// exactly in another process without evidence, prover or signer. With the operator offline past the terms' silence
// (a gap, C2b.3.2) the holder demands and settles by publication and reads both final by force; a holder-only reader
// confirms supply and force in a fresh process. --ergo uses the synthetic mining supplier and actual publisher.
// Not covered here (M9d2): abrupt exits inside redemption acts, seed-restored demands, hostile C3.4–C3.8 cases.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { ed25519 } from "@noble/curves/ed25519.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
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
    wallet = new V3Wallet(join(directory, `${input.role}.db`), { venue, reference, verifier: prover.verifier });
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
    const run = async (role, steps, { retry = false } = {}) => {
      drill.writeReaderInputs(build);
      const read = venue.witnessedIndex();
      const input = { role, steps, retry, signed: { backing, signed }, ...drill.venueInput(),
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

    await drill.test("with the operator offline past silence the holder demands and settles by publication, final by force", async () => {
      const saved = await journal.package(), canonical = venue.witnessedIndex();
      for (const role of ["holder", "backer"]) ok(await run(role, [["sync"]]));
      await new Promise(done => server.close(done)); server = undefined; url = undefined;
      await advance(canonical + SILENCE - lag + 1n - venue.witnessedIndex());
      const [refused] = await run("backer", [["issue", "late", ok(await run("holder", [["request", "late", 1n]]))[0], 1n]]);
      assert.equal(refused.error?.code, "SILENCE");
      const at = venue.witnessedIndex(), deadline = at + 40n;
      const [gap] = ok(await run("holder", [["demand", "gap", 7n, deadline], ["publish", "gap"]]));
      const [locked, forced] = ok(await run("holder", [["sync"], ["act", "gap"]]));
      assert.deepEqual(holdings(locked), [["7", "locked"]]);
      assert.equal(forced.status, "final");
      const [, answer] = ok(await run("backer", [["sync"], ["accept", "gap-answer", gap.demand, deadline - 10n]]));
      const [released] = ok(await run("holder", [["settle", "gap-settle", answer], ["publish", "gap-settle"]]));
      assert.equal(released.kind, 6);
      const [emptied, final, reading] = ok(await run("holder", [["sync"], ["act", "gap-settle"], ["presentation", gap.demand]]));
      assert.deepEqual(emptied.holdings, []);
      assert.equal(final.status, "final");
      assert.equal(reading.ended.by, "settlement");
      const [burn] = await run("backer", [["burn", "gap-retire", 7n]]);
      assert.equal(burn.error?.code, "SILENCE");
      const input = { package: saved.package, selection: { ...saved.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        ...drill.venueInput() };
      const result = summary(await readPackage(input.package, input.selection, { verifier: drill.verifier, venue, reference: drill.reference }));
      assert.deepEqual(result.force.map(f => f.kind), [4, 6]);
      assert.equal(result.supply, "7");
      assert.deepEqual(drill.fresh(input), result);
    });

    drill.report({
      limits: ["the adopted configuration on reference venues only", "single backing", "no live broadcasts",
        "process restarts between operations, not abrupt exits inside them (M9d2)", "no seed-restored or hostile redemption cases (M9d2)"],
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
