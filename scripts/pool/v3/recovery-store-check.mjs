// Runtime slice-3 acceptance: real holder/backer proofs, journal service,
// disappearance, publication force, return and exact adoption. --ergo uses
// the synthetic mining supplier and actual publisher. Live publication requires
// both --testnet and --authorized-testnet and a pre-submission count/spend guard.
// --worker is a fresh holder-only runtime reader: no journal or private seed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../../../dist/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../../../dist/pool/v3/capsules.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeReceipt } from "../../../dist/pool/v3/commitments.js";
import { decodeEvidencePackage, encodeEvidencePackage } from "../../../dist/pool/v3/package.js";
import { decodeTrail } from "../../../dist/pool/v3/trail.js";
import { V3OperatorJournal } from "../../../dist/pool/v3/store.js";
import { authorizeAcceptance, authorizeIssue, authorizeSettlement, demandTask, issueTask, requestTask, settleTask,
  withdrawalRecord } from "../../../dist/pool/v3/witness.js";
import { encodePublication, encodeRecord, statementHash } from "../../../dist/pool/v3/records.js";
import { v3Codec as codec } from "./codec.mjs";
import { drillMode, drillWorker, openDrill } from "./drill.mjs";
import { publicationBudget } from "./testnet-budget.mjs";

const b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex"), digest = bytes => createHash("sha256").update(bytes).digest("hex");
// Five checkpoints and five recovery publications on either Ergo venue.
const TRANSACTIONS = 10, LIVE_LIMITS = { transactions: TRANSACTIONS, spentNanoErg: 50_000_000n, feeNanoErg: 11_000_000n };
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

async function acceptance(mode) {
  const live = mode === "testnet";
  const drill = await openDrill(mode, { name: "recovery-store", script: import.meta.filename, budget: live ? publicationBudget(LIVE_LIMITS) : undefined });
  const { venue, reference, domain, build, lag, prove, advance } = drill;
  let journal, completed = false;
  try {
    const step = live ? lag : mode === "ergo" ? lag : 1n;
    const publish = () => drill.publish(journal), checkpoint = id => drill.checkpoint(journal, id);
    const issuerSecret = b(15), operatorSecret = b(16), presenterSecret = b(18);
    const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret), silence = 16n;
    const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: live ? 1024n : 80n,
      payout: { thing: "recovery reference units", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: silence, challengeWindow: 5n }, nonService: { duration: 2n, count: 1n, window: live ? 128n : 12n } });
    const backing = codec.rootTermsName(terms), signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const funded = [31, 32].map(id => prepareExactOutput(b(21), domain, b(id), backing, 10n));
    const pads = [33, 34].map(id => prepareExactOutput(b(21), domain, b(id), backing, 0n)), tree = new NoteTree(); tree.appendAll(funded.map(o => o.cm));
    const held = index => { const input = { note: funded[index], anchor: tree.root(), path: tree.path(BigInt(index)) }; return [input, { ...input, note: pads[index] }]; };
    const demand = async (index, instant, deadline, secret, name) => {
      if (live) { await drill.sync(); instant = venue.witnessedIndex(); }
      const result = await prove(demandTask(context, held(index),
        { backing, quantity: 10n, presenter: ed25519.getPublicKey(secret), instant, deadline }), name);
      if (live) {
        await drill.sync();
        assert(venue.witnessedIndex() <= instant + lag, "demand proof aged beyond its publication window; no automatic new publication");
      }
      return result;
    };
    const settlement = async (index, d, deadline, secret, name) => {
      const id = statementHash(d), ownerSecret = deriveSettlementOwnerSecret(b(22), domain, id, deadline).value;
      const opening = { backing, value: 10n, owner: ownerOf(ownerSecret), rho: BigInt(42 + index) }, output = { opening, cm: commitmentOf(domain, opening) };
      return authorizeSettlement(await prove(settleTask(context, held(index), output, id), name),
        authorizeAcceptance({ domain, demand: id, owner: opening.owner, deadline }, issuerSecret), secret);
    };
    journal = new V3OperatorJournal(join(build, "journal.db"), { secret: operatorSecret, venue, reference, verifier: drill.verifier });
    const served = async () => drill.served(await journal.package());
    const read = input => readPackage(input.package, input.selection, { verifier: drill.verifier, venue, reference });
    await drill.test("real-proof issue and service redemption leave outstanding supply unchanged", async () => {
      await journal.open("genesis", signed); await publish();
      for (const [i, output] of funded.entries()) await journal.submit(encodeRecord(authorizeIssue(await prove(issueTask(context, output), `issue ${i}`), issuerSecret)));
      await checkpoint("issued");
      const now = venue.witnessedIndex(), deadline = now + lag + (live ? 128n : 8n);
      const first = await demand(0, now, deadline, presenterSecret, "service demand withdrawn");
      await journal.submit(encodeRecord(first)); await journal.submit(encodeRecord(withdrawalRecord(context, statementHash(first), presenterSecret)));
      const secondSecret = live ? b(23) : presenterSecret;
      const second = await demand(0, now - 1n, deadline, secondSecret, "service demand settled");
      await journal.submit(encodeRecord(second));
      const settled = encodeRecord(await settlement(0, second, live ? deadline - 1n : now + lag, secondSecret,
        live ? "service settlement inside witnessed deadline" : "service settlement at inclusive horizon"));
      await drill.sync();
      const receipt = await journal.submit(settled); assert.deepEqual(await journal.submit(settled), receipt);
      await checkpoint("service-settled");
      const input = await served(), answer = summary(await read(input)); assert.equal(answer.supply, "20");
      assert.deepEqual(drill.fresh(input), answer);
    });
    const canonicalIndex = venue.witnessedIndex();
    const publication = (kind, record) => encodePublication({ domain, backing, kind, record });
    const publishRecovery = (kind, record) => drill.publishRecord(4, backing, publication(kind, record));
    await drill.test("a real segment-free request counts once against canonical holder evidence", async () => {
      const request = await prove(requestTask(domain, held(1)[0], 0n), "unanswered request");
      await publishRecovery(5, request); await advance(2n);
      const input = await served(), result = await read(input);
      assert.equal(result.ranges.nonService.count, "1"); assert.equal(result.ranges.nonService.fires, true);
      assert.deepEqual(drill.fresh(input), summary(result));
    });
    let saved, expectedAdoption;
    await drill.test("silence refuses service and holder-only evidence derives publication force", async () => {
      saved = await served();
      const remaining = canonicalIndex + silence + 1n - venue.witnessedIndex();
      if (remaining > 0n) await advance(remaining);
      await assert.rejects(journal.commit("retired"), error => error.code === "STALE" && error.check === "SILENCE");
      const now = venue.witnessedIndex(), recoveryDeadline = now + (live ? 128n : 30n);
      const first = await demand(1, now + step - lag, recoveryDeadline, presenterSecret, "forced first demand");
      await publishRecovery(1, first);
      const withdrawal = withdrawalRecord(context, statementHash(first), presenterSecret); await publishRecovery(4, withdrawal);
      const second = await demand(1, venue.witnessedIndex() + step - lag, recoveryDeadline + 1n, b(19), "forced second demand");
      await publishRecovery(1, second);
      saved = { ...saved, selection: { ...saved.selection, judgingIndex: venue.witnessedIndex() }, ...drill.venueInput() };
      const forced = await read(saved); assert.deepEqual(forced.force.map(f => f.record.kind), [4, 5, 4]);
      assert.deepEqual(drill.fresh(saved), summary(forced));
      const settled = await settlement(1, second, recoveryDeadline, b(19), live ? "forced settlement before return" : "forced settlement at return index");
      if (live) await publishRecovery(3, settled);
      const opening = await journal.return("return"); assert.deepEqual(await journal.return("return"), opening);
      await assert.rejects(journal.adopt(), error => error.code === "UNAVAILABLE");
      if (live) await publish();
      else {
        await journal.publish();
        if (mode === "ergo") await publishRecovery(3, settled);
        else venue.witness(4, backing, venue.witnessedIndex(), publication(3, settled));
      }
      const expected = [first, withdrawal, second, settled].map(encodeRecord), adopted = await journal.adopt();
      expectedAdoption = expected;
      assert.deepEqual(adopted.map(bytes => decodeReceipt(bytes).statementHash), [first, withdrawal, second, settled].map(statementHash));
      assert.deepEqual(await journal.adopt(), adopted);
      await checkpoint("adopted");
    });
    let final, finalInput;
    await drill.test("fresh runtime reader verifies exact adoption and refuses missing ancestry", async () => {
      const input = await served(), result = await read(input); final = summary(result); finalInput = input;
      assert.equal(final.supply, "20"); assert.equal(final.position, "4");
      assert(result.state.hasNullifier(funded[1].nf)); assert.deepEqual(drill.fresh(input), final);
      const items = decodeEvidencePackage(input.package);
      assert(items.filter(item => item.kind === 6).some(item => {
        const records = decodeTrail(item.payload).records;
        return records.length === expectedAdoption.length && records.every((bytes, i) => hex(bytes) === hex(expectedAdoption[i]));
      }), "the return segment carries the exact adopted proof and signature bytes in venue order");
      for (const kind of [3, 4, 6]) await assert.rejects(read({ ...input,
        package: encodeEvidencePackage(items.filter(item => item.kind !== kind)) }), error => error.status === "unresolved-evidence");
    });
    if (mode === "ergo") assert.equal(drill.transactions.length, TRANSACTIONS, "five checkpoints and five recovery publications");
    const funding = await drill.funding();
    if (live) assert.equal(funding.transactions.length, TRANSACTIONS);
    const reader = live ? drill.keepReader("pool-v3-recovery-testnet-reader", { input: finalInput }, final) : undefined;
    drill.report({
      limits: ["the adopted configuration on reference venues only", "single backing", live ? "live testnet only; same-index return covered synthetically" : "no live broadcasts", "no persistence or adoption claim"],
      checks: drill.checks, proofs: drill.proofs, transactions: drill.transactions, ...(funding === undefined ? {} : { funding }),
      maxPackageBytes: Math.max(...drill.packages), final, ...(reader === undefined ? {} : { reader }) });
    completed = true;
  } finally {
    journal?.close();
    await drill.close(completed);
  }
}

if (process.argv[2] === "--worker") await drillWorker(process.argv.slice(3),
  async (input, options) => summary(await readPackage(input.package, input.selection, options)), { testnet: true });
else await acceptance(drillMode(process.argv.slice(2), "recovery-store-check", { testnet: true }));
