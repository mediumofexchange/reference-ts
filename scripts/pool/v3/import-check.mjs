// C2.10.5–7 fixtures: real-proof imports through replacement and restarted segments.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree, notePathProves } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { limbsOf, fieldToBytes } from "../../../dist/pool/field.js";
import { signCommitment, encodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR } from "../../../dist/replacement.js";
import { prepareExactOutput } from "../delivery/crypto.mjs";
import { inspectRestorationEvidence, LIMITS } from "../delivery/evidence-reader.mjs";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage } from "./local-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";

const b = n => new Uint8Array(32).fill(n), hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const same = (a, b) => Buffer.compare(a, b) === 0;

export async function checkImports({ codec, verifier, configurationBytes, domain, venue, prove, test,
  operatorSecret, issuerSecret, receiverSeed, payerSeed, silence = false }) {
  const ruleSecret = b(111), successorSecret = b(112), operator = ed25519.getPublicKey(operatorSecret);
  const issuer = ed25519.getPublicKey(issuerSecret);
  const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue, interval: 10n,
    payout: { thing: "import fixture units", quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(ruleSecret),
    ...(silence ? { silence: { noCommitmentDuration: 4n, challengeWindow: 5n } } : {}) });
  const backing = codec.rootTermsName(terms);
  const signedTerms = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
  function replacement(secret, predecessor, effective, at) {
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(secret), predecessor, effective,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(backing, fields);
    const signed = { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, secret) };
    return { kind: 2, subject: backing, index: at, record: encodeReplacement(backing, signed), link: replacementHash(backing, signed) };
  }
  const toB = replacement(successorSecret, backing, 6n, 1n), toA = replacement(operatorSecret, toB.link, 12n, 7n);
  const reference = cp => ({ operator: cp.commitment.operator, sequence: cp.commitment.sequence, root: cp.commitment.root });
  function segment(secret, link, sequence, opening) {
    const header = codec.segmentBytes({ domain, venue, operator: ed25519.getPublicKey(secret), sequence,
      entries: [{ backing, link, ...(opening === undefined ? {} : { opening }) }] });
    const id = hash(header), scope = new ScopeTree([{ backing, link }]), path = scope.path(0);
    return { secret, header, id, scope, path, link, prefix: [...limbsOf(domain), ...limbsOf(id), scope.root()],
      base: { domain: limbsOf(domain).map(String), segment: limbsOf(id).map(String), scope: scope.root().toString() },
      single: { link: limbsOf(link).map(String), scope_siblings: path.siblings.map(String), scope_right: [...path.right] } };
  }
  const output = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  const digest = outputs => limbsOf(codec.deliveryHash(domain, outputs.map(x => x.cm), outputs.map(x => x.capsule)));
  const note = out => ({ backing: limbsOf(backing).map(String), value: out.opening.value.toString(),
    owner: out.opening.owner.toString(), rho: out.opening.rho.toString() });
  async function issue(ctx, out, label) {
    return prove(1, { ...ctx.base, ...ctx.single, backing: limbsOf(backing).map(String), quantity: out.opening.value.toString(),
      cm: out.cm.toString(), owner: out.opening.owner.toString(), rho: out.opening.rho.toString(), delivery: digest([out]).map(String) },
    [...ctx.prefix, ...limbsOf(backing), out.opening.value, out.cm, ...digest([out])], [out], label);
  }
  async function spend(ctx, inputs, positions, tree, outputs, label) {
    const paths = positions.map(position => tree.path(position));
    const anchors = inputs.map(() => tree.root());
    return prove(2, { ...ctx.base, inputs: inputs.map(note), secrets: inputs.map(x => x.secret.toString()),
      anchors: anchors.map(String), nullifiers: inputs.map(x => x.nf.toString()),
      siblings: paths.map(x => x.siblings.map(String)), right: paths.map(x => [...x.right]),
      links: [ctx.single.link, ctx.single.link], scope_siblings: [ctx.single.scope_siblings, ctx.single.scope_siblings],
      scope_right: [ctx.path.right, ctx.path.right], output_notes: outputs.map(note), outputs: outputs.map(x => x.cm.toString()),
      delivery: digest(outputs).map(String) },
    [...ctx.prefix, ...anchors, ...inputs.map(x => x.nf), ...outputs.map(x => x.cm), ...digest(outputs)], outputs, label);
  }
  async function burn(ctx, inputs, positions, tree, change, quantity, label) {
    const paths = positions.map(position => tree.path(position)), anchors = inputs.map(() => tree.root());
    return prove(3, { ...ctx.base, ...ctx.single, inputs: inputs.map(note), secrets: inputs.map(x => x.secret.toString()),
      anchors: anchors.map(String), nullifiers: inputs.map(x => x.nf.toString()),
      siblings: paths.map(x => x.siblings.map(String)), right: paths.map(x => [...x.right]),
      backing: limbsOf(backing).map(String), quantity: quantity.toString(), change: note(change), cm_change: change.cm.toString(),
      delivery: digest([change]).map(String) },
    [...ctx.prefix, ...limbsOf(backing), quantity, ...anchors, ...inputs.map(x => x.nf), change.cm, ...digest([change])], [change], label);
  }
  // Independent asserted-state fold. Imported leaves never enter this tree;
  // explicit imported nullifiers seed the combined spent root for local events.
  function checkpoint(ctx, sequence, at, records = [], effects = [], { issued = 10n, burned = 0n, nullifiers = [] } = {}) {
    const tree = new NoteTree(), spent = new RadixSpentSet();
    nullifiers.forEach(nf => spent.insert(fieldToBytes(nf)));
    let history = codec.genesisHistoryHash(ctx.id), evidence = codec.genesisEvidenceHash(ctx.id);
    records.forEach((record, i) => {
      tree.appendAll(effects[i].outputs);
      effects[i].nullifiers.forEach(nf => { if (!spent.has(fieldToBytes(nf))) spent.insert(fieldToBytes(nf)); });
      history = codec.nextHistoryHash(history, codec.statementHash(record), tree.root(), spent.root(), BigInt(i) + 1n);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n);
    });
    const snapshot = codec.snapshotBytes({ backing, segment: ctx.id, historyHash: history, evidenceHash: evidence, issued, burned });
    const directory = [{ name: backing, digest: hash(snapshot) }];
    return { at, snapshot, directory, tree, spent, commitment: signCommitment(ctx.secret, sequence, directoryRoot(directory)),
      trail: codec.encodeTrail({ header: ctx.header, terms: [signedTerms], records: records.map(codec.encodeRecord) }, LIMITS) };
  }
  function compose(checkpoints, chosen = checkpoints.at(-1), replacements = [toB, toA]) {
    const record = new FixtureVenue(venue, 20n, 2n);
    for (const cp of checkpoints) record.witness(1, cp.commitment.operator, cp.at, encodeCommitment(cp.commitment));
    for (const r of replacements) record.witness(r.kind, r.subject, r.index, r.record);
    const distinct = (values, bytes) => values.filter((value, i) => values.findIndex(other => same(bytes(value), bytes(other))) === i);
    // Each portable inventory object appears exactly once, even when an empty
    // opening and its continuation commit identical snapshot/trail bytes.
    const rest = checkpoints.filter(cp => cp !== chosen);
    return { selection: { domain, venue, backing, operator: chosen.commitment.operator, sequence: chosen.commitment.sequence,
      root: chosen.commitment.root, judgingIndex: 20n, mode: "current-fixture" },
    package: { configuration: configurationBytes, commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
      directories: distinct([chosen.directory, ...rest.map(cp => cp.directory)], directoryRoot).slice(1),
      snapshot: chosen.snapshot, snapshots: distinct([chosen.snapshot, ...rest.map(cp => cp.snapshot)], x => x).slice(1),
      trail: chosen.trail, trails: distinct([chosen.trail, ...rest.map(cp => cp.trail)], x => x).slice(1) }, venue: record.export() };
  }
  async function reject(payload, check) {
    const result = await replayLocalPackage(payload, verifier, codec);
    assert.equal(result.status, "invalid-local-replay"); assert.equal(result.check, check);
    assert.equal(result.audit, null); assert.deepEqual(result.candidates, []); assert.equal(result.spendable, false);
  }
  const a = segment(operatorSecret, backing, 1n), funded = output(payerSeed, 113, 10n);
  const issuance = await issue(a, funded, "import A issue 10"), issueEffect = { outputs: [funded.cm], nullifiers: [] };
  const a0 = checkpoint(a, 1n, 1n, [], [], { issued: 0n }), a1 = checkpoint(a, 2n, 2n, [issuance], [issueEffect]);
  const bs = segment(successorSecret, toB.link, 1n, reference(a1)), b0 = checkpoint(bs, 1n, 6n);
  const paid = output(receiverSeed, 114, 7n), change = output(payerSeed, 115, 3n);
  const pad = output(payerSeed, 116, 0n), zero1 = output(payerSeed, 117, 0n), zero2 = output(payerSeed, 118, 0n);
  const payment = await spend(bs, [funded, pad], [0n, 0n], a1.tree, [paid, change, zero1, zero2], "import B spends A note");
  const paymentEffect = { outputs: [paid.cm, change.cm, zero1.cm, zero2.cm], nullifiers: [funded.nf, pad.nf] };
  const b1 = checkpoint(bs, 2n, 8n, [payment], [paymentEffect]);
  const paid2 = output(receiverSeed, 119, 2n), pad2 = output(payerSeed, 121, 0n);
  const payment2 = await burn(bs, [change, pad2], [1n, 0n], b1.tree, paid2, 1n, "import B continuation burns 1 with change 2");
  const paymentEffect2 = { outputs: [paid2.cm], nullifiers: [change.nf, pad2.nf] };
  const b2 = checkpoint(bs, 3n, 10n, [payment, payment2], [paymentEffect, paymentEffect2], { burned: 1n });
  const imports = [...paymentEffect.nullifiers, ...paymentEffect2.nullifiers], history = [a0, a1, b0, b1, b2];
  const cs = segment(operatorSecret, toA.link, 3n, reference(b2)), c0 = checkpoint(cs, 3n, 14n, [], [], { burned: 1n });
  const c1 = checkpoint(cs, 4n, 15n, [], [], { burned: 1n });
  const ds = segment(operatorSecret, toA.link, 5n, reference(c1)), d0 = checkpoint(ds, 5n, silence ? 16n : 15n, [], [], { burned: 1n });
  const payload = compose([...history, c0, c1, d0]);
  let result, receiver;
  await test("successor imports the finalized source prefix into an empty local tree and restores its original path", async () => {
    const restored = await replayLocalPackage({ ...compose([a0, a1, b0], b0, [toB]), seed: payerSeed }, verifier, codec);
    assert.equal(restored.status, "selected-local-replay"); assert.equal(restored.audit.records, "0");
    assert.equal(restored.audit.noteRoot, new NoteTree().root().toString()); assert.equal(restored.audit.issued, "10");
    assert.deepEqual(restored.candidates.map(x => [x.cm, x.value, x.anchor, x.pathScope]),
      [[funded.cm.toString(), "10", a1.tree.root().toString(), "replayed-imported-tree-only"]]);
    const path = restored.candidates[0];
    assert.equal(notePathProves(BigInt(path.anchor), BigInt(path.cm), { siblings: path.siblings.map(BigInt), right: path.right }), true);
  });
  await test("real spend of an imported note and continuation preserve totals and append only local outputs", async () => {
    const continuation = await replayLocalPackage({ ...compose(history, b2, [toB]), seed: receiverSeed }, verifier, codec);
    assert.equal(continuation.status, "selected-local-replay"); assert.equal(continuation.audit.records, "2");
    assert.equal(continuation.audit.issued, "10"); assert.equal(continuation.audit.burned, "1");
    assert.equal(continuation.audit.noteRoot, b2.tree.root().toString()); assert.equal(continuation.audit.spentRoot, hex(b2.spent.root()));
    assert.deepEqual(continuation.candidates.map(x => [x.cm, x.value]), [[paid.cm.toString(), "7"], [paid2.cm.toString(), "2"]]);
    assert.equal(continuation.candidates.every(x => x.pathScope === "replayed-local-tree-only"), true);
  });
  await test("A to B to A and restarted imports keep one transitive closure and original-tree wallet paths", async () => {
    result = await replayLocalPackage(payload, verifier, codec);
    receiver = await replayLocalPackage({ ...payload, seed: receiverSeed }, verifier, codec);
    assert.equal(result.status, "selected-local-replay"); assert.deepEqual(result.audit, receiver.audit);
    assert.equal(result.audit.records, "0"); assert.equal(result.audit.issued, "10"); assert.equal(result.audit.burned, "1");
    assert.equal(result.audit.outstanding, "9");
    assert.equal(result.audit.noteRoot, new NoteTree().root().toString()); assert.equal(result.audit.spentRoot, hex(b2.spent.root()));
    assert.deepEqual(receiver.candidates.map(x => [x.cm, x.value, x.leaf, x.pathScope]),
      [[paid.cm.toString(), "7", "0", "replayed-imported-tree-only"], [paid2.cm.toString(), "2", "4", "replayed-imported-tree-only"]]);
    for (const path of receiver.candidates) {
      assert.equal(path.anchor, b2.tree.root().toString());
      assert.equal(notePathProves(BigInt(path.anchor), BigInt(path.cm), { siblings: path.siblings.map(BigInt), right: path.right }), true);
    }
    assert.equal(result.audit.range.carrying.every(c => c.class === "valid"), true);
    const payer = await replayLocalPackage({ ...payload, seed: payerSeed }, verifier, codec);
    assert.deepEqual(payer.candidates, []);
  });
  await test("every missing imported directory, snapshot or trail refuses with no partial restoration", async () => {
    for (const key of ["directories", "snapshots", "trails"]) {
      const missing = structuredClone(payload); missing.package[key] = [];
      const answer = await replayLocalPackage({ ...missing, seed: receiverSeed }, verifier, codec);
      assert.equal(answer.status, "unresolved-evidence"); assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []);
    }
    assert.equal(inspectRestorationEvidence(receiverSeed, payload.selection, payload.package, codec).status, "unsupported-scope");
    // A continuation with no held opening is unresolved, so a later operator
    // cannot treat it as excluded and roll back to its remembered A state.
    const stale = checkpoint(segment(operatorSecret, toA.link, 3n, reference(a1)), 3n, 14n);
    for (const missing of [structuredClone(payload), compose([...history, stale])]) {
      missing.venue.records = missing.venue.records.filter(r => !same(r.record, encodeCommitment(b0.commitment)));
      const answer = await replayLocalPackage(missing, verifier, codec);
      assert.equal(answer.status, "unresolved-evidence"); assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []);
    }
  });
  await test("stale, unheld and remembered pre-replacement imports cannot replace the required canonical predecessor", async () => {
    for (const opening of [reference(b1), { ...reference(b2), sequence: 99n }, reference(a1)]) {
      const ctx = segment(operatorSecret, toA.link, 3n, opening), stale = checkpoint(ctx, 3n, 14n);
      await reject(compose([...history, stale]), "IMPORT");
    }
    const staleB = segment(successorSecret, toB.link, 1n, reference(a0));
    await reject(compose([a0, a1, checkpoint(staleB, 1n, 6n)], undefined, [toB]), "IMPORT");
  });
  await test("an authenticated excluded source tail is classified and passed rather than imported", async () => {
    // Keep the valid prefix and append a distinct statement with invalid proof
    // bytes; this must fail PROOF, not prefix continuity or statement identity.
    const unused = output(payerSeed, 129, 11n), invalid = structuredClone(issuance);
    invalid.proof[100] ^= 1; invalid.publicInputs[7] = 11n; invalid.publicInputs[8] = unused.cm;
    invalid.publicInputs.splice(9, 2, ...digest([unused])); invalid.capsules = [unused.capsule];
    invalid.authorization = ed25519.sign(codec.statementBytes(invalid), issuerSecret);
    const tail = checkpoint(a, 3n, 4n, [issuance, invalid], [issueEffect, { outputs: [unused.cm], nullifiers: [] }], { issued: 21n });
    const answer = await replayLocalPackage(compose([a0, a1, tail, b0], b0, [toB]), verifier, codec);
    assert.equal(answer.status, "selected-local-replay"); assert.equal(answer.audit.issued, "10");
    assert.deepEqual(answer.audit.range.carrying.map(c => c.class), ["valid", "valid", "excluded", "valid"]);
    assert.equal(answer.audit.range.carrying[2].check, "PROOF");
    const bad = segment(successorSecret, toB.link, 1n, reference(tail));
    await reject(compose([a0, a1, tail, checkpoint(bad, 1n, 6n)], undefined, [toB]), "IMPORT");
  });
  const fresh = [output(receiverSeed, 124, 6n), output(payerSeed, 125, 4n), output(payerSeed, 126, 0n), output(payerSeed, 127, 0n)];
  const spentPad = output(payerSeed, 128, 0n);
  const doubleSpend = await spend(cs, [funded, spentPad], [0n, 0n], a1.tree, fresh, "import C valid proof for imported spent note");
  const duplicate = await issue(cs, funded, "import C valid issuance proof for imported duplicate output");
  await test("otherwise valid proofs cannot reuse an imported nullifier or output commitment", async () => {
    const repeated = checkpoint(cs, 4n, 15n, [doubleSpend], [{ outputs: fresh.map(x => x.cm), nullifiers: [funded.nf, spentPad.nf] }], { nullifiers: imports, burned: 1n });
    await reject(compose([...history, c0, repeated]), "SPENT");
    const duplicated = checkpoint(cs, 4n, 15n, [duplicate], [issueEffect], { nullifiers: imports, issued: 20n, burned: 1n });
    await reject(compose([...history, c0, duplicated]), "OUTPUT");
  });
  await test("the import checkpoint budget counts held non-carrying commitments and returns no partial result", async () => {
    const oversized = structuredClone(payload), directory = [{ name: b(140), digest: b(141) }];
    oversized.package.directories.push(directory);
    for (let i = 0n; i < 129n; i++) oversized.venue.records.push({ kind: 1, subject: operator, index: 16n,
      record: encodeCommitment(signCommitment(operatorSecret, 6n + i, directoryRoot(directory))) });
    const answer = await replayLocalPackage(oversized, verifier, codec);
    assert.equal(answer.status, "resource-refusal"); assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []);
  });
  let refusedPayload;
  if (silence) {
    const classes = answer => answer.audit.range.carrying.map(c => c.class);
    const accepted = async p => {
      const answer = await replayLocalPackage(p, verifier, codec);
      assert.equal(answer.status, "selected-local-replay"); return answer;
    };
    const refuse = async (p, status, custom = verifier) => {
      const answer = await replayLocalPackage({ ...p, seed: receiverSeed }, custom, codec);
      assert.equal(answer.status, status); assert.equal(answer.audit, null);
      assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false); return answer;
    };
    await test("duration equality across replacement and reappointment stays closed; the judging-index reset is strict", async () => {
      assert.deepEqual(result.audit.range.clock, { duration: "4", snapshotIndex: "16", gap: "4", open: false, boundary: null, opening: "16" });
      const atOpening = structuredClone(payload);
      atOpening.selection.judgingIndex = 16n; atOpening.selection.mode = "historical-fixture";
      const answer = await replayLocalPackage(atOpening, verifier, codec);
      assert.equal(answer.status, "historical-local-replay");
      assert.deepEqual(answer.audit.range.clock, { duration: "4", snapshotIndex: "15", gap: "1", open: false, boundary: null, opening: "16" });
    });
    await test("return opens in a gap but its same-index continuation lapses; next-index continuation restores imported payments", async () => {
      const returned = { ...c0, at: 16n }, sameIndex = { ...c1, at: 16n }, nextIndex = { ...c1, at: 17n };
      const atGap = await accepted(compose([...history, returned, sameIndex], returned));
      assert.deepEqual(classes(atGap).slice(-2), ["valid", "lapsed"]);
      assert.deepEqual(atGap.audit.range.clock, { duration: "4", snapshotIndex: "16", gap: "4", open: false, boundary: null, opening: "16" });
      const lapsed = await refuse(compose([...history, returned, sameIndex]), "lapsed-selection");
      assert.deepEqual(lapsed.clock, { duration: "4", snapshotIndex: "10", gap: "6", open: true, boundary: null, opening: "16" });
      const resumed = await accepted({ ...compose([...history, returned, nextIndex]), seed: receiverSeed });
      assert.deepEqual(resumed.candidates, receiver.candidates);
      assert.equal(resumed.audit.outstanding, "9"); assert.deepEqual(classes(resumed).slice(-2), ["valid", "valid"]);
      const stale = checkpoint(segment(operatorSecret, toA.link, 3n, reference(b1)), 3n, 16n);
      await reject(compose([...history, stale]), "IMPORT");
    });
    await test("a later fresh segment reset cannot revive a segment retired exactly at the return index", async () => {
      const returned = checkpoint(segment(operatorSecret, toA.link, 4n, reference(c0)), 4n, 19n, [], [], { burned: 1n });
      const retired = checkpoint(cs, 5n, 20n, [], [], { burned: 1n });
      const kept = await accepted(compose([...history, c0, returned, retired], returned));
      assert.deepEqual(classes(kept).slice(-2), ["valid", "lapsed"]);
      assert.equal(kept.audit.range.clock.open, false);
      refusedPayload = compose([...history, c0, returned, retired]);
      const answer = await refuse(refusedPayload, "lapsed-selection");
      assert.deepEqual(answer.clock, { duration: "4", snapshotIndex: "19", gap: "1", open: false, boundary: "19", opening: "14" });
      // At the boundary itself the still-open gap also lapses the old segment.
      await refuse(compose([...history, c0, { ...retired, at: 19n }]), "lapsed-selection");
    });
    await test("an excluded opening never resets the clock and retains its retirement boundary", async () => {
      const badContext = segment(operatorSecret, toA.link, 4n, reference(c0));
      const bad = checkpoint(badContext, 4n, 15n, [], [], { issued: 11n, burned: 1n });
      const later = checkpoint(badContext, 5n, 20n, [], [], { burned: 1n });
      const returned = checkpoint(segment(operatorSecret, toA.link, 6n, reference(c0)), 6n, 20n, [], [], { burned: 1n });
      const answer = await accepted(compose([...history, c0, bad, later, returned]));
      assert.deepEqual(classes(answer).slice(-3), ["excluded", "lapsed", "valid"]);
      assert.equal(answer.audit.range.carrying.at(-3).check, "SNAPSHOT");
      assert.equal(answer.audit.range.clock.snapshotIndex, "14");
    });
    await test("same-index fresh silence openings refuse before choosing between generic predecessor and strict snapshot", async () => {
      const returned = { ...c0, at: 16n };
      for (const source of [returned, b2]) {
        const again = checkpoint(segment(operatorSecret, toA.link, 4n, reference(source)), 4n, 16n, [], [], { burned: 1n });
        await refuse(compose([...history, returned, again]), "unsupported-scope");
      }
    });
    await test("reappointment cannot reset the backing clock with a checkpoint from the same key's ended term", async () => {
      const late = checkpoint(a, 3n, 14n, [issuance], [issueEffect]);
      const returned = checkpoint(segment(operatorSecret, toA.link, 4n, reference(b2)), 4n, 16n, [], [], { burned: 1n });
      const p = compose([...history, late, returned]);
      p.selection.judgingIndex = 16n; p.selection.mode = "historical-fixture";
      const answer = await replayLocalPackage(p, verifier, codec);
      assert.equal(answer.status, "historical-local-replay");
      assert.deepEqual(classes(answer).slice(-2), ["lapsed", "valid"]);
      assert.deepEqual(answer.audit.range.clock, { duration: "4", snapshotIndex: "10", gap: "6", open: true, boundary: null, opening: "16" });
    });
    await test("publication closure must be answered independently and empty, including at opening and judging indices", async () => {
      const unavailable = { ...verifier, record(data) {
        const record = verifier.record(data);
        return { ...record, range: request => request.kind === 4 ? undefined : record.range(request) };
      } };
      await refuse(payload, "unresolved-evidence", unavailable);
      for (const at of [0n, 14n, 16n, 20n]) {
        const published = structuredClone(payload);
        published.venue.records.push({ kind: 4, subject: backing, index: at, record: new Uint8Array(92) });
        await refuse(published, "unsupported-scope");
      }
      const withheld = structuredClone(payload); withheld.package.trails = [];
      await refuse(withheld, "unresolved-evidence");
    });
  }
  return { payload, result, receiver, ...(refusedPayload === undefined ? {} : { refusedPayload }) };
}
