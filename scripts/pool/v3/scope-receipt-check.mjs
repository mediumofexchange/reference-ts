// Bounded C2.10.9b/C2b.4.3 receipt probes, reusing the scope fixtures' proofs.
// The caller determines whether those proofs are an ideal oracle or real proofs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree } from "../../../dist/pool/note-tree.js";
import { fieldToBytes } from "../../../dist/pool/field.js";
import { directoryRoot, encodeReplacement, replacementMessage, ROLE_OPERATOR, signCommitment } from "../../../dist/venue-records.js";
import { RadixSpentSet } from "../../../dist/pool/v3/spent-set.js";
import { LIMITS } from "../delivery/evidence-reader.mjs";
import { replayLocalPackage } from "./local-replay.mjs";

const same = (a, b) => Buffer.compare(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const changed = bytes => { const copy = new Uint8Array(bytes); copy[0] ^= 1; return copy; };
const b = n => new Uint8Array(32).fill(n);

function receiptChecks(codec, verifier, operatorSecret) {
  function fields(cp, position) {
    assert(position > 0n && position <= BigInt(cp.records.length));
    const tree = new NoteTree(), spent = new RadixSpentSet();
    // Imports contribute spent elements even though the local note tree and
    // history restart. Omitting this seed would sign the wrong history hash.
    for (const nf of new Set(cp.importedNullifiers)) spent.insert(fieldToBytes(nf));
    let historyHash = codec.genesisHistoryHash(cp.ctx.id), target;
    for (let i = 0; i < Number(position); i++) {
      const record = cp.records[i], effect = cp.effects[i];
      tree.appendAll(effect.outputs);
      for (const nf of effect.nullifiers) if (!spent.has(fieldToBytes(nf))) spent.insert(fieldToBytes(nf));
      const at = BigInt(i) + 1n;
      historyHash = codec.nextHistoryHash(historyHash, codec.statementHash(record), tree.root(), spent.root(), at);
      target = { position: at, historyHash, ...codec.evidenceHashes(record) };
    }
    const header = codec.decodeSegmentHeader(cp.ctx.header);
    return { domain: header.domain, segment: cp.ctx.id, scopeRoot: cp.ctx.prefix[4], ...target,
      after: cp.commitment.sequence, operator: header.operator };
  }
  const sign = (cp, position, change = {}) => {
    const unsigned = { ...fields(cp, position), ...change };
    return codec.encodeReceipt({ ...unsigned, signature: ed25519.sign(codec.receiptBytes(unsigned), operatorSecret) });
  };
  const withReceipt = (source, receipt) => ({ ...source, package: { ...source.package, receipt } });
  const query = (source, receipt, v = verifier) => replayLocalPackage(withReceipt(source, receipt), v, codec);
  const partialFree = answer => {
    assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false);
  };
  const status = (answer, expected) => {
    assert.equal(answer.status, "receipt-status", JSON.stringify(answer));
    assert.equal(answer.receipt.status, expected, JSON.stringify(answer)); partialFree(answer); return answer.receipt;
  };
  const refusal = answer => {
    assert.equal(answer.status, "unresolved-evidence", JSON.stringify(answer)); partialFree(answer); return answer;
  };
  const missingTerms = (source, backing) => {
    const copy = structuredClone(source);
    const substitute = codec.decodeTrail(copy.package.trail, LIMITS).terms.find(t => !same(codec.rootTermsName(t.terms), backing));
    assert(substitute !== undefined);
    const strip = bytes => {
      const trail = codec.decodeTrail(bytes, LIMITS);
      // The framing requires one slot per scoped backing. Supply unrelated
      // authentic terms in y's slot while withholding y's actual terms.
      return codec.encodeTrail({ ...trail, terms: trail.terms.map(t => same(codec.rootTermsName(t.terms), backing) ? substitute : t) }, LIMITS);
    };
    copy.package.trail = strip(copy.package.trail); copy.package.trails = copy.package.trails.map(strip); return copy;
  };
  return { fields, sign, withReceipt, query, status, refusal, missingTerms };
}

export async function checkNormalScopeReceipts({ codec, verifier, test, operatorSecret, checkpoint, compose, segment, entry,
  x, y, a0, a1, y1, j0, j1, j2, history, payload, payloadY, toB }) {
  const c = receiptChecks(codec, verifier, operatorSecret);
  const original = c.sign(a1, 2n), originalPayload = c.withReceipt(payload, original);
  const joined = c.sign(j2, 2n, { after: j1.commitment.sequence }), joinedPayload = c.withReceipt(payload, joined);
  let result, joinedResult;
  await test("scoped original receipts remain final through split and rejoin for either selected backing", async () => {
    result = await replayLocalPackage(originalPayload, verifier, codec);
    for (const answer of [result, await c.query(payloadY, original)]) {
      const verdict = c.status(answer, "final");
      assert.deepEqual(verdict.includedAt, [{ operator: hex(a1.commitment.operator), sequence: "2", index: "2" }]);
      assert.deepEqual(verdict.contradictedAt, []);
    }
  });
  await test("joined receipt history includes every imported spent element", async () => {
    assert(j2.importedNullifiers.length > 0);
    joinedResult = await replayLocalPackage(joinedPayload, verifier, codec);
    const verdict = c.status(joinedResult, "final");
    assert.deepEqual(verdict.includedAt.map(f => f.sequence), ["7"]);
    assert(same(codec.decodeReceipt(joined).historyHash, codec.decodeSnapshot(j2.snapshots[0]).historyHash));
  });
  await test("all five scoped receipt comparison fields require exact inclusion", async () => {
    const base = c.fields(j2, 2n);
    for (const change of [{ position: 1n }, { statementHash: changed(base.statementHash) },
      { historyHash: changed(base.historyHash) }, { proofHash: changed(base.proofHash) },
      { signatureHash: changed(base.signatureHash) }]) {
      const verdict = c.status(await c.query(payload, c.sign(j2, 2n, change)), "contradicted");
      assert(verdict.contradictedAt.length > 0); assert.deepEqual(verdict.includedAt, []);
    }
  });
  const unfinished = c.sign(a1, 2n, { position: 3n });
  const local = (checkpoints, at = 4n, replacements = []) => compose(checkpoints, a1, x, replacements, at);
  await test("same-index lower-sequence scoped inclusion remains final before the held receipt reference", async () => {
    const later = checkpoint(a1.ctx, 3n, 2n, a1.records, a1.effects);
    const receipt = c.sign(a1, 2n, { after: 3n });
    const verdict = c.status(await c.query(local([a0, a1, later], 2n), receipt), "final");
    assert.deepEqual(verdict.includedAt.map(f => [f.sequence, f.index]), [["2", "2"]]);
  });
  await test("a transition carrying only the unselected original backing abandons the whole receipt", async () => {
    const next = checkpoint(segment(operatorSecret, 3n, [entry(y, y, a1)]), 3n, 3n);
    const verdict = c.status(await c.query(local([a0, a1, next]), unfinished), "abandoned");
    assert.equal(verdict.abandonedAt.sequence, "3"); assert.equal(verdict.lapse, undefined);
  });
  await test("an unselected carrying transition proves repair only with a real missing sequence", async () => {
    const repair = checkpoint(segment(operatorSecret, 4n, [entry(y, y, a1)]), 4n, 4n);
    let verdict = c.status(await c.query(local([a0, a1, repair]), unfinished), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "repair", at: "4" });
    const empty = [], noncarrying = { ...a0, at: 3n, directory: empty, snapshots: [],
      commitment: signCommitment(operatorSecret, 3n, directoryRoot(empty)) };
    verdict = c.status(await c.query(local([a0, a1, noncarrying, repair]), unfinished), "abandoned");
    assert.equal(verdict.lapse, undefined);
    // A repeated statement excludes the checkpoint before its claimed roots
    // can matter; the fixture tree itself does not permit duplicate outputs.
    const excluded = checkpoint(a1.ctx, 3n, 3n, [...a1.records, a1.records[1]], [...a1.effects, { outputs: [], nullifiers: [] }]);
    verdict = c.status(await c.query(local([a0, a1, excluded, repair]), unfinished), "abandoned");
    assert.deepEqual(verdict.includedAt, []); assert.deepEqual(verdict.contradictedAt, []);
  });
  await test("the unselected term end excludes a matching checkpoint exactly at its boundary", async () => {
    const supply = new Map([[hex(x), { issued: 10n, burned: 0n }], [hex(y), { issued: 0n, burned: 0n }]]);
    const partial = checkpoint(a1.ctx, 2n, 2n, a1.records.slice(0, 1), a1.effects.slice(0, 1), { supply });
    const boundary = checkpoint(a1.ctx, 3n, 6n, a1.records, a1.effects);
    const receipt = c.sign(boundary, 2n, { after: 2n });
    const verdict = c.status(await c.query(compose([a0, partial, boundary], partial, y, [toB], 6n), receipt), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "scope-boundary", at: "6" });
    assert.deepEqual(verdict.includedAt, []); assert.deepEqual(verdict.contradictedAt, []);
  });
  await test("unselected opening snapshots, terms and term ranges are required for scoped receipt finality", async () => {
    const missing = structuredClone(originalPayload), snapshot = a0.snapshots.find(s => same(codec.decodeSnapshot(s).backing, y));
    missing.package.snapshots = missing.package.snapshots.filter(s => !same(s, snapshot));
    c.refusal(await replayLocalPackage(missing, verifier, codec));
    c.refusal(await c.query(c.missingTerms(payload, y), original));
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: request => request.kind === 2 && same(request.subject, y) ? undefined : record.range(request) }; } };
    c.refusal(await c.query(payload, original, unavailable));
  });
  await test("a later malformed unselected snapshot preserves earlier scoped contradiction evidence", async () => {
    const bad = checkpoint(a1.ctx, 3n, 3n, a1.records, a1.effects);
    const index = bad.ctx.entries.findIndex(e => same(e.backing, y)), malformed = new Uint8Array([1]);
    bad.snapshots[index] = malformed; bad.directory[index] = { name: y, digest: hash(malformed) };
    bad.commitment = signCommitment(operatorSecret, 3n, directoryRoot(bad.directory));
    for (const after of [2n, 3n]) {
      const receipt = c.sign(a1, 1n, { after, statementHash: changed(c.fields(a1, 1n).statementHash) });
      const answer = c.refusal(await c.query(local([a0, a1, bad]), receipt));
      assert.deepEqual(answer.receiptEvidence.contradictedAt.map(f => f.sequence), ["2"]);
    }
  });
  await test("missing post-final scope evidence cannot erase an original scoped receipt", async () => {
    const missing = structuredClone(originalPayload);
    missing.package.snapshots = missing.package.snapshots.filter(bytes => same(codec.decodeSnapshot(bytes).segment, a1.ctx.id));
    c.status(await replayLocalPackage(missing, verifier, codec), "final");
  });
  await test("a single-backing selection reads an original shared receipt and preserves evidence across scope fallback", async () => {
    const split = compose(history, y1, y, [toB]);
    c.status(await c.query(split, original), "final");
    const missing = compose([...history, j0, j1, j2], y1, y);
    const sibling = j0.snapshots.find(bytes => same(codec.decodeSnapshot(bytes).backing, x));
    missing.package.snapshots = missing.package.snapshots.filter(bytes => !same(bytes, sibling));
    const receipt = c.sign(y1, 1n, { statementHash: changed(c.fields(y1, 1n).statementHash) });
    const answer = c.refusal(await c.query(missing, receipt));
    assert.deepEqual(answer.receiptEvidence.contradictedAt.map(f => f.sequence), ["4"]);
    const verdict = c.status(await c.query(missing, c.sign(y1, 1n)), "final");
    assert.deepEqual(verdict.includedAt.map(f => f.sequence), ["4"]);
  });
  await test("a linear receipt walk preserves its contradiction when a new scope sibling is unavailable", async () => {
    const supply = new Map([[hex(x), { issued: 0n, burned: 0n }], [hex(y), { issued: 0n, burned: 0n }]]);
    const ctx = segment(operatorSecret, 1n, [entry(y)]);
    const z0 = checkpoint(ctx, 1n, 1n, [], [], { supply });
    const z1 = checkpoint(ctx, 2n, 2n, [], [], { supply });
    const next = segment(operatorSecret, 3n, [entry(x), entry(y, y, z1)]);
    const join = checkpoint(next, 3n, 3n, [], [], { supply });
    const receipt = c.sign(a1, 1n, { segment: ctx.id, scopeRoot: ctx.prefix[4], after: 1n, position: 1n });
    const source = compose([z0, z1, join], z1, y, [], 3n);
    const intact = c.status(await c.query(source, receipt), "contradicted");
    assert.deepEqual(intact.contradictedAt.map(f => f.sequence), ["2"]);
    const sibling = join.snapshots.find(bytes => same(codec.decodeSnapshot(bytes).backing, x));
    const missing = structuredClone(source);
    missing.package.snapshots = missing.package.snapshots.filter(bytes => !same(bytes, sibling));
    const answer = c.refusal(await c.query(missing, receipt));
    assert.deepEqual(answer.receiptEvidence.contradictedAt.map(f => f.sequence), ["2"]);
  });
  return { payload: originalPayload, result, joinedPayload, joinedResult };
}

export async function checkRecoveryScopeReceipts({ codec, verifier, test, operatorSecret, checkpoint, compose,
  x, y, a0, a1, adopted, final, j0, ancestry, publications, payload, payloadY }) {
  const c = receiptChecks(codec, verifier, operatorSecret);
  const original = c.sign(a1, 2n), originalPayload = c.withReceipt(payload, original);
  // Position eight is y's adopted settlement, including its exact issuer and
  // presenter authorization bytes, although selection is for x.
  const adoptedReceipt = c.sign(adopted, 8n, { after: j0.commitment.sequence });
  const adoptedPayload = c.withReceipt(payload, adoptedReceipt);
  let result, adoptedResult;
  await test("original two-backing receipt finality survives silence and scoped recovery", async () => {
    result = await replayLocalPackage(originalPayload, verifier, codec);
    for (const answer of [result, await c.query(payloadY, original)]) {
      const verdict = c.status(answer, "final");
      assert.deepEqual(verdict.includedAt.map(f => [f.sequence, f.index]), [["2", "2"]]);
    }
  });
  await test("an adopted scoped receipt commits the adopting position and exact proof and authorization bytes", async () => {
    const receipt = codec.decodeReceipt(adoptedReceipt), evidence = codec.evidenceHashes(adopted.records[7]);
    assert(same(receipt.segment, adopted.ctx.id)); assert.equal(receipt.position, 8n); assert.equal(receipt.after, 7n);
    for (const key of ["statementHash", "proofHash", "signatureHash"]) assert(same(receipt[key], evidence[key]));
    adoptedResult = await replayLocalPackage(adoptedPayload, verifier, codec);
    const verdict = c.status(adoptedResult, "final");
    assert.deepEqual(verdict.includedAt.map(f => [f.sequence, f.index]), [["8", "13"]]);
    for (const key of ["proofHash", "signatureHash"]) {
      const mismatch = c.sign(adopted, 8n, { after: 7n, [key]: changed(evidence[key]) });
      c.status(await c.query(payload, mismatch), "contradicted");
    }
  });
  await test("missing unselected publication range refuses adopted finality but preserves original finality", async () => {
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: request => request.kind === 4 && same(request.subject, y) ? undefined : record.range(request) }; } };
    c.status(await c.query(payload, original, unavailable), "final");
    c.refusal(await c.query(payload, adoptedReceipt, unavailable));
  });
  await test("missing unselected recovery snapshots refuses an adopted receipt without partial state", async () => {
    const missing = structuredClone(adoptedPayload);
    const parent = ancestry.find(cp => cp.commitment.sequence === 6n);
    missing.package.snapshots = missing.package.snapshots.filter(s => !parent.snapshots.some(other => same(s, other)));
    c.refusal(await replayLocalPackage(missing, verifier, codec));
  });
  const unfinished = c.sign(a1, 2n, { position: 3n });
  await test("the scoped silence boundary lapses held and unreached receipts without a later opening", async () => {
    c.status(await c.query(compose([a0, a1], a1, [], y, 6n), unfinished), "pending");
    for (const receipt of [unfinished, c.sign(a1, 2n, { position: 3n, after: 10n })]) {
      const verdict = c.status(await c.query(compose([a0, a1], a1, [], y, 7n), receipt), "lapsed");
      assert.deepEqual(verdict.lapse, { kind: "silence", at: "7" });
    }
  });
  await test("a checkpoint exactly at scoped silence neither includes nor contradicts", async () => {
    // Both valid issuance records first appear exactly at the opening's
    // silence boundary. Matching all receipt fields must not finalize them.
    const matching = checkpoint(a1.ctx, 2n, 6n, a1.records, a1.effects);
    const receipt = c.sign(matching, 2n, { after: 1n });
    let verdict = c.status(await c.query(compose([a0, matching], a0, [], y, 6n), receipt), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "silence", at: "6" });
    assert.deepEqual(verdict.includedAt, []); assert.deepEqual(verdict.contradictedAt, []);
    const boundary = checkpoint(a1.ctx, 3n, 7n, a1.records, a1.effects);
    const mismatch = c.sign(a1, 2n, { position: 3n });
    verdict = c.status(await c.query(compose([a0, a1, boundary], a1, [], y, 7n), mismatch), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "silence", at: "7" });
    assert.deepEqual(verdict.includedAt, []); assert.deepEqual(verdict.contradictedAt, []);
  });
  await test("a held post-silence receipt reference still must belong to its signed segment", async () => {
    const other = { ...ancestry.find(cp => cp.commitment.sequence === 3n), at: 7n };
    const receipt = c.sign(a1, 2n, { position: 3n, after: 3n });
    const answer = await c.query(compose([a0, a1, other], a1, [], y, 7n), receipt);
    assert.equal(answer.status, "invalid-receipt", JSON.stringify(answer));
    assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false);
  });
  await test("an earlier unselected term end wins over scoped silence and preserves original finality", async () => {
    const successor = b(202), rule = b(185);
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(successor), predecessor: x, effective: 5n,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(x, fields);
    const replacement = encodeReplacement(x, { ...fields, signature: ed25519.sign(message, rule),
      successorSignature: ed25519.sign(message, successor) });
    const source = compose([a0, a1], a1, [], y, 7n);
    source.venue.records.push({ kind: 2, subject: x, index: 0n, record: replacement });
    c.status(await c.query(source, original), "final");
    const verdict = c.status(await c.query(source, unfinished), "lapsed");
    assert.deepEqual(verdict.lapse, { kind: "scope-boundary", at: "5" });
  });
  return { payload: originalPayload, result, adoptedPayload, adoptedResult };
}
