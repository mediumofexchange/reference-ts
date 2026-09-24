// Conditional C2.10/C3.7 scope recovery. The caller supplies either a cheap
// proof oracle for the decisive replay probe or independently checked proofs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree, notePathProves } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { limbsOf, fieldToBytes } from "../../../dist/pool/field.js";
import { ownerOf, commitmentOf, nullifierOf } from "../../../dist/pool/notes.js";
import { poseidon2Hash } from "../../../dist/pool/poseidon2.js";
import { signCommitment, encodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../delivery/crypto.mjs";
import { LIMITS } from "../delivery/evidence-reader.mjs";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage, RANGE_LIMITS } from "./local-replay.mjs";
import { mergeFinalizedPrefixes } from "./scope-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";
import { checkRecoveryScopeReceipts } from "./scope-receipt-check.mjs";
import { checkRecoveryScopeCounts } from "./scope-count-check.mjs";
import { checkSharedIntrinsic, withholdSharedTarget, sharedEquivalent } from "./scope-intrinsic-check.mjs";

const b = n => new Uint8Array(32).fill(n), hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const same = (a, b) => Buffer.compare(a, b) === 0;
const distinct = (values, bytes) => values.filter((value, i) => values.findIndex(other => same(bytes(value), bytes(other))) === i);
const tagOf = nf => poseidon2Hash([1007n, nf]);
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));
const u64 = value => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value, false); return out; };

export async function checkScopeRecovery({ codec, verifier, configurationBytes, domain, venue, prove, test,
  operatorSecret, issuerSecret, receiverSeed, payerSeed }) {
  const operator = ed25519.getPublicKey(operatorSecret), issuerSecretY = b(181), issuerSeed = b(182);
  const presenterX = b(183), presenterY = b(184);
  const backings = ["scope recovery x", "scope recovery y"].map((thing, i) => {
    const secret = i === 0 ? issuerSecret : issuerSecretY;
    const terms = codec.encodeRootTerms({ obligor: ed25519.getPublicKey(secret), operator, configuration: domain, venue,
      interval: 10n, payout: { thing, quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(b(185)),
      silence: { noCommitmentDuration: 4n, challengeWindow: 5n },
      nonService: i === 0 ? { duration: 2n, count: 1n, window: 20n } : { duration: 3n, count: 2n, window: 12n } });
    return { backing: codec.rootTermsName(terms), secret, signed: { terms,
      signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), secret) } };
  });
  const [x, y] = backings.map(t => t.backing);
  const reference = cp => ({ operator, sequence: cp.commitment.sequence, root: cp.commitment.root });
  const entry = (backing, cp) => ({ backing, link: backing, ...(cp === undefined ? {} : { opening: reference(cp) }) });
  function segment(sequence, entries) {
    entries = [...entries].sort((a, b) => Buffer.compare(a.backing, b.backing));
    const header = codec.segmentBytes({ domain, venue, operator, sequence, entries });
    const id = hash(header), scope = new ScopeTree(entries);
    const paths = new Map(entries.map((e, i) => [hex(e.backing), scope.path(i)]));
    return { header, id, entries, paths, prefix: [...limbsOf(domain), ...limbsOf(id), scope.root()],
      base: { domain: limbsOf(domain).map(String), segment: limbsOf(id).map(String), scope: scope.root().toString() } };
  }
  const output = (backing, seed, id, value) => ({ ...prepareExactOutput(seed, domain, b(id), backing, value), backing });
  const note = o => ({ backing: limbsOf(o.backing).map(String), value: o.opening.value.toString(),
    owner: o.opening.owner.toString(), rho: o.opening.rho.toString() });
  const digest = outputs => limbsOf(codec.deliveryHash(domain, outputs.map(o => o.cm), outputs.map(o => o.capsule)));
  const membership = (ctx, backing) => ({ link: limbsOf(backing).map(String),
    scope_siblings: ctx.paths.get(hex(backing)).siblings.map(String), scope_right: [...ctx.paths.get(hex(backing)).right] });
  async function issue(ctx, out, label) {
    const record = await prove(1, { ...ctx.base, ...membership(ctx, out.backing), backing: limbsOf(out.backing).map(String),
      quantity: out.opening.value.toString(), cm: out.cm.toString(), owner: out.opening.owner.toString(),
      rho: out.opening.rho.toString(), delivery: digest([out]).map(String) },
    [...ctx.prefix, ...limbsOf(out.backing), out.opening.value, out.cm, ...digest([out])], [out], label);
    record.authorization = ed25519.sign(codec.statementBytes(record), same(out.backing, x) ? issuerSecret : issuerSecretY);
    return record;
  }
  function holding(inputs, positions, tree, zeroAnchor = tree.root()) {
    const paths = positions.map(p => tree.path(p));
    return { inputs: inputs.map(note), secrets: inputs.map(o => o.secret.toString()),
      anchors: inputs.map(o => o.opening.value === 0n ? zeroAnchor : tree.root()),
      siblings: paths.map(p => p.siblings.map(String)), right: paths.map(p => [...p.right]) };
  }
  async function demand(ctx, input, position, tree, presenterSecret, instant, label) {
    const pad = output(input.backing, payerSeed, 186, 0n), held = holding([input, pad], [position, 0n], tree, 0n);
    const presenter = ed25519.getPublicKey(presenterSecret), tags = [tagOf(input.nf), 0n], deadline = 30n;
    return prove(4, { ...ctx.base, ...membership(ctx, input.backing), ...held, anchors: held.anchors.map(String),
      backing: limbsOf(input.backing).map(String), quantity: input.opening.value.toString(), tags: tags.map(String),
      presenter: limbsOf(presenter).map(String), instant: instant.toString(), deadline: deadline.toString() },
    [...ctx.prefix, ...limbsOf(input.backing), input.opening.value, ...held.anchors, ...tags,
      ...limbsOf(presenter), instant, deadline], [], label);
  }
  function withdrawal(ctx, d, secret) {
    const record = { domain, kind: 5, publicInputs: [...ctx.prefix, ...limbsOf(codec.statementHash(d))],
      proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] };
    record.authorization = ed25519.sign(codec.withdrawalBytes(record), secret); return record;
  }
  async function settlement(ctx, d, input, position, tree, presenterSecret, rho, label) {
    const demandId = codec.statementHash(d), deadline = 25n;
    const secret = deriveSettlementOwnerSecret(issuerSeed, domain, demandId, deadline).value;
    const opening = { backing: input.backing, value: input.opening.value, owner: ownerOf(secret), rho };
    const settled = { backing: input.backing, secret, opening, cm: commitmentOf(domain, opening) };
    settled.nf = nullifierOf(domain, settled.cm, secret);
    const pad = output(input.backing, payerSeed, 187, 0n), inputs = [input, pad];
    const held = holding(inputs, [position, 0n], tree);
    const record = await prove(6, { ...ctx.base, ...membership(ctx, input.backing), ...held,
      anchors: held.anchors.map(String), backing: limbsOf(input.backing).map(String), quantity: opening.value.toString(),
      owner: opening.owner.toString(), rho_out: rho.toString(), nullifiers: inputs.map(o => o.nf.toString()),
      cm_out: settled.cm.toString(), demand: limbsOf(demandId).map(String) },
    [...ctx.prefix, ...limbsOf(input.backing), opening.value, opening.owner, rho, ...held.anchors,
      ...inputs.map(o => o.nf), settled.cm, ...limbsOf(demandId)], [], label);
    const acceptance = { domain, demand: demandId, owner: opening.owner, deadline };
    const signature = ed25519.sign(codec.acceptanceBytes(acceptance), same(input.backing, x) ? issuerSecret : issuerSecretY);
    const release = codec.releaseBytes(domain, demandId, codec.acceptanceId({ ...acceptance, signature }), codec.statementHash(record));
    record.authorization = concat(u64(deadline), signature, ed25519.sign(release, presenterSecret));
    return { record, output: settled, inputs };
  }
  async function spend(ctx, input, position, tree, outputs, label) {
    const pad = output(input.backing, payerSeed, 188, 0n), inputs = [input, pad];
    const held = holding(inputs, [position, 0n], tree), memberships = inputs.map(o => membership(ctx, o.backing));
    const record = await prove(2, { ...ctx.base, ...held, anchors: held.anchors.map(String),
      nullifiers: inputs.map(o => o.nf.toString()), links: memberships.map(m => m.link),
      scope_siblings: memberships.map(m => m.scope_siblings), scope_right: memberships.map(m => m.scope_right),
      output_notes: outputs.map(note), outputs: outputs.map(o => o.cm.toString()), delivery: digest(outputs).map(String) },
    [...ctx.prefix, ...held.anchors, ...inputs.map(o => o.nf), ...outputs.map(o => o.cm), ...digest(outputs)], outputs, label);
    return { record, inputs };
  }
  const effect = (outputs = [], inputs = []) => ({ outputs: outputs.map(o => o.cm), nullifiers: inputs.map(o => o.nf) });
  function checkpoint(ctx, sequence, at, records = [], effects = [], zeroSupply = false, importedNullifiers = []) {
    const tree = new NoteTree(), spent = new RadixSpentSet();
    for (const nf of new Set(importedNullifiers)) spent.insert(fieldToBytes(nf));
    let history = codec.genesisHistoryHash(ctx.id), evidence = codec.genesisEvidenceHash(ctx.id);
    records.forEach((record, i) => {
      tree.appendAll(effects[i].outputs);
      for (const nf of effects[i].nullifiers) if (!spent.has(fieldToBytes(nf))) spent.insert(fieldToBytes(nf));
      history = codec.nextHistoryHash(history, codec.statementHash(record), tree.root(), spent.root(), BigInt(i) + 1n);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n);
    });
    const snapshots = ctx.entries.map(({ backing }) => codec.snapshotBytes({ backing, segment: ctx.id,
      historyHash: history, evidenceHash: evidence, issued: zeroSupply ? 0n : same(backing, x) ? 10n : 20n, burned: 0n }));
    const directory = ctx.entries.map(({ backing }, i) => ({ name: backing, digest: hash(snapshots[i]) }));
    return { ctx, at, records, effects, importedNullifiers, snapshots, directory, tree, spent, commitment: signCommitment(operatorSecret, sequence, directoryRoot(directory)),
      trail: codec.encodeTrail({ header: ctx.header, terms: ctx.entries.map(({ backing }) => backings.find(t => same(t.backing, backing)).signed),
        records: records.map(codec.encodeRecord) }, LIMITS) };
  }
  const publication = (backing, at, kind, record) => ({ backing, at, bytes: codec.encodePublication({ domain, backing, kind, record }) });
  function compose(checkpoints, chosen, publications = [], backing = x, at = chosen.at) {
    const record = new FixtureVenue(venue, at, 2n);
    const events = [...checkpoints.map(cp => ({ at: cp.at, kind: 1, subject: operator, bytes: encodeCommitment(cp.commitment) })),
      ...publications.map(p => ({ at: p.at, kind: 4, subject: p.backing, bytes: p.bytes }))];
    events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    for (const e of events) record.witness(e.kind, e.subject, e.at, e.bytes);
    const snapshot = chosen.snapshots.find(s => same(codec.decodeSnapshot(s).backing, backing));
    const rest = checkpoints.filter(cp => cp !== chosen);
    return { selection: { domain, venue, backing, operator, sequence: chosen.commitment.sequence, root: chosen.commitment.root,
      judgingIndex: at, mode: "current-fixture" }, package: { configuration: configurationBytes,
      commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
      directories: distinct([chosen.directory, ...rest.map(cp => cp.directory)], directoryRoot).slice(1), snapshot,
      snapshots: distinct([snapshot, ...checkpoints.flatMap(cp => cp.snapshots)], s => s).slice(1),
      trail: chosen.trail, trails: distinct([chosen.trail, ...rest.map(cp => cp.trail)], s => s).slice(1) }, venue: record.export() };
  }
  const accepted = async payload => {
    const answer = await replayLocalPackage(payload, verifier, codec);
    assert.equal(answer.status, "selected-local-replay", JSON.stringify(answer)); return answer;
  };
  const refused = async (payload, status = "invalid-local-replay", check, v = verifier) => {
    const answer = await replayLocalPackage({ ...payload, seed: issuerSeed }, v, codec);
    assert.equal(answer.status, status, JSON.stringify(answer));
    if (check !== undefined) assert.equal(answer.check, check);
    assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false);
    return answer;
  };
  const assertPaths = answer => {
    for (const c of answer.candidates) assert.equal(notePathProves(BigInt(c.anchor), BigInt(c.cm),
      { siblings: c.siblings.map(BigInt), right: c.right }), true);
  };

  const shared = segment(1n, [entry(x), entry(y)]);
  const fundedX = output(x, payerSeed, 189, 10n), fundedY = output(y, payerSeed, 190, 20n);
  const ix = await issue(shared, fundedX, "recovery scope issue x"), iy = await issue(shared, fundedY, "recovery scope issue y");
  const a0 = checkpoint(shared, 1n, 1n, [], [], true);
  const a1 = checkpoint(shared, 2n, 2n, [ix, iy], [effect([fundedX]), effect([fundedY])]);
  const intrinsicCases = await checkSharedIntrinsic({ codec, verifier, test, operatorSecret, issuerSecret, issuerSecretY,
    payerSeed, x, y, shared, a0, a1, issuanceX: ix, issuanceY: iy, effects: [effect([fundedX]), effect([fundedY])], checkpoint,
    compose: (checkpoints, chosen, backing, at) => compose(checkpoints, chosen, [], backing, at), silence: true });
  const splitX = segment(3n, [entry(x, a1)]), splitY = segment(4n, [entry(y, a1)]);
  const x0 = checkpoint(splitX, 3n, 3n), y0 = checkpoint(splitY, 4n, 4n);
  await test("compact shared rejoin retains independent silence predecessors and spent holdings", async () => {
    const reunited = segment(5n, [entry(x, x0), entry(y, y0)]), opened = checkpoint(reunited, 5n, 6n);
    const outputs = [output(x, receiverSeed, 201, 6n), output(x, payerSeed, 202, 4n),
      output(x, payerSeed, 203, 0n), output(x, payerSeed, 204, 0n)];
    const payment = await spend(reunited, fundedX, 0n, a1.tree, outputs, "shared compact silence rejoin payment");
    const effects = [effect(outputs, payment.inputs)];
    const valid = checkpoint(reunited, 6n, 7n, [payment.record], effects);
    const bad = structuredClone(payment.record); bad.proof[100] ^= 1;
    const target = checkpoint(reunited, 7n, 8n, [bad], effects);
    const repaired = checkpoint(reunited, 8n, 8n, [payment.record], effects);
    const ancestry = [a0, a1, x0, y0, opened, valid, target, repaired];
    for (const selected of [x, y]) {
      const complete = { ...compose(ancestry, repaired, [], selected, 9n), seed: payerSeed };
      const partial = withholdSharedTarget(complete, target, [bad], 1n, x, codec);
      const result = await sharedEquivalent(complete, partial, verifier, codec);
      assert.deepEqual(result.candidates.map(c => c.cm), [same(selected, x) ? outputs[1].cm.toString() : fundedY.cm.toString()]);
      assert.equal(result.audit.range.clock.snapshotIndex, "8"); assert.equal(result.audit.range.clock.boundary, null);
      intrinsicCases.push({ payload: partial, result });
      // valid and repaired deliberately share complete bytes; the selected
      // envelope itself still supplies valid, so it cannot be withheld here.
      const segmentOf = bytes => createHash("sha256").update(codec.decodeTrail(bytes, LIMITS).header).digest();
      for (const cp of [x0, y0, opened]) {
        const missing = structuredClone(partial);
        missing.package.trails = missing.package.trails.filter(bytes => !same(bytes, cp.trail));
        const unavailable = { ...missing, seed: issuerSeed };
        // pool-v3 §12.1: the selected trail's prefixes serve its own segment's earlier checkpoints.
        if (same(segmentOf(cp.trail), segmentOf(partial.package.trail))) {
          assert.deepEqual(await replayLocalPackage(unavailable, verifier, codec), await replayLocalPackage({ ...partial, seed: issuerSeed }, verifier, codec));
          continue;
        }
        const refusal = await refused(unavailable, "unresolved-evidence");
        if (cp === y0 && same(selected, x)) intrinsicCases.push({ payload: unavailable, result: refusal });
      }
    }
  });
  const dx1 = await demand(splitX, fundedX, 0n, a1.tree, presenterX, 6n, "scope x first gap demand");
  const dy1 = await demand(splitY, fundedY, 1n, a1.tree, presenterY, 6n, "scope y first gap demand");
  const wx = withdrawal(splitX, dx1, presenterX), wy = withdrawal(splitY, dy1, presenterY);
  const dx2 = await demand(splitX, fundedX, 0n, a1.tree, presenterX, 7n, "scope x release demand");
  const dy2 = await demand(splitY, fundedY, 1n, a1.tree, presenterY, 8n, "scope y release demand");
  const sx = await settlement(splitX, dx2, fundedX, 0n, a1.tree, presenterX, 191n, "scope x issuer settlement");
  const sy = await settlement(splitY, dy2, fundedY, 1n, a1.tree, presenterY, 192n, "scope y issuer settlement");
  const publications = [publication(x, 9n, 1, dx1), publication(y, 9n, 1, dy1), publication(x, 10n, 4, wx),
    publication(y, 10n, 4, wy), publication(x, 10n, 1, dx2), publication(y, 11n, 1, dy2),
    publication(x, 11n, 3, sx.record), publication(y, 12n, 3, sy.record)];
  const adoptedRecords = [dx1, dy1, wx, wy, dx2, dy2, sx.record, sy.record];
  const adoptedEffects = adoptedRecords.map(r => r === sx.record ? effect([sx.output], sx.inputs)
    : r === sy.record ? effect([sy.output], sy.inputs) : effect());
  const returnedX = segment(5n, [entry(x, x0)]), returnedY = segment(6n, [entry(y, y0)]);
  const rx = checkpoint(returnedX, 5n, 11n), ry = checkpoint(returnedY, 6n, 12n);
  const joined = segment(7n, [entry(x, rx), entry(y, ry)]), j0 = checkpoint(joined, 7n, 12n);
  const adopted = checkpoint(joined, 8n, 13n, adoptedRecords, adoptedEffects);
  const paid = output(x, receiverSeed, 193, 7n), change = output(x, issuerSeed, 194, 3n);
  const outputs = [paid, change, output(x, issuerSeed, 195, 0n), output(x, issuerSeed, 196, 0n)];
  const payment = await spend(joined, sx.output, 0n, adopted.tree, outputs, "scope joined issuer note continuation");
  const final = checkpoint(joined, 9n, 14n, [...adoptedRecords, payment.record], [...adoptedEffects, effect(outputs, payment.inputs)]);
  const ancestry = [a0, a1, x0, y0, rx, ry, j0];
  const payload = compose([...ancestry, adopted, final], final, publications);
  const payloadY = compose([...ancestry, adopted, final], final, publications, y);
  // The joined segment's adopted block occupies positions 1–8 (C2b.4.2).
  await test("shared compact faults exclude a target after the adopted block and refuse targets inside it", async () => {
    const bad = structuredClone(payment.record); bad.proof[100] ^= 1;
    const records = [...adoptedRecords, bad], effects = [...adoptedEffects, effect(outputs, payment.inputs)];
    const target = checkpoint(joined, 9n, 14n, records, effects);
    const complete = { ...compose([...ancestry, adopted, target], adopted, publications, y, 14n), seed: issuerSeed };
    for (const anchor of [x, y]) {
      const partial = withholdSharedTarget(complete, target, records, 9n, anchor, codec);
      const result = await sharedEquivalent(complete, partial, verifier, codec);
      assert.equal(result.audit.range.carrying.find(c => c.sequence === "9").class, "excluded");
      assert.equal(result.audit.records, "8"); assert.deepEqual(result.candidates.map(c => c.cm), [sy.output.cm.toString()]);
      intrinsicCases.push({ payload: partial, result });
    }
    const inside = structuredClone(sy.record); inside.proof[100] ^= 1;
    const insideRecords = [...adoptedRecords.slice(0, 7), inside, payment.record];
    const insideTarget = checkpoint(joined, 9n, 14n, insideRecords, effects);
    const insideComplete = compose([...ancestry, adopted, insideTarget], adopted, publications, y, 14n);
    const full = await accepted(insideComplete);
    assert.equal(full.audit.range.carrying.find(c => c.sequence === "9").check, "ADOPTION");
    const partial = withholdSharedTarget(insideComplete, insideTarget, insideRecords, 8n, x, codec);
    const input = { ...partial, seed: issuerSeed };
    const result = await refused(input, "unresolved-evidence");
    assert.equal(result.faultEvidence.some(f => f.check === "PROOF" && f.position === "8"), true);
    intrinsicCases.push({ payload: input, result });
  });
  const issuerPayload = compose([...ancestry, adopted], adopted, publications);
  const issuerPayloadY = compose([...ancestry, adopted], adopted, publications, y);
  let result, resultY, receiver, issuerRestored, issuerRestoredY;
  await test("scope recovery adopts the ordered union from distinct original-prefix silence clocks", async () => {
    result = await accepted(payload); resultY = await accepted(payloadY);
    for (const [answer, issued] of [[result, "10"], [resultY, "20"]]) {
      assert.equal(answer.audit.records, "9"); assert.equal(answer.audit.issued, issued);
      assert.equal(answer.audit.burned, "0"); assert.equal(answer.audit.outstanding, issued);
      assert.equal(answer.audit.noteRoot, final.tree.root().toString()); assert.equal(answer.audit.spentRoot, hex(final.spent.root()));
    }
    assert.equal(result.audit.historyHash, resultY.audit.historyHash);
  });
  await test("scope recovery restores both issuer settlement notes and continues by spending one", async () => {
    issuerRestored = await accepted({ ...issuerPayload, seed: issuerSeed });
    issuerRestoredY = await accepted({ ...issuerPayloadY, seed: issuerSeed });
    for (const [answer, settled] of [[issuerRestored, sx.output], [issuerRestoredY, sy.output]]) {
      assert.deepEqual(answer.candidates.map(c => [c.cm, c.nf, c.value]), [[settled.cm.toString(), settled.nf.toString(), settled.opening.value.toString()]]);
      assertPaths(answer);
    }
    receiver = await accepted({ ...payload, seed: receiverSeed });
    assert.deepEqual(receiver.candidates.map(c => [c.cm, c.value]), [[paid.cm.toString(), "7"]]); assertPaths(receiver);
    const issuerAfter = await accepted({ ...payload, seed: issuerSeed });
    assert.deepEqual(issuerAfter.candidates.map(c => [c.cm, c.value]), [[change.cm.toString(), "3"]]); assertPaths(issuerAfter);
    const otherAfter = await accepted({ ...payloadY, seed: issuerSeed });
    assert.deepEqual(otherAfter.candidates.map(c => c.cm), [sy.output.cm.toString()]); assertPaths(otherAfter);
  });
  await test("scoped clocks scan each backing's held checkpoints once and each publication is charged once", async () => {
    // Later checkpoints of the joined segment repeat final's state; each resumes and adds no position.
    const repeats = count => Array.from({ length: count }, (_, i) =>
      ({ ...final, commitment: signCommitment(operatorSecret, 10n + BigInt(i), directoryRoot(final.directory)) }));
    // The selection names the scope's first backing, under which the parent descent classifies each predecessor.
    const variant = (count, extra = []) => {
      const later = repeats(count);
      return compose([...ancestry, adopted, final, ...later], later.at(-1) ?? final, [...publications, ...extra], joined.entries[0].backing);
    };
    const status = async (input, maxEvents) =>
      (await replayLocalPackage(input, { ...verifier, importLimits: { maxCheckpoints: 128n, maxEvents } }, codec)).status;
    // The smallest reader-selected event budget under which the read completes.
    const smallest = async input => {
      let low = 0n, high = 4096n;
      assert.equal(await status(input, high), "selected-local-replay");
      while (low < high) { const mid = (low + high) / 2n; if (await status(input, mid) === "selected-local-replay") high = mid; else low = mid + 1n; }
      return low;
    };
    const exact = async (input, budget) => {
      assert.equal(await status(input, budget), "selected-local-replay");
      assert.equal(await status(input, budget - 1n), "resource-refusal");
    };
    const base = await smallest(variant(0)), step = await smallest(variant(1)) - base;
    // Each later checkpoint adds one held index to each backing's clock scan and nothing else.
    assert.equal(step, 2n);
    await exact(variant(3), base + 3n * step);
    // An undecodable publication is charged once, however many forces, clocks and counts read it.
    await exact(variant(0, [{ backing: x, at: 5n, bytes: new Uint8Array(92) }]), base + 1n);
  });
  await test("scope adoption rejects omitted reordered and changed proof bytes on the unselected backing", async () => {
    const reproof = (await settlement(splitY, dy2, fundedY, 1n, a1.tree, presenterY, 192n,
      "scope y alternative valid settlement proof")).record;
    assert.equal(same(codec.statementBytes(reproof), codec.statementBytes(sy.record)), true);
    assert.equal(same(reproof.proof, sy.record.proof), false);
    const variants = [adoptedRecords.slice(0, -1), [dy1, dx1, ...adoptedRecords.slice(2)], [...adoptedRecords.slice(0, -1), reproof]];
    for (const records of variants) {
      const effects = records.map(r => r.kind === 6 ? (same(codec.statementHash(r), codec.statementHash(sx.record))
        ? effect([sx.output], sx.inputs) : effect([sy.output], sy.inputs)) : effect());
      const bad = checkpoint(joined, 8n, 13n, records, effects);
      await refused(compose([...ancestry, bad], bad, publications), "invalid-local-replay", "ADOPTION");
    }
  });
  await test("scope recovery checks the other issuer and requires its complete publication range", async () => {
    const bad = structuredClone(sy.record), acceptance = codec.settlementAuthorization(bad).acceptance;
    const wrongIssuerSignature = ed25519.sign(codec.acceptanceBytes(acceptance), issuerSecret);
    bad.authorization.set(wrongIssuerSignature, 8);
    // Keep the presenter's release valid for the changed acceptance, isolating
    // the requirement to use y's issuer even when the wallet selected x.
    const changedAcceptance = { ...acceptance, signature: wrongIssuerSignature };
    bad.authorization.set(ed25519.sign(codec.releaseBytes(domain, codec.statementHash(dy2),
      codec.acceptanceId(changedAcceptance), codec.statementHash(bad)), presenterY), 72);
    const wrongPublications = [...publications.slice(0, -1), publication(y, 12n, 3, bad)];
    await refused(compose([...ancestry, adopted], adopted, wrongPublications), "invalid-local-replay");
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: request => request.kind === 4 && same(request.subject, y) ? undefined : record.range(request) }; } };
    await refused(payload, "unresolved-evidence", undefined, unavailable);
    const missing = structuredClone(payload);
    missing.package.snapshots = missing.package.snapshots.filter(bytes => !ry.snapshots.some(s => same(s, bytes)));
    await refused(missing, "unresolved-evidence");
  });
  let lapse;
  await test("one silent backing lapses an old shared scope even while selecting the other backing", async () => {
    // At8 x's last valid checkpoint3 is silent, while y's checkpoint4
    // remains inside its duration. Either backing lapses the whole scope.
    const stale = checkpoint(shared, 10n, 8n, [ix, iy], [effect([fundedX]), effect([fundedY])]);
    await refused(compose([a0, a1, x0, y0, stale], stale, [], y), "lapsed-selection");
    const badProof = structuredClone(iy); badProof.proof[100] ^= 1;
    const faulty = checkpoint(shared, 10n, 8n, [ix, badProof], [effect([fundedX]), effect([fundedY])]);
    const before = compose([a0, a1, x0, y0, faulty], y0, [], y, 8n);
    const partialFault = withholdSharedTarget(before, faulty, [ix, badProof], 2n, y, codec);
    const lapsed = await sharedEquivalent(before, partialFault, verifier, codec);
    assert.equal(lapsed.audit.range.carrying.find(c => c.sequence === "10").class, "lapsed");
    intrinsicCases.push({ payload: partialFault, result: lapsed });
    const missingX = structuredClone(partialFault);
    missingX.package.trails = missingX.package.trails.filter(bytes => !same(bytes, x0.trail));
    await refused(missingX, "unresolved-evidence");
    const historical = checkpoint(shared, 10n, 15n, [ix, iy], [effect([fundedX]), effect([fundedY])]);
    // The valid fresh returns/adoption reset both current clocks. They cannot
    // erase the historical gap which already retired the old shared segment.
    await refused(compose([...ancestry, adopted, final, historical], historical, publications, y), "lapsed-selection");
    const bad = structuredClone(iy); bad.proof[100] ^= 1;
    const withheldTail = checkpoint(shared, 10n, 15n, [ix, bad], [effect([fundedX]), effect([fundedY])]);
    const full = compose([...ancestry, adopted, final, withheldTail], final, publications, y, 15n);
    const answer = await accepted(full);
    full.package.trails = full.package.trails.filter(bytes => !same(bytes, withheldTail.trail));
    assert.deepEqual(await accepted(full), answer);
    lapse = { payload: full, result: answer };
    const partial = { ...withheldTail, directory: withheldTail.directory.filter(e => same(e.name, y)) };
    partial.commitment = signCommitment(operatorSecret, 10n, directoryRoot(partial.directory));
    const incomplete = compose([...ancestry, adopted, final, partial], final, publications, y, 15n);
    incomplete.package.trails = incomplete.package.trails.filter(bytes => !same(bytes, withheldTail.trail));
    assert.deepEqual(await accepted(incomplete), answer);
    const missing = structuredClone(full);
    missing.package.trails = missing.package.trails.filter(bytes => !same(bytes, a1.trail));
    await refused(missing, "unresolved-evidence");
  });
  await test("independent scoped range answers cannot assign one venue position to two publications", async () => {
    const contradictory = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range(request) {
        const bytes = record.range(request);
        if (request.kind !== 4 || !same(request.subject, y) || bytes === undefined) return bytes;
        const answer = codec.decodeRangeAnswer(bytes, request, RANGE_LIMITS);
        return codec.encodeRangeAnswer({ ...answer, entries: answer.entries.map(e => e.index === 9n ? { ...e, ordinal: 0n } : e) }, RANGE_LIMITS);
      } }; } };
    await refused(payload, "unresolved-evidence", undefined, contradictory);
  });
  await test("a shared scope with unequal silence durations is excluded", async () => {
    const terms = codec.encodeRootTerms({ obligor: ed25519.getPublicKey(issuerSecretY), operator, configuration: domain, venue,
      interval: 10n, payout: { thing: "scope unequal silence duration", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: 5n, challengeWindow: 5n } });
    const other = codec.rootTermsName(terms);
    backings.push({ backing: other, signed: { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecretY) } });
    const invalid = checkpoint(segment(1n, [entry(x), entry(other)]), 1n, 1n, [], [], true);
    await refused(compose([invalid], invalid), "invalid-local-replay", "SILENCE_SCOPE");
  });
  await test("same-index shared fresh openings preserve every owed publication byte", async () => {
    const next = segment(8n, [entry(x, j0), entry(y, j0)]), nextOpening = checkpoint(next, 8n, 12n);
    const complete = checkpoint(next, 9n, 13n, adoptedRecords, adoptedEffects);
    const p = compose([...ancestry, nextOpening, complete], complete, publications);
    const answer = await accepted(p);
    assert.equal(answer.audit.records, "8"); assert.equal(answer.audit.spentRoot, hex(adopted.spent.root()));
    const omitted = checkpoint(next, 9n, 13n, adoptedRecords.slice(0, -1), adoptedEffects.slice(0, -1));
    await refused(compose([...ancestry, nextOpening, omitted], omitted, publications), "invalid-local-replay", "ADOPTION");
  });
  let unequal;
  await test("unequal adoption indices retain only each backing's own owed publications", async () => {
    // x adopts through its return index11. y's empty return still owes its
    // publications at9/10/11/12; neither a scalar minimum nor maximum works.
    const xRecords = [dx1, wx, dx2, sx.record], xEffects = [effect(), effect(), effect(), effect([sx.output], sx.inputs)];
    const xAdopted = checkpoint(returnedX, 7n, 12n, xRecords, xEffects);
    const next = segment(8n, [entry(x, xAdopted), entry(y, ry)]);
    const importedNullifiers = sx.inputs.map(o => o.nf);
    const opening = checkpoint(next, 8n, 13n, [], [], false, importedNullifiers);
    const yRecords = [dy1, wy, dy2, sy.record], yEffects = [effect(), effect(), effect(), effect([sy.output], sy.inputs)];
    const complete = checkpoint(next, 9n, 14n, yRecords, yEffects, false, importedNullifiers);
    const ancestors = [a0, a1, x0, y0, rx, ry, xAdopted, opening];
    const p = compose([...ancestors, complete], complete, publications);
    const answer = await accepted(p), restored = await accepted({ ...p, seed: issuerSeed });
    assert.equal(answer.audit.records, "4"); assert.equal(answer.audit.issued, "10");
    assert.deepEqual(restored.candidates.map(c => [c.cm, c.anchor, c.pathScope]),
      [[sx.output.cm.toString(), xAdopted.tree.root().toString(), "replayed-imported-tree-only"]]); assertPaths(restored);
    const other = await accepted({ ...compose([...ancestors, complete], complete, publications, y), seed: issuerSeed });
    assert.equal(other.audit.issued, "20"); assert.deepEqual(other.candidates.map(c => c.cm), [sy.output.cm.toString()]); assertPaths(other);
    for (const [records, effects] of [[yRecords.slice(2), yEffects.slice(2)], [adoptedRecords, adoptedEffects]]) {
      const bad = checkpoint(next, 9n, 14n, records, effects, false, importedNullifiers);
      await refused(compose([...ancestors, bad], bad, publications), "invalid-local-replay", "ADOPTION");
    }
    unequal = { payload: p, result: answer, restored };
  });
  let standing, standingCheckpoints;
  await test("a standing demand survives import and withdrawal while selecting the other backing", async () => {
    const d = await demand(shared, fundedY, 1n, a1.tree, presenterY, 1n, "scope standing ordinary y demand");
    const locked = checkpoint(shared, 3n, 3n, [ix, iy, d], [effect([fundedX]), effect([fundedY]), effect()]);
    const next = segment(4n, [entry(x, locked), entry(y, locked)]), opening = checkpoint(next, 4n, 4n);
    const w = withdrawal(next, d, presenterY), continued = checkpoint(next, 5n, 5n, [w], [effect()]);
    const p = compose([a0, a1, locked, opening, continued], continued);
    const answer = await accepted(p); assert.equal(answer.audit.records, "1");
    const invalid = structuredClone(w); invalid.authorization = ed25519.sign(codec.withdrawalBytes(invalid), presenterX);
    const rejected = checkpoint(next, 5n, 5n, [invalid], [effect()]);
    await refused(compose([a0, a1, locked, opening, rejected], rejected), "invalid-local-replay", "SIGNATURE");
    standing = { payload: p, result: answer };
    standingCheckpoints = { locked, opening, continued };
  });
  await test("isolated recovery merges reject incomparable conflicts in either parent order", async () => {
    // Synthetic event ancestry isolates the merger. This is a conflict probe,
    // not evidence that disjoint canonical scopes can finalize these forks.
    const demandId = hex(codec.statementHash(dx2));
    const event = (record, segment, position, ancestry, tags = [], demand) => ({ identity: hex(codec.statementHash(record)),
      record, segment, position, ancestry: new Map(ancestry), tags, ...(demand === undefined ? {} : { demand }) });
    const parent = events => ({ state: { events: new Map(events), anchors: new Set(), scanOutputs: [], outputPositions: new Map() } });
    const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { check: code }); };
    const merge = parents => mergeFinalizedPrefixes(parents, { codec, check, chargeEvents: () => {} });
    const d = event(dx2, "common", 1n, [], [tagOf(fundedX.nf)], demandId);
    const withdraw = withdrawal(splitX, dx2, presenterX);
    const w = event(withdraw, "left", 1n, [["common", 1n]], [tagOf(fundedX.nf)], demandId);
    const s = event(sx.record, "right", 1n, [["common", 1n]], sx.inputs.map(o => tagOf(o.nf)), demandId);
    const conflictDemand = event(dx1, "left", 1n, [], [tagOf(fundedX.nf)], hex(codec.statementHash(dx1)));
    // The settlement's nullifier effect also serves as a spend conflict. Its
    // source demand belongs to that branch and does not order the other one.
    const conflictSpend = event(sx.record, "right", 1n, [], sx.inputs.map(o => tagOf(o.nf)), demandId);
    for (const parents of [
      [parent([["common:1", d], ["left:1", w]]), parent([["common:1", d], ["right:1", s]])],
      [parent([["left:1", conflictDemand]]), parent([["right:1", conflictSpend]])],
    ]) for (const order of [parents, [...parents].reverse()]) {
      assert.throws(() => merge(order), error => error.check === "RECOVERY_CONFLICT");
    }
    const heldSettlement = await demand(joined, sx.output, 0n, adopted.tree, presenterX, 10n,
      "scope isolated demand against issuer note spend");
    const pending = event(heldSettlement, "pending", 1n, [], [tagOf(sx.output.nf)], hex(codec.statementHash(heldSettlement)));
    const debit = event(payment.record, "debit", 1n, [], payment.inputs.map(o => tagOf(o.nf)));
    const spendConflict = [parent([["pending:1", pending]]), parent([["debit:1", debit]])];
    for (const order of [spendConflict, [...spendConflict].reverse()]) {
      assert.throws(() => merge(order), error => error.check === "RECOVERY_CONFLICT");
    }
    // Expiry never makes two incomparable touches of the same tag compatible.
    const expired = structuredClone(dx1); expired.publicInputs[15] = 1n;
    const expiredEvent = event(expired, "left", 1n, [], [tagOf(fundedX.nf)], hex(codec.statementHash(expired)));
    for (const order of [[parent([["left:1", expiredEvent]]), parent([["right:1", conflictSpend]])],
      [parent([["right:1", conflictSpend]]), parent([["left:1", expiredEvent]])]]) {
      assert.throws(() => merge(order), error => error.check === "RECOVERY_CONFLICT");
    }
    const common = parent([["common:1", d]]), advanced = parent([["common:1", d], ["left:1", w]]);
    for (const order of [[common, advanced], [advanced, common]]) {
      const merged = merge(order); assert.equal(merged.events.size, 2); assert.equal(merged.demands.size, 0);
      assert.equal(merged.effective.size, 2);
    }
    const firstId = hex(codec.statementHash(dx1));
    const first = event(dx1, "earlier", 1n, [], [tagOf(fundedX.nf)], firstId);
    const firstWithdrawal = event(wx, "earlier", 2n, [], [tagOf(fundedX.nf)], firstId);
    const repeated = event(dx2, "later", 1n, [["earlier", 2n]], [tagOf(fundedX.nf)], demandId);
    const repeatedWithdrawal = event(withdraw, "later", 2n, [["earlier", 2n]], [tagOf(fundedX.nf)], demandId);
    const old = parent([["earlier:1", first], ["earlier:2", firstWithdrawal]]);
    const newer = parent([...old.state.events, ["later:1", repeated], ["later:2", repeatedWithdrawal]]);
    for (const order of [[old, newer], [newer, old]]) {
      const merged = merge(order); assert.equal(merged.events.size, 4); assert.equal(merged.demands.size, 0);
      assert.equal(merged.effective.size, 4);
    }
  });
  const receipts = await checkRecoveryScopeReceipts({ codec, verifier, test, operatorSecret, checkpoint, compose,
    x, y, a0, a1, adopted, final, j0, ancestry, publications, payload, payloadY });
  const nonService = await checkRecoveryScopeCounts({ codec, verifier, prove, test, domain, note, operatorSecret,
    compose, publication, x, y, a0, a1, x0, y0, j0, adopted, final, ancestry, publications,
    fundedX, fundedY, sx, standingCheckpoints });
  return { payload, payloadY, result, resultY, receiver, issuerSeed, issuerPayload, issuerPayloadY,
    issuerRestored, issuerRestoredY, standing, unequal, receipts, nonService, lapse, intrinsicCases };
}
