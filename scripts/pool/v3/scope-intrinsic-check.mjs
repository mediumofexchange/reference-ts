// §9.1 whole-scope exclusion using either sibling's compact snapshot.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { directoryRoot, signCommitment } from "../../../dist/venue-records.js";
import { replayLocalPackage } from "./local-replay.mjs";
import { compactFault, withoutFaultReasons } from "./fault-check.mjs";
import { LIMITS } from "../delivery/evidence-reader.mjs";

const same = (a, b) => Buffer.compare(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());

export function withholdSharedTarget(payload, target, records, position, backing, codec) {
  const copy = structuredClone(payload);
  copy.package.trails = copy.package.trails.filter(bytes => !same(bytes, target.trail));
  const snapshot = target.snapshots.find(bytes => same(codec.decodeSnapshot(bytes).backing, backing));
  copy.package.faults = [compactFault(snapshot, records, position, codec)];
  return copy;
}

export async function sharedEquivalent(complete, partial, verifier, codec) {
  const answer = await replayLocalPackage(partial, verifier, codec);
  assert.equal(answer.status, "selected-local-replay", JSON.stringify(answer));
  assert.equal(answer.spendable, false);
  const { faultEvidence, ...state } = answer;
  assert(faultEvidence.some(f => f.check === "PROOF" || f.authorizationRole === "issue"));
  assert.deepEqual(withoutFaultReasons(state), withoutFaultReasons(await replayLocalPackage(complete, verifier, codec)));
  return answer;
}

export async function checkSharedIntrinsic({ codec, verifier, test, operatorSecret, issuerSecret, issuerSecretY,
  payerSeed, x, y, shared, a0, a1, issuanceX, issuanceY, effects, checkpoint, compose, silence = false }) {
  const cases = [], snapshot = (cp, backing) => cp.snapshots.find(bytes => same(codec.decodeSnapshot(bytes).backing, backing));
  const remember = (payload, result) => { cases.push({ payload, result }); return result; };
  const refuse = async (payload, custom = verifier) => {
    const result = await replayLocalPackage(payload, custom, codec);
    assert.equal(result.status, "unresolved-evidence", JSON.stringify(result));
    assert.equal(result.audit, null); assert.deepEqual(result.candidates, []); assert.equal(result.spendable, false);
    return result;
  };
  let target, records, complete, partial;
  await test("shared compact proof and issue-K faults agree through either selection and sibling snapshot", async () => {
    for (const failure of ["proof", "authorization"]) {
      const bad = structuredClone(issuanceY);
      if (failure === "proof") bad.proof[100] ^= 1;
      else bad.authorization = ed25519.sign(codec.statementBytes(bad), issuerSecret);
      records = [issuanceX, bad]; target = checkpoint(shared, 3n, 4n, records, effects);
      for (const selected of [x, y]) for (const anchor of [x, y]) {
        complete = { ...compose([a0, a1, target], a1, selected, 5n), seed: payerSeed };
        partial = withholdSharedTarget(complete, target, records, 2n, anchor, codec);
        const answer = await sharedEquivalent(complete, partial, verifier, codec);
        assert.equal(answer.audit.range.carrying.find(c => c.sequence === "3").class, "excluded");
        assert.equal(answer.faultEvidence[0].backing, hex(anchor));
        if (failure === "authorization") {
          assert.equal(answer.faultEvidence[0].authorizationBacking, hex(y));
          assert.equal(answer.faultEvidence[0].signer, hex(ed25519.getPublicKey(issuerSecretY)));
        }
        // Retain the cross-sibling reads for portable/fresh-process acceptance.
        if (!same(selected, anchor)) remember(partial, answer);
      }
    }
  });
  await test("shared compact exclusion refuses missing or mismatched sibling snapshot bindings", async () => {
    // Select x and authenticate the fault through x, so y's absence cannot be
    // mistaken for missing selected-envelope or compact-opening bytes.
    complete = compose([a0, a1, target], a1, x, 5n);
    partial = withholdSharedTarget(complete, target, records, 2n, x, codec);
    const missing = structuredClone(partial);
    missing.package.snapshots = missing.package.snapshots.filter(bytes => !same(bytes, snapshot(target, y)));
    remember(missing, await refuse(missing));
    for (const field of ["segment", "historyHash", "evidenceHash"]) {
      const altered = { ...target, snapshots: target.snapshots.map(bytes => {
        const value = codec.decodeSnapshot(bytes);
        if (!same(value.backing, y)) return bytes;
        value[field][0] ^= 1; return codec.snapshotBytes(value);
      }) };
      altered.directory = altered.snapshots.map(bytes => ({ name: codec.decodeSnapshot(bytes).backing, digest: hash(bytes) }));
      altered.commitment = signCommitment(operatorSecret, 3n, directoryRoot(altered.directory));
      await refuse(withholdSharedTarget(compose([a0, a1, altered], a1, x, 5n), altered, records, 2n, x, codec));
    }
    const incomplete = { ...target, directory: target.directory.filter(e => same(e.name, x)) };
    incomplete.commitment = signCommitment(operatorSecret, 3n, directoryRoot(incomplete.directory));
    await refuse(withholdSharedTarget(compose([a0, a1, incomplete], a1, x, 5n), incomplete, records, 2n, x, codec));
  });
  await test("shared compact fault cannot fill unknown sibling terms, clock ranges or earlier state", async () => {
    for (const cp of [a0, a1]) {
      const missing = structuredClone(partial);
      missing.package.snapshots = missing.package.snapshots.filter(bytes => !same(bytes, snapshot(cp, y)));
      await refuse(missing);
    }
    const noOpening = structuredClone(partial);
    noOpening.package.trails = noOpening.package.trails.filter(bytes => !same(bytes, a0.trail));
    // pool-v3 §12.1: the opening's served trail is also the selected trail's empty prefix.
    const served = remember(noOpening, await replayLocalPackage(noOpening, verifier, codec));
    assert.deepEqual(served, await replayLocalPackage(partial, verifier, codec));
    const invalidTerms = structuredClone(partial);
    const corrupt = bytes => {
      const trail = codec.decodeTrail(bytes, LIMITS), header = codec.decodeSegmentHeader(trail.header);
      trail.terms[header.entries.findIndex(e => same(e.backing, y))].signature[0] ^= 1;
      return codec.encodeTrail(trail, LIMITS);
    };
    invalidTerms.package.trail = corrupt(invalidTerms.package.trail);
    invalidTerms.package.trails = invalidTerms.package.trails.map(corrupt);
    await refuse(invalidTerms);
    for (const [kind, subject] of [[2, y], [3, ed25519.getPublicKey(issuerSecretY)], ...(silence ? [[4, y]] : [])]) {
      const unavailable = { ...verifier, record(data) {
        const record = verifier.record(data);
        return { ...record, range: request => request.kind === kind && same(request.subject, subject) ? undefined : record.range(request) };
      } };
      await refuse(partial, unavailable);
    }
    const validRecords = [issuanceX, issuanceY], valid = checkpoint(shared, 3n, 4n, validRecords, effects);
    const control = await replayLocalPackage(withholdSharedTarget(compose([a0, a1, valid], a1, x, 5n), valid, validRecords, 2n, x, codec), verifier, codec);
    // The earlier selection already supplies this identical complete trail.
    assert.equal(control.status, "superseded-selection"); assert.equal(control.faultEvidence, undefined);
  });
  await test("shared compact exclusion preserves same-index repair and both silence clocks", async () => {
    const repaired = checkpoint(shared, 4n, 4n, [issuanceX, issuanceY], effects);
    for (const selected of [x, y]) {
      const all = compose([a0, a1, target, repaired], repaired, selected, silence ? 9n : 5n);
      const p = withholdSharedTarget(all, target, records, 2n, x, codec);
      const result = remember(p, await sharedEquivalent(all, p, verifier, codec));
      assert.deepEqual(result.audit.range.carrying.map(c => [c.sequence, c.class]),
        [["1", "valid"], ["2", "valid"], ["3", "excluded"], ["4", "valid"]]);
      if (silence) assert.deepEqual(result.audit.range.clock,
        { duration: "4", snapshotIndex: "4", gap: "5", open: true, boundary: "9", opening: "1" });
    }
    if (silence) for (const selected of [x, y]) {
      const late = { ...repaired, at: 7n };
      const all = compose([a0, a1, target, late], a1, selected, 8n);
      const p = withholdSharedTarget(all, target, records, 2n, x, codec);
      const result = remember(p, await sharedEquivalent(all, p, verifier, codec));
      assert.deepEqual(result.audit.range.carrying.map(c => c.class), ["valid", "valid", "excluded", "lapsed"]);
      assert.deepEqual(result.audit.range.clock,
        { duration: "4", snapshotIndex: "2", gap: "6", open: true, boundary: "7", opening: "1" });
    }
  });
  return cases;
}
