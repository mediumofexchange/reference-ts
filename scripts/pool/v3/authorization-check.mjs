// Signature fixtures use real Ed25519; proof generation is supplied by the harness.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeCommitment, directoryRoot, encodeCommitment, signCommitment } from "../../../dist/venue-records.js";
import { replayLocalPackage } from "./local-replay.mjs";
import { FAULT_LIMITS } from "./fault-evidence.mjs";
import { limbsOf } from "../../../dist/pool/field.js";
import { withoutFaultReasons } from "./fault-check.mjs";

const same = (a, b) => Buffer.compare(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const signatures = result => (result.faultEvidence ?? []).filter(f => f.check === "SIGNATURE");

// Re-sign the checkpoint's exact changed raw evidence. This allows testing
// malformed proof bytes without repairing them through the strict record codec.
function recommit(input, change, codec, operatorSecret) {
  const copy = structuredClone(input), p = copy.package;
  const e = structuredClone(codec.decodeFaultEvidence(p.faults[0], FAULT_LIMITS.maxSuffixEntries));
  const oldDigest = codec.snapshotDigest(e.snapshot);
  change(e);
  let terminal = codec.nextEvidenceHash(e.previous, codec.hashEvidenceFields(hash(e.statement), e.proof, e.authorization), e.position);
  e.suffix.forEach((triple, i) => { terminal = codec.nextEvidenceHash(terminal, triple, e.position + BigInt(i + 1)); });
  e.snapshot.evidenceHash = terminal;
  const changedSnapshot = codec.snapshotBytes(e.snapshot), digest = codec.snapshotDigest(e.snapshot);
  const directory = p.directories.find(d => d.some(entry => same(entry.digest, oldDigest)));
  assert(directory, "fixture target must be a dependency");
  const root = directoryRoot(directory);
  directory.find(entry => same(entry.digest, oldDigest)).digest = digest;
  p.snapshots = p.snapshots.map(bytes => same(hash(bytes), oldDigest) ? changedSnapshot : bytes);
  const held = copy.venue.records.find(record => record.kind === 1 && same(decodeCommitment(record.record).root, root));
  assert(held, "fixture must contain the target commitment");
  const commitment = decodeCommitment(held.record);
  held.record = encodeCommitment(signCommitment(operatorSecret, commitment.sequence, directoryRoot(directory)));
  p.faults[0] = codec.encodeFaultEvidence(e, FAULT_LIMITS.maxSuffixEntries);
  return copy;
}

export async function checkAuthorizationCase({ label, payload, complete, validAuthorization, expectedRole, expectedSigner,
  codec, verifier, test, operatorSecret, demandEvidence, extraRoles = [], intrinsic = false, intrinsicProof = intrinsic }) {
  const input = structuredClone(payload);
  if (demandEvidence !== undefined) input.package.faults.push(demandEvidence);
  let result;
  await test(`compact ${label} failure ${intrinsic ? "excludes only its withheld target with complete dependencies" : "survives withheld history without an exclusion verdict"}`, async () => {
    const baseline = structuredClone(input); delete baseline.package.faults;
    const absent = await replayLocalPackage(baseline, verifier, codec);
    result = await replayLocalPackage(input, verifier, codec);
    assert.equal(result.status, intrinsic ? "selected-local-replay" : "unresolved-evidence");
    assert.deepEqual(signatures(result).map(f => f.authorizationRole), [expectedRole, ...extraRoles]);
    assert.equal(signatures(result)[0].signer, Buffer.from(expectedSigner).toString("hex"));
    assert.equal(result.faultEvidence.every(f => f.classification === "not-established"), true);
    const { faultEvidence, ...unchanged } = result;
    if (!intrinsic) assert.deepEqual(unchanged, absent);
    if (complete !== undefined) {
      const answer = await replayLocalPackage({ ...complete, package: { ...complete.package, faults: input.package.faults } }, verifier, codec);
      assert.equal(answer.status, "selected-local-replay");
      assert(answer.audit.range.carrying.some(c => c.class === "excluded" && c.check === "SIGNATURE"));
      assert.deepEqual(signatures(answer), signatures(result));
      if (intrinsic) assert.deepEqual(withoutFaultReasons(result), withoutFaultReasons(answer));
    }
  });
  await test(`compact ${label} valid controls, byte substitution and proof independence`, async () => {
    const valid = recommit(input, e => { e.authorization = validAuthorization; }, codec, operatorSecret);
    const validResult = await replayLocalPackage(valid, verifier, codec);
    assert.equal(validResult.status, "unresolved-evidence"); assert.equal(validResult.faultEvidence, undefined);
    const changed = structuredClone(input), e = codec.decodeFaultEvidence(changed.package.faults[0], FAULT_LIMITS.maxSuffixEntries);
    e.authorization[0] ^= 1; changed.package.faults[0] = codec.encodeFaultEvidence(e, FAULT_LIMITS.maxSuffixEntries);
    assert.equal((await replayLocalPackage(changed, verifier, codec)).faultEvidence, undefined);
    if (e.proof.length !== 0) {
      const unsupported = { ...verifier, verify: (kind, inputs, proof) => same(proof, e.proof) ? undefined : verifier.verify(kind, inputs, proof) };
      assert.deepEqual(signatures(await replayLocalPackage(input, unsupported, codec)).map(f => f.authorizationRole), [expectedRole, ...extraRoles]);
      for (const malformed of [false, true]) {
        const bad = recommit(input, target => { if (malformed) target.proof = new Uint8Array(); else target.proof[100] ^= 1; }, codec, operatorSecret);
        const observed = await replayLocalPackage(bad, verifier, codec);
        assert.deepEqual(signatures(observed).map(f => f.authorizationRole), [expectedRole, ...extraRoles]);
        assert.equal(observed.faultEvidence.some(f => f.check === "PROOF"), !malformed);
      }
    }
    const wrongWidth = recommit(input, target => { target.authorization = target.authorization.subarray(1); }, codec, operatorSecret);
    assert.equal((await replayLocalPackage(wrongWidth, verifier, codec)).faultEvidence, undefined);
  });
  if (demandEvidence !== undefined) await test(`compact ${label} presenter dependency is exact identity without demand admission`, async () => {
    const without = structuredClone(input); without.package.faults = without.package.faults.slice(0, 1);
    const independent = expectedRole === "acceptance" ? ["acceptance"] : [];
    assert.deepEqual(signatures(await replayLocalPackage(without, verifier, codec)).map(f => f.authorizationRole), independent);
    const wrong = structuredClone(input), candidate = codec.decodeFaultEvidence(wrong.package.faults[1], FAULT_LIMITS.maxSuffixEntries);
    candidate.statement[candidate.statement.length - 1] ^= 1;
    wrong.package.faults[1] = codec.encodeFaultEvidence(candidate, FAULT_LIMITS.maxSuffixEntries);
    assert.deepEqual(signatures(await replayLocalPackage(wrong, verifier, codec)).map(f => f.authorizationRole), independent);
    // Inventory order must not control whether the preimage was discovered.
    const reordered = structuredClone(input); reordered.package.faults.reverse();
    assert.deepEqual(await replayLocalPackage(reordered, verifier, codec), result);
    const target = codec.decodeFaultEvidence(input.package.faults[0], FAULT_LIMITS.maxSuffixEntries);
    const source = codec.decodeFaultEvidence(demandEvidence, FAULT_LIMITS.maxSuffixEntries);
    assert.equal(codec.verifyFaultEvidence({ backing: source.snapshot.backing, segment: source.snapshot.segment,
      digest: codec.snapshotDigest(source.snapshot) }, source, FAULT_LIMITS.maxSuffixEntries), false);
    assert.equal(result.faultEvidence.every(f => f.evidence === Buffer.from(hash(input.package.faults[0])).toString("hex")), true);
    if (codec.decodeStatement(target.statement).kind === 6) {
      const zero = recommit(input, e => {
        const statement = codec.decodeStatement(e.statement), p = [...statement.publicInputs]; p[8] = 0n;
        e.statement = codec.statementBytes({ ...statement, publicInputs: p });
      }, codec, operatorSecret);
      assert.deepEqual(signatures(await replayLocalPackage(zero, verifier, codec)), []);
    }
  });
  if (extraRoles.length) await test("named demand preimages reject wrong domain/backing/key/kind while retaining independent K evidence", async () => {
    for (const variant of ["domain", "backing", "key", "kind", "malformed", "source-segment"]) {
      const candidate = structuredClone(codec.decodeFaultEvidence(demandEvidence, FAULT_LIMITS.maxSuffixEntries));
      const statement = codec.decodeStatement(candidate.statement), p = [...statement.publicInputs];
      const domain = new Uint8Array(statement.domain);
      if (variant === "domain") { domain[0] ^= 1; p.splice(0, 2, ...limbsOf(domain)); }
      if (variant === "backing") p[5] ^= 1n;
      if (variant === "key") { p[12] = 0n; p[13] = 0n; }
      if (variant === "source-segment") p[2] ^= 1n;
      candidate.statement = codec.statementBytes({ domain, kind: variant === "kind" ? 5 : 4,
        publicInputs: variant === "kind" ? [...p.slice(0, 5), ...p.slice(5, 7)] : p });
      if (variant === "malformed") candidate.statement[0] ^= 1;
      const changed = recommit(input, e => {
        const s = codec.decodeStatement(e.statement), values = [...s.publicInputs];
        values.splice(15, 2, ...limbsOf(hash(candidate.statement)));
        e.statement = codec.statementBytes({ ...s, publicInputs: values });
      }, codec, operatorSecret);
      changed.package.faults[1] = codec.encodeFaultEvidence(candidate, FAULT_LIMITS.maxSuffixEntries);
      const observed = await replayLocalPackage(changed, verifier, codec);
      // Rebinding the statement also invalidates its proof. A supported
      // intrinsic proof failure can exclude it independently of signer lookup.
      assert.equal(observed.status, intrinsicProof ? "selected-local-replay" : "unresolved-evidence");
      if (intrinsicProof) assert(observed.audit.range.carrying.some(c => c.class === "excluded" && c.check === "PROOF"));
      assert.deepEqual(signatures(observed).map(f => f.authorizationRole), variant === "source-segment" ? ["acceptance", "release"] : ["acceptance"]);
    }
  });
  return { payload: input, result };
}
