// Bounded hostile C2.10.9a-c / C2b.4.3 receipt checks over the recovery fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { fieldToBytes } from "../../../dist/pool/field.js";
import { signCommitment, directoryRoot } from "../../../dist/commitment.js";
import { encodeReplacement, replacementMessage, ROLE_OPERATOR } from "../../../dist/replacement.js";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage } from "./local-replay.mjs";

const same = (a, b) => Buffer.compare(a, b) === 0;
const b = n => new Uint8Array(32).fill(n);
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");
const changed = bytes => { const copy = new Uint8Array(bytes); copy[0] ^= 1; return copy; };

export async function checkReceipts({ codec, verifier, test, compose, checkpoint, segment, reference, operatorSecret,
  original, originalOpening, originalState, issuance, funded, returnOpening, returned, adopted, finalCheckpoint,
  ancestry, publications, payload, adoptedRecords, adoptedEffects, finalRecords, finalEffects }) {
  const effectOf = (effects, i) => effects[i] ?? { outputs: [], nullifiers: [] };
  function receiptFields(cp, position) {
    assert(position > 0n && position <= BigInt(cp.records.length));
    const tree = new NoteTree(), spent = new RadixSpentSet();
    let history = codec.genesisHistoryHash(cp.ctx.id), target;
    for (let i = 0; i < Number(position); i++) {
      const record = cp.records[i], effect = effectOf(cp.effects, i);
      tree.appendAll(effect.outputs);
      for (const nf of effect.nullifiers) if (!spent.has(fieldToBytes(nf))) spent.insert(fieldToBytes(nf));
      const at = BigInt(i) + 1n;
      history = codec.nextHistoryHash(history, codec.statementHash(record), tree.root(), spent.root(), at);
      if (at === position) target = { position: at, statementHash: codec.statementHash(record), historyHash: history,
        ...codec.evidenceHashes(record) };
    }
    const header = codec.decodeSegmentHeader(cp.ctx.header);
    return { domain: header.domain, segment: cp.ctx.id, scopeRoot: cp.ctx.scope.root(), ...target,
      after: cp.sequence, operator: header.operator };
  }
  function signedReceipt(cp, position, change = {}) {
    const fields = { ...receiptFields(cp, position), ...change };
    const receipt = { ...fields, signature: ed25519.sign(codec.receiptBytes(fields), operatorSecret) };
    return { receipt, bytes: codec.encodeReceipt(receipt) };
  }
  const withReceipt = (source, bytes) => ({ ...source, package: { ...source.package, receipt: bytes } });
  const query = (source, receipt) => replayLocalPackage(withReceipt(source, receipt.bytes ?? receipt), verifier, codec);
  const partialFree = answer => {
    assert.equal(answer.audit, null);
    assert.deepEqual(answer.candidates, []);
    assert.equal(answer.spendable, false);
  };
  const receiptStatus = (answer, status) => {
    assert.equal(answer.status, "receipt-status");
    assert.equal(answer.receipt.status, status);
    partialFree(answer);
    return answer.receipt;
  };
  const refusal = (answer, status) => {
    assert.equal(answer.status, status);
    partialFree(answer);
  };
  const removeBytes = (values, bytes) => values.filter(value => !same(value, bytes));

  const originalReceipt = signedReceipt(originalState, 1n);
  const originalPayload = withReceipt(payload, originalReceipt.bytes);
  let result;
  await test("an original receipt's final inclusion survives silence, return and later service", async () => {
    result = await replayLocalPackage(originalPayload, verifier, codec);
    const verdict = receiptStatus(result, "final");
    assert.deepEqual(verdict.includedAt, [{ operator: hex(originalState.commitment.operator), sequence: "2", index: "2" }]);
    assert.deepEqual(verdict.contradictedAt, []);
  });

  const adoptedReceipt = signedReceipt(adopted, 1n, { after: returnOpening.sequence });
  const adoptedPayload = withReceipt(payload, adoptedReceipt.bytes);
  let adoptedResult;
  await test("an adopted receipt uses the adopting segment and the publication's exact evidence", async () => {
    const decoded = codec.decodeReceipt(adoptedReceipt.bytes), source = codec.evidenceHashes(adoptedRecords[0]);
    assert(same(decoded.segment, returned.id));
    assert.equal(decoded.position, 1n);
    assert.equal(decoded.after, returnOpening.sequence);
    for (const field of ["statementHash", "proofHash", "signatureHash"]) assert(same(decoded[field], source[field]));
    adoptedResult = await replayLocalPackage(adoptedPayload, verifier, codec);
    const verdict = receiptStatus(adoptedResult, "final");
    assert.deepEqual(verdict.includedAt, [{ operator: hex(adopted.commitment.operator), sequence: "4", index: "12" }]);
  });

  await test("all five receipt comparison fields contradict at an occupied position", async () => {
    const base = receiptFields(finalCheckpoint, 5n);
    const variants = [
      { position: 4n },
      { statementHash: changed(base.statementHash) },
      { historyHash: changed(base.historyHash) },
      { proofHash: changed(base.proofHash) },
      { signatureHash: changed(base.signatureHash) },
    ];
    for (const variant of variants) {
      const answer = await query(payload, signedReceipt(finalCheckpoint, 5n, variant));
      const verdict = receiptStatus(answer, "contradicted");
      assert(verdict.contradictedAt.length > 0);
      assert.deepEqual(verdict.includedAt, []);
    }
  });

  await test("a bad receipt signature or segment context refuses without partial state", async () => {
    const badSignature = structuredClone(originalReceipt.receipt); badSignature.signature[0] ^= 1;
    refusal(await query(payload, codec.encodeReceipt(badSignature)), "invalid-receipt");
    for (const variant of [{ domain: changed(originalReceipt.receipt.domain) },
      { scopeRoot: originalReceipt.receipt.scopeRoot + 1n }, { operator: changed(originalReceipt.receipt.operator) }]) {
      refusal(await query(payload, signedReceipt(originalState, 1n, variant)), "invalid-receipt");
    }
  });

  // This validly signed receipt names an unfinished second position. Its held
  // reference is the index-2 checkpoint, whose first position is all that the
  // operator had committed when it issued the receipt.
  const unfinished = signedReceipt(originalState, 1n, { position: 2n });
  await test("later inclusion wins while retaining an earlier omission contradiction", async () => {
    const effects = [{ outputs: [funded.cm], nullifiers: [] }, { outputs: [], nullifiers: [] }];
    const omitted = checkpoint(original, 3n, 3n, [issuance], effects.slice(0, 1), 10n);
    const included = checkpoint(original, 4n, 4n, [issuance, adoptedRecords[0]], effects, 10n);
    const accepted = signedReceipt(included, 2n, { after: originalState.sequence });
    const verdict = receiptStatus(await query(compose([originalOpening, originalState, omitted, included], included, [], 4n), accepted), "final");
    assert.deepEqual(verdict.includedAt.map(fact => fact.sequence), ["4"]);
    assert.deepEqual(verdict.contradictedAt.map(fact => fact.sequence), ["3"]);
  });
  await test("an unfinished held receipt is pending before, and lapses exactly at, the index-7 silence boundary", async () => {
    const before = compose([originalOpening, originalState], originalState, [], 6n);
    let verdict = receiptStatus(await query(before, unfinished), "pending");
    assert.equal(verdict.sequence, "held");
    const boundary = compose([originalOpening, originalState], originalState, [], 7n);
    verdict = receiptStatus(await query(boundary, unfinished), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "silence", at: "7" });
    verdict = receiptStatus(await query(payload, unfinished), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "silence", at: "7" });
  });

  await test("an unreached receipt also lapses at the proven silence boundary", async () => {
    const unreached = signedReceipt(originalState, 1n, { position: 2n, after: 6n });
    const verdict = receiptStatus(await query(payload, unreached), "lapsed");
    assert.equal(verdict.sequence, "not-reached");
    assert.deepEqual(verdict.lapse, { kind: "silence", at: "7" });
  });

  await test("a held receipt naming a checkpoint at the boundary still lapses, while a reference in another segment is invalid", async () => {
    const atBoundary = checkpoint(original, 3n, 7n, [issuance], [{ outputs: [funded.cm], nullifiers: [] }], 10n);
    const heldAfter = signedReceipt(originalState, 1n, { position: 2n, after: 3n });
    const boundary = compose([originalOpening, originalState, atBoundary], originalState, [], 7n);
    let verdict = receiptStatus(await query(boundary, heldAfter), "lapsed");
    assert.equal(verdict.sequence, "held");
    assert.deepEqual(verdict.lapse, { kind: "silence", at: "7" });

    const foreignAfter = signedReceipt(originalState, 1n, { position: 2n, after: returnOpening.sequence });
    const answer = await query(payload, foreignAfter);
    refusal(answer, "invalid-receipt");
  });

  await test("moving past an unwitnessed receipt reference lapses it without treating omission as contradiction", async () => {
    const skipped = checkpoint(original, 3n, 2n, [issuance], [{ outputs: [funded.cm], nullifiers: [] }], 10n);
    const movedPast = compose([originalOpening, skipped], skipped, [], 2n);
    const verdict = receiptStatus(await query(movedPast, unfinished), "lapsed");
    assert.equal(verdict.sequence, "moved-past");
    assert.deepEqual(verdict.lapse, { kind: "moved-past" });
    assert.deepEqual(verdict.contradictedAt, []);
  });

  await test("an earlier contradiction and carrying abandonment take precedence over later silence", async () => {
    const mismatch = signedReceipt(originalState, 1n, { statementHash: changed(receiptFields(originalState, 1n).statementHash) });
    let verdict = receiptStatus(await query(payload, mismatch), "contradicted");
    assert(verdict.contradictedAt.length > 0);
    const earlyReturn = { ...returnOpening, at: 5n };
    const earlyPayload = compose([originalOpening, originalState, earlyReturn], earlyReturn, [], 13n);
    verdict = receiptStatus(await query(earlyPayload, unfinished), "abandoned");
    assert.equal(verdict.abandonedAt.index, "5");
    assert.equal(verdict.lapse, undefined);
  });

  await test("a term end before silence lapses only the unfinished tail and preserves old finality", async () => {
    const backing = originalState.directory[0].name, ruleSecret = b(147), successorSecret = b(202);
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(successorSecret), predecessor: backing, effective: 5n,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(backing, fields);
    const replacement = encodeReplacement(backing, { ...fields, signature: ed25519.sign(message, ruleSecret),
      successorSignature: ed25519.sign(message, successorSecret) });
    const replaced = compose([originalOpening, originalState], originalState, [], 6n);
    // C2.5's admission floor is witnessing + 2 * lag + 1 = 5.
    replaced.venue.records.push({ kind: 2, subject: backing, index: 0n, record: replacement });
    receiptStatus(await query(replaced, originalReceipt), "final");
    const verdict = receiptStatus(await query(replaced, unfinished), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "scope-boundary", at: "5" });
  });

  await test("a real missing sequence proves repair, while an occupied sequence does not", async () => {
    const repairContext = segment(4n, reference(originalState));
    const repair = checkpoint(repairContext, 4n, 5n, [], [], 10n);
    let verdict = receiptStatus(await query(compose([originalOpening, originalState, repair], repair, [], 5n), unfinished), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "repair", at: "5" });

    const occupied = checkpoint(original, 3n, 4n, [issuance], [{ outputs: [funded.cm], nullifiers: [] }], 10n);
    verdict = receiptStatus(await query(compose([originalOpening, originalState, occupied, repair], repair, [], 5n), unfinished), "contradicted");
    assert(verdict.contradictedAt.some(fact => fact.sequence === "3"));

    const emptyDirectory = [], noncarrying = { ...originalOpening, sequence: 3n, at: 4n, directory: emptyDirectory,
      commitment: signCommitment(operatorSecret, 3n, directoryRoot(emptyDirectory)) };
    verdict = receiptStatus(await query(compose([originalOpening, originalState, noncarrying, repair], repair, [], 5n), unfinished), "abandoned");
    assert.equal(verdict.lapse, undefined);
  });

  await test("an excluded checkpoint neither finalizes a matching receipt nor creates a repair hole", async () => {
    const effects = [{ outputs: [funded.cm], nullifiers: [] }, { outputs: [], nullifiers: [] }, { outputs: [], nullifiers: [] }];
    // The second event is valid and exactly matches the receipt. Repeating it
    // at the third position excludes the whole checkpoint.
    const excluded = checkpoint(original, 3n, 4n, [issuance, adoptedRecords[0], adoptedRecords[0]], effects, 10n);
    const direct = await replayLocalPackage(compose([originalOpening, originalState, excluded], excluded, [], 4n), verifier, codec);
    assert.equal(direct.status, "invalid-local-replay");
    assert.equal(direct.check, "REPEATED_STATEMENT");
    partialFree(direct);
    const excludedReceipt = signedReceipt(excluded, 2n, { after: 2n });
    let verdict = receiptStatus(await query(compose([originalOpening, originalState, excluded], originalState, [], 4n), excludedReceipt), "pending");
    assert.deepEqual(verdict.includedAt, []);
    const repairContext = segment(4n, reference(originalState));
    const repair = checkpoint(repairContext, 4n, 5n, [], [], 10n);
    verdict = receiptStatus(await query(compose([originalOpening, originalState, excluded, repair], repair, [], 5n), excludedReceipt), "abandoned");
    assert.equal(verdict.lapse, undefined);
    assert.deepEqual(verdict.includedAt, []);
  });

  await test("withheld earlier evidence refuses, while missing later evidence cannot erase finality", async () => {
    const earlierMissing = structuredClone(originalPayload);
    earlierMissing.package.snapshots = removeBytes(earlierMissing.package.snapshots, originalOpening.snapshot);
    refusal(await replayLocalPackage(earlierMissing, verifier, codec), "unresolved-evidence");

    const laterMissing = structuredClone(originalPayload);
    laterMissing.package.snapshots = removeBytes(laterMissing.package.snapshots, returnOpening.snapshot);
    const verdict = receiptStatus(await replayLocalPackage(laterMissing, verifier, codec), "final");
    assert.deepEqual(verdict.includedAt, [{ operator: hex(originalState.commitment.operator), sequence: "2", index: "2" }]);
  });

  await test("a later malformed authenticated snapshot preserves an already established contradiction", async () => {
    const badSnapshot = new Uint8Array([1]), badDirectory = [{ name: originalState.directory[0].name, digest: hash(badSnapshot) }];
    const malformed = { ...checkpoint(original, 3n, 3n, [issuance], [{ outputs: [funded.cm], nullifiers: [] }], 10n),
      snapshot: badSnapshot, directory: badDirectory,
      commitment: signCommitment(operatorSecret, 3n, directoryRoot(badDirectory)) };
    const mismatch = signedReceipt(originalState, 1n, { statementHash: changed(receiptFields(originalState, 1n).statementHash) });
    const hostile = compose([originalOpening, originalState, malformed], originalState, [], 3n);
    const answer = await query(hostile, mismatch);
    refusal(answer, "unresolved-evidence");
    assert(answer.receiptEvidence.contradictedAt.length > 0);
    assert.equal(answer.receiptEvidence.contradictedAt[0].sequence, "2");
  });

  await test("original finality needs no publication range, while adopted finality refuses without it", async () => {
    const unavailable = { ...verifier, record: data => {
      const record = verifier.record(data);
      return { ...record, range: request => request.kind === 4 ? undefined : record.range(request) };
    } };
    receiptStatus(await replayLocalPackage(originalPayload, unavailable, codec), "final");
    refusal(await replayLocalPackage(adoptedPayload, unavailable, codec), "unresolved-evidence");
  });

  return { payload: originalPayload, result, adoptedPayload, adoptedResult };
}
