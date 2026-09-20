// Fixture-only producer. Hash recurrence uses the existing exact event fields.
import assert from "node:assert/strict";
import { replayLocalPackage } from "./local-replay.mjs";
import { FAULT_LIMITS, boundFaultInputs, faultObserver } from "./fault-evidence.mjs";
import { EncodingError } from "../../../dist/bytes.js";
import { decodeCommitment, directoryRoot, signCommitment } from "../../../dist/commitment.js";
import { createHash } from "node:crypto";
import { EvidenceRefusal, LIMITS } from "../delivery/evidence-reader.mjs";

export function compactFault(snapshotBytes, records, position, codec) {
  const snapshot = codec.decodeSnapshot(snapshotBytes), at = Number(position - 1n);
  let previous = codec.genesisEvidenceHash(snapshot.segment);
  records.slice(0, at).forEach((r, i) => { previous = codec.nextEvidenceHash(previous, codec.evidenceHashes(r), BigInt(i + 1)); });
  const target = records[at];
  return codec.encodeFaultEvidence({ snapshot, position, length: BigInt(records.length), previous,
    statement: codec.statementBytes(target), proof: target.proof, authorization: target.authorization,
    suffix: records.slice(at + 1).map(codec.evidenceHashes) }, FAULT_LIMITS.maxSuffixEntries);
}

// Different sufficient failures can explain the same excluded checkpoint.
// Compare all state/classification evidence while leaving diagnostic precedence free.
export function withoutFaultReasons(result) {
  const copy = structuredClone(result);
  if (copy.audit?.range?.carrying) copy.audit.range.carrying = copy.audit.range.carrying.map(({ check, ...item }) => item);
  return copy;
}

// Same checks run against the real proof verifier and the bounded oracle probe.
export async function checkCompactFault({ payload, complete, fault, codec, verifier, test, operatorSecret }) {
  const withFault = p => ({ ...p, package: { ...p.package, faults: [fault] } });
  let result;
  await test("compact intrinsic proof excludes a withheld target after complete predecessor resolution", async () => {
    const absent = await replayLocalPackage(payload, verifier, codec);
    assert.equal(absent.status, "unresolved-evidence");
    result = await replayLocalPackage(withFault(payload), verifier, codec);
    assert.equal(result.faultEvidence.length, 1);
    assert.equal(result.faultEvidence[0].check, "PROOF");
    assert.equal(result.faultEvidence[0].classification, "not-established");
    const { faultEvidence } = result;
    assert.equal(result.status, "selected-local-replay"); assert.equal(result.spendable, false);
    assert.equal(result.audit.range.carrying.find(c => c.sequence === faultEvidence[0].sequence).check, "PROOF");
    const full = await replayLocalPackage(withFault(complete), verifier, codec);
    assert.equal(full.status, "selected-local-replay");
    assert.equal(full.audit.range.carrying.find(c => c.sequence === faultEvidence[0].sequence).class, "excluded");
    assert.deepEqual(full.faultEvidence, faultEvidence);
    assert.deepEqual(withoutFaultReasons(result), withoutFaultReasons(full));
    const { faultEvidence: ignored, ...without } = full;
    assert.deepEqual(without, await replayLocalPackage(complete, verifier, codec));
  });
  await test("altered compact fields and suffix never attribute a fault or permit descent", async () => {
    const original = codec.decodeFaultEvidence(fault, FAULT_LIMITS.maxSuffixEntries);
    const variants = [];
    for (const key of ["statement", "proof", "authorization", "previous"]) {
      const e = structuredClone(original); e[key][0] ^= 1; variants.push(codec.encodeFaultEvidence(e, FAULT_LIMITS.maxSuffixEntries));
    }
    for (const key of ["backing", "segment", "historyHash", "evidenceHash"]) {
      const e = structuredClone(original); e.snapshot[key][0] ^= 1; variants.push(codec.encodeFaultEvidence(e, FAULT_LIMITS.maxSuffixEntries));
    }
    const suffix = structuredClone(original); suffix.suffix[0].proofHash[0] ^= 1;
    variants.push(codec.encodeFaultEvidence(suffix, FAULT_LIMITS.maxSuffixEntries), fault.subarray(0, fault.length - 1));
    for (const changed of variants) {
      const answer = await replayLocalPackage({ ...payload, package: { ...payload.package, faults: [changed] } }, verifier, codec);
      assert.equal(answer.status, "unresolved-evidence"); assert.equal(answer.faultEvidence, undefined);
    }
  });
  await test("compact verifier exceptions stay visible and non-boolean results are not rejection", async () => {
    const target = codec.decodeFaultEvidence(fault, FAULT_LIMITS.maxSuffixEntries).proof;
    const isTarget = proof => Buffer.compare(target, proof) === 0;
    for (const outcome of [true, undefined, null, 0]) {
      const custom = { ...verifier, verify: (kind, inputs, proof) => isTarget(proof) ? outcome : verifier.verify(kind, inputs, proof) };
      const answer = await replayLocalPackage(withFault(payload), custom, codec);
      assert.equal(answer.status, "unresolved-evidence"); assert.equal(answer.faultEvidence, undefined);
    }
    for (const cause of [new Error("verifier failure"), new EncodingError("verifier encoding"),
      new codec.CodecEncodingError("verifier codec"), new EvidenceRefusal("unresolved-evidence")]) {
      const custom = { ...verifier, verify: (kind, inputs, proof) => {
        if (isTarget(proof)) throw cause;
        return verifier.verify(kind, inputs, proof);
      } };
      await assert.rejects(() => replayLocalPackage(withFault(payload), custom, codec), error => error.cause === cause);
    }
  });
  await test("compact inventory budgets precede ownership copying; duplicates reuse proof verification", async () => {
    for (const faults of [Array(33).fill(fault), [new Uint8Array(new ArrayBuffer(1_048_577), 0, 1)]]) {
      const answer = await replayLocalPackage({ ...payload, package: { ...payload.package, faults } }, verifier, codec);
      assert.equal(answer.status, "resource-refusal"); assert.equal(answer.faultEvidence, undefined);
    }
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    assert.throws(() => boundFaultInputs([shared]), EncodingError);
    const target = codec.decodeFaultEvidence(fault, FAULT_LIMITS.maxSuffixEntries).proof; let calls = 0;
    const custom = { ...verifier, verify: (kind, inputs, proof) => {
      if (Buffer.compare(target, proof) === 0) calls++;
      return verifier.verify(kind, inputs, proof);
    } };
    const answer = await replayLocalPackage({ ...payload, package: { ...payload.package, faults: [fault, fault] } }, custom, codec);
    assert.deepEqual(answer, result); assert.equal(calls, 1);
    const owned = structuredClone(withFault(payload)); let first = true;
    const mutating = { ...verifier, verify: (...args) => {
      if (first) { first = false; owned.package.faults[0].fill(0); }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await replayLocalPackage(owned, mutating, codec), result);
    const accessor = structuredClone(payload); let reads = 0;
    Object.defineProperty(accessor.package, "faults", { enumerable: true, get() {
      reads++; return reads === 1 ? [fault] : [new Uint8Array(new ArrayBuffer(1_048_577), 0, 1)];
    } });
    assert.deepEqual(await replayLocalPackage(accessor, verifier, codec), result);
    assert.equal(reads, 1);
    const hidden = new Uint8Array(new ArrayBuffer(1_048_577), 0, 1);
    Object.defineProperty(hidden.buffer, "byteLength", { value: 1 });
    Object.defineProperty(hidden, "byteLength", { value: 1 });
    assert.throws(() => boundFaultInputs([hidden]), error => error.status === "resource-refusal");
    const iterable = [fault];
    iterable[Symbol.iterator] = function* () { throw new Error("custom iterator must not run"); };
    assert.deepEqual(boundFaultInputs(iterable), [fault]);
    let entryReads = 0;
    const entries = [fault]; Object.defineProperty(entries, "0", { get() { entryReads++; return fault; } });
    assert.deepEqual(boundFaultInputs(entries), [fault]); assert.equal(entryReads, 1);
  });
  await test("compact scope context and authenticated unsupported target bytes never reach the verifier", async () => {
    const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
    const same = (a, b) => Buffer.compare(a, b) === 0;
    const e = codec.decodeFaultEvidence(fault, FAULT_LIMITS.maxSuffixEntries);
    const directory = complete.package.directories.find(d => d.some(entry => same(entry.digest, codec.snapshotDigest(e.snapshot))));
    const commitment = complete.venue.records.filter(r => r.kind === 1).map(r => decodeCommitment(r.record))
      .find(c => same(c.root, directoryRoot(directory)));
    const trail = [complete.package.trail, ...complete.package.trails].map(bytes => codec.decodeTrail(bytes, LIMITS))
      .find(t => same(hash(t.header), e.snapshot.segment));
    const scope = { header: codec.decodeSegmentHeader(trail.header), terms: trail.terms };
    const beforeProof = { ...verifier, verify() { throw new Error("unsupported evidence reached verifier"); } };
    for (const key of ["domain", "venue", "operator", "sequence"]) {
      const changed = structuredClone(scope);
      if (key === "sequence") changed.header.sequence = commitment.sequence + 1n;
      else changed.header[key][0] ^= 1;
      const observer = faultObserver([fault], payload.selection, beforeProof, codec);
      await observer.inspect({ commitment, index: 4n }, directory, changed);
      assert.deepEqual(observer.result(), {});
    }
    // Recommit malformed fields: authentication succeeds, but this bounded
    // reporter makes no malformed-record or proof-shape fault claim.
    for (const variant of ["statement", "short-proof", "empty-proof"]) {
      const changed = structuredClone(e);
      if (variant === "statement") changed.statement[0] ^= 1;
      else changed.proof = new Uint8Array(variant === "short-proof" ? 31 : 0);
      let terminal = codec.nextEvidenceHash(changed.previous,
        codec.hashEvidenceFields(hash(changed.statement), changed.proof, changed.authorization), changed.position);
      changed.suffix.forEach((triple, i) => { terminal = codec.nextEvidenceHash(terminal, triple, changed.position + BigInt(i + 1)); });
      changed.snapshot.evidenceHash = terminal;
      const changedDirectory = [{ name: changed.snapshot.backing, digest: codec.snapshotDigest(changed.snapshot) }];
      const signed = signCommitment(operatorSecret, commitment.sequence, directoryRoot(changedDirectory));
      const bytes = codec.encodeFaultEvidence(changed, FAULT_LIMITS.maxSuffixEntries);
      assert.equal(codec.verifyFaultEvidence({ backing: changed.snapshot.backing, segment: changed.snapshot.segment,
        digest: changedDirectory[0].digest }, changed, FAULT_LIMITS.maxSuffixEntries), true);
      const observer = faultObserver([bytes], payload.selection, beforeProof, codec);
      await observer.inspect({ commitment: signed, index: 4n }, changedDirectory, scope);
      assert.deepEqual(observer.result(), {});
    }
    const over = structuredClone(e); over.length = over.position + 1025n;
    over.suffix = Array(1025).fill(e.suffix[0]);
    const bounded = { ...payload, package: { ...payload.package, faults: [codec.encodeFaultEvidence(over, 1025n)] } };
    const refused = await replayLocalPackage(bounded, beforeProof, codec);
    assert.equal(refused.status, "resource-refusal"); assert.equal(refused.faultEvidence, undefined);
  });
  return { payload: withFault(payload), complete, result, faultBytes: fault.length };
}
