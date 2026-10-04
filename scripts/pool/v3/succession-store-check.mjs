// Single-backing runtime succession acceptance with actual holder proofs.
// --ergo uses the actual publisher and a synthetic mining supplier. No live mode.
// --worker independently reconstructs the venue and reads public evidence only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { directoryRoot, encodeCommitment, encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR,
  signCommitment, encodeRevocation, signRevocation } from "../../../dist/venue-records.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodeReceipt, decodeSnapshot, snapshotBytes, snapshotDigest } from "../../../dist/pool/v3/commitments.js";
import { decodeEvidencePackage, encodeEvidencePackage, encodeEvidenceDirectory } from "../../../dist/pool/v3/package.js";
import { decodeSegmentHeader } from "../../../dist/pool/v3/headers.js";
import { decodeTrail } from "../../../dist/pool/v3/trail.js";
import { V3OperatorJournal, V3StoreError } from "../../../dist/pool/v3/store.js";
import { authorizeIssue, issueTask, spendTask } from "../../../dist/pool/v3/witness.js";
import { encodeRecord } from "../../../dist/pool/v3/records.js";
import { v3Codec as codec } from "./codec.mjs";
import { drillMode, drillWorker, openDrill } from "./drill.mjs";

const b = n => new Uint8Array(32).fill(n);
const hex = bytes => Buffer.from(bytes).toString("hex"), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const summary = result => {
  assert(result.state !== undefined);
  return { supply: String(result.state.issued - result.state.burned), position: String(result.state.position),
    spentRoot: hex(result.state.spentRoot()), history: hex(result.state.history),
    canonical: { operator: hex(result.canonical.commitment.operator), sequence: String(result.canonical.commitment.sequence),
      index: String(result.canonical.index) }, carrying: result.carrying };
};

async function acceptance(mode) {
  const drill = await openDrill(mode, { name: "succession-store", script: import.meta.filename });
  const { venue, reference, domain, build, lag, prove, publishRecord, publish, checkpoint, advance } = drill;
  const refusal = (action, code, check) => assert.rejects(action, error => error instanceof V3StoreError && error.code === code &&
    (check === undefined || error.check === check));
  const journals = []; let completed = false;
  try {
    const issuerSecret = b(15), aSecret = b(16), bSecret = b(18), ruleSecret = b(19);
    const issuer = ed25519.getPublicKey(issuerSecret), aKey = ed25519.getPublicKey(aSecret), bKey = ed25519.getPublicKey(bSecret);
    const terms = codec.encodeRootTerms({ obligor: issuer, operator: aKey, configuration: domain, venue: venue.id, interval: 80n,
      payout: { thing: "succession reference units", quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(ruleSecret) });
    const backing = codec.rootTermsName(terms), signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
    const create = (name, secret) => { const journal = new V3OperatorJournal(join(build, `${name}.db`),
      { secret, venue, reference, verifier: drill.verifier }); journals.push(journal); return journal; };
    const a = create("a", aSecret), successor = create("b", bSecret);
    const served = async journal => drill.served(await journal.package());
    const read = input => readPackage(input.package, input.selection, { verifier: drill.verifier, venue, reference,
      witness: () => ({ nf: 0n, note: new Uint8Array() }) });
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
    await drill.test("A issues with a real proof and a fresh public reader verifies supply", async () => {
      await a.open("genesis", signed); await publish(a);
      const context = { domain, header: { domain, venue: venue.id, operator: aKey, sequence: 1n, entries: [{ backing, link: backing }] } };
      await a.submit(encodeRecord(authorizeIssue(await prove(issueTask(context, funded), "A issue 10"), issuerSecret)));
      await checkpoint(a, "issued"); publicA = await served(a);
      const result = await read(publicA); assert.equal(result.state.issued, 10n); assert.deepEqual(drill.fresh(publicA), summary(result));
    });
    await drill.test("unauthorized and pending takeover refuse; incumbent-self replacement cancels handover", async () => {
      await refusal(successor.takeover("not-appointed", signed, publicA.package), "STALE");
      await replace(bSecret, backing);
      await refusal(successor.takeover("pending", signed, publicA.package), "STALE");
      const cancel = await replace(aSecret, backing); await force(cancel);
      await refusal(successor.takeover("cancelled", signed, publicA.package), "STALE");
      await checkpoint(a, "after-cancellation"); publicA = await served(a);
    });
    let toB;
    await drill.test("B takes over only at force from complete public ancestry and witnesses before service", async () => {
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
      assert.deepEqual(drill.fresh(publicB), summary(await read(publicB)));
    });
    await drill.test("B spends the inherited note with a real proof and preserves A's finality", async () => {
      const result = await read(publicB), placed = result.state.path(funded.cm);
      assert(placed !== undefined); assert.equal(placed.anchor, tree.root());
      assert.deepEqual(placed.path, input.path);
      const context = contextOf(publicB), paid = outputs(b(22), 40, [7n, 3n, 0n, 0n]);
      const receipt = await successor.submit(encodeRecord(await prove(spendTask(context, inputs, paid), "B inherited spend")));
      assert.equal(decodeReceipt(receipt).after, 1n);
      await checkpoint(successor, "spent"); publicB = await served(successor);
      const state = await read(publicB); assert(state.state.hasNullifier(funded.nf)); assert.equal(state.state.issued, 10n);
      assert.deepEqual(drill.fresh(publicB), summary(state));
      assert(state.carrying.filter(item => item.operator === hex(aKey)).every(item => item.class === "valid"));
    });
    await drill.test("A reappointment imports B's state and keeps A's own counter and imported replay protection", async () => {
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
      assert.equal(final.supply, "10"); assert.equal(final.position, "0"); assert.deepEqual(drill.fresh(finalInput), final);
    });
    await drill.test("an authentic hostile checkpoint is excluded only with complete authenticated evidence", async () => {
      const items = decodeEvidencePackage(finalInput.package), state = await read(finalInput);
      const original = items.filter(item => item.kind === 4).map(item => decodeSnapshot(item.payload)).find(snapshot => hex(snapshot.segment) === hex(state.canonical.segment));
      assert(original !== undefined);
      const invalid = { ...original, issued: original.issued + 1n }, directory = [{ name: backing, digest: snapshotDigest(invalid) }];
      const hostile = signCommitment(aSecret, finalInput.selection.sequence + 1n, directoryRoot(directory));
      await publishRecord(1, aKey, encodeCommitment(hostile));
      const extra = [{ kind: 3, payload: encodeEvidenceDirectory(directory) }, { kind: 4, payload: snapshotBytes(invalid) }];
      const all = [...items, ...extra].sort((left, right) => left.kind - right.kind || hash(left.payload).localeCompare(hash(right.payload)));
      const evidence = { ...finalInput, package: encodeEvidencePackage(all),
        selection: { ...finalInput.selection, judgingIndex: venue.witnessedIndex() }, ...drill.venueInput() };
      const answer = await read(evidence); assert.equal(answer.carrying.at(-1).class, "excluded"); assert.equal(answer.carrying.at(-1).check, "SNAPSHOT");
      assert.equal(answer.state.issued, 10n); assert.deepEqual(drill.fresh(evidence), summary(answer));
      const inherited = all.find(item => item.kind === 6 && hex(decodeSegmentHeader(decodeTrail(item.payload).header).operator) === hex(bKey));
      assert(inherited !== undefined);
      await assert.rejects(read({ ...evidence, package: encodeEvidencePackage(all.filter(item => item !== inherited)) }),
        error => error.status === "unresolved-evidence");
      drill.packages.push(evidence.package.length); final = summary(answer);
    });
    if (mode === "ergo") assert.equal(drill.transactions.length, 13);
    const funding = await drill.funding();
    drill.report({
      limits: ["the adopted configuration on reference venues only", "single backing", "no live broadcasts", "no persistence claim", "empty recovery block; forced recovery acceptance is separate"],
      checks: drill.checks, proofs: drill.proofs, transactions: drill.transactions, ...(funding === undefined ? {} : { funding }),
      maxPackageBytes: Math.max(...drill.packages), final });
    completed = true;
  } finally {
    for (const journal of journals) journal.close();
    await drill.close(completed);
  }
}

if (process.argv[2] === "--worker") await drillWorker(process.argv.slice(3),
  async (input, options) => summary(await readPackage(input.package, input.selection, options)));
else await acceptance(drillMode(process.argv.slice(2), "succession-store-check"));
