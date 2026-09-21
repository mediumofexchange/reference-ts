// Real-proof C3.3–8 / C2b.3.2 / C2b.4.2 recovery-adoption fixture.
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
import { replayLocalPackage } from "./local-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";
import { compactFault, withoutFaultReasons } from "./fault-check.mjs";
import { checkAuthorizationCase } from "./authorization-check.mjs";
import { checkReceipts } from "./receipt-check.mjs";
import { checkNonService } from "./non-service-check.mjs";

const b = n => new Uint8Array(32).fill(n);
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");
const same = (a, b) => Buffer.compare(a, b) === 0;
const tagOf = nf => poseidon2Hash([1007n, nf]);
const u64 = value => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value, false); return out; };
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))));

export async function checkRecovery({ codec, verifier, configurationBytes, domain, venue, prove, test,
  operatorSecret, issuerSecret, receiverSeed, payerSeed }) {
  const issuerSeed = b(144), presenterOneSecret = b(145), presenterTwoSecret = b(146), ruleSecret = b(147);
  const operator = ed25519.getPublicKey(operatorSecret), issuer = ed25519.getPublicKey(issuerSecret);
  const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue, interval: 10n,
    payout: { thing: "recovery fixture units", quantumExponent: 0, perUnit: 1n },
    replacementRule: ed25519.getPublicKey(ruleSecret), silence: { noCommitmentDuration: 4n, challengeWindow: 5n },
    nonService: { duration: 2n, count: 1n, window: 5n } });
  const backing = codec.rootTermsName(terms);
  const signedTerms = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
  const reference = cp => ({ operator: cp.commitment.operator, sequence: cp.commitment.sequence, root: cp.commitment.root });
  function segment(sequence, opening) {
    const header = codec.segmentBytes({ domain, venue, operator, sequence,
      entries: [{ backing, link: backing, ...(opening === undefined ? {} : { opening }) }] });
    const id = hash(header), scope = new ScopeTree([{ backing, link: backing }]), path = scope.path(0);
    return { header, id, scope, path,
      prefix: [...limbsOf(domain), ...limbsOf(id), scope.root()],
      base: { domain: limbsOf(domain).map(String), segment: limbsOf(id).map(String), scope: scope.root().toString() },
      single: { link: limbsOf(backing).map(String), scope_siblings: path.siblings.map(String), scope_right: [...path.right] } };
  }
  const note = out => ({ backing: limbsOf(backing).map(String), value: out.opening.value.toString(),
    owner: out.opening.owner.toString(), rho: out.opening.rho.toString() });
  const output = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  async function issue(ctx, out, label) {
    const delivery = limbsOf(codec.deliveryHash(domain, [out.cm], [out.capsule]));
    return prove(1, { ...ctx.base, ...ctx.single, backing: limbsOf(backing).map(String), quantity: out.opening.value.toString(),
      cm: out.cm.toString(), owner: out.opening.owner.toString(), rho: out.opening.rho.toString(), delivery: delivery.map(String) },
    [...ctx.prefix, ...limbsOf(backing), out.opening.value, out.cm, ...delivery], [out], label);
  }
  function holding(inputs, positions, tree, paddingAnchor = 0n) {
    const paths = positions.map(position => tree.path(position));
    return { inputs: inputs.map(note), secrets: inputs.map(x => x.secret.toString()),
      anchors: inputs.map((x, i) => x.opening.value === 0n ? paddingAnchor : tree.root()),
      siblings: paths.map(path => path.siblings.map(String)), right: paths.map(path => [...path.right]) };
  }
  async function demand(ctx, input, tree, presenterSecret, instant, deadline, label) {
    const pad = output(payerSeed, 148 + Number(instant), 0n), held = holding([input, pad], [0n, 0n], tree);
    const tags = [tagOf(input.nf), 0n], presenter = ed25519.getPublicKey(presenterSecret);
    const publicInputs = [...ctx.prefix, ...limbsOf(backing), input.opening.value,
      ...held.anchors, ...tags, ...limbsOf(presenter), instant, deadline];
    return prove(4, { ...ctx.base, ...ctx.single, inputs: held.inputs, secrets: held.secrets,
      anchors: held.anchors.map(String), siblings: held.siblings, right: held.right,
      backing: limbsOf(backing).map(String), quantity: input.opening.value.toString(), tags: tags.map(String),
      presenter: limbsOf(presenter).map(String), instant: instant.toString(), deadline: deadline.toString() },
    publicInputs, [], label);
  }
  function withdrawal(ctx, demandRecord, presenterSecret, valid = true) {
    const record = { domain, kind: 5, publicInputs: [...ctx.prefix, ...limbsOf(codec.statementHash(demandRecord))],
      proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] };
    record.authorization = ed25519.sign(codec.withdrawalBytes(record), valid ? presenterSecret : b(199));
    return record;
  }
  async function settlement(ctx, demandRecord, inputs, tree, presenterSecret, acceptanceDeadline, rho, label) {
    const demandId = codec.statementHash(demandRecord);
    const secret = deriveSettlementOwnerSecret(issuerSeed, domain, demandId, acceptanceDeadline).value;
    const opening = { backing, value: inputs[0].opening.value, owner: ownerOf(secret), rho };
    const settled = { secret, opening, cm: commitmentOf(domain, opening) };
    settled.nf = nullifierOf(domain, settled.cm, secret);
    const held = holding(inputs, [0n, 0n], tree, tree.root()), publicInputs = [...ctx.prefix, ...limbsOf(backing), opening.value,
      opening.owner, opening.rho, ...held.anchors, ...inputs.map(x => x.nf), settled.cm, ...limbsOf(demandId)];
    const record = await prove(6, { ...ctx.base, ...ctx.single, inputs: held.inputs, secrets: held.secrets,
      siblings: held.siblings, right: held.right, anchors: held.anchors.map(String),
      backing: limbsOf(backing).map(String), quantity: opening.value.toString(), owner: opening.owner.toString(),
      rho_out: opening.rho.toString(), nullifiers: inputs.map(x => x.nf.toString()), cm_out: settled.cm.toString(),
      demand: limbsOf(demandId).map(String) }, publicInputs, [], label);
    const acceptance = { domain, demand: demandId, owner: opening.owner, deadline: acceptanceDeadline };
    const acceptanceSignature = ed25519.sign(codec.acceptanceBytes(acceptance), issuerSecret);
    const signedAcceptance = { ...acceptance, signature: acceptanceSignature };
    const release = codec.releaseBytes(domain, demandId, codec.acceptanceId(signedAcceptance), codec.statementHash(record));
    record.authorization = concat(u64(acceptanceDeadline), acceptanceSignature, ed25519.sign(release, presenterSecret));
    return { record, output: settled };
  }
  async function spend(ctx, input, tree, outputs, label) {
    const pad = output(payerSeed, 170, 0n), held = holding([input, pad], [0n, 0n], tree, tree.root());
    const delivery = limbsOf(codec.deliveryHash(domain, outputs.map(x => x.cm), outputs.map(x => x.capsule)));
    return prove(2, { ...ctx.base, inputs: held.inputs, secrets: held.secrets, anchors: held.anchors.map(String),
      nullifiers: [input.nf, pad.nf].map(String), siblings: held.siblings, right: held.right,
      links: [ctx.single.link, ctx.single.link], scope_siblings: [ctx.single.scope_siblings, ctx.single.scope_siblings],
      scope_right: [ctx.single.scope_right, ctx.single.scope_right], output_notes: outputs.map(note),
      outputs: outputs.map(x => x.cm.toString()), delivery: delivery.map(String) },
    [...ctx.prefix, ...held.anchors, input.nf, pad.nf, ...outputs.map(x => x.cm), ...delivery], outputs, label);
  }
  function checkpoint(ctx, sequence, at, records, effects, issued) {
    const tree = new NoteTree(), spent = new RadixSpentSet();
    let history = codec.genesisHistoryHash(ctx.id), evidence = codec.genesisEvidenceHash(ctx.id);
    records.forEach((record, i) => {
      tree.appendAll(effects[i].outputs);
      effects[i].nullifiers.forEach(nf => { if (!spent.has(fieldToBytes(nf))) spent.insert(fieldToBytes(nf)); });
      const position = BigInt(i) + 1n;
      history = codec.nextHistoryHash(history, codec.statementHash(record), tree.root(), spent.root(), position);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), position);
    });
    const snapshot = codec.snapshotBytes({ backing, segment: ctx.id, historyHash: history, evidenceHash: evidence, issued, burned: 0n });
    const directory = [{ name: backing, digest: hash(snapshot) }];
    return { at, ctx, sequence, records, effects, snapshot, directory, tree, spent,
      commitment: signCommitment(operatorSecret, sequence, directoryRoot(directory)),
      trail: codec.encodeTrail({ header: ctx.header, terms: [signedTerms], records: records.map(codec.encodeRecord) }, LIMITS) };
  }
  const publication = (at, kind, record) => ({ at, bytes: codec.encodePublication({ domain, backing, kind, record }) });
  const distinct = (values, bytes) => values.filter((value, i) => values.findIndex(other => same(bytes(value), bytes(other))) === i);
  function compose(checkpoints, chosen, publications, witnessedIndex = chosen.at) {
    const record = new FixtureVenue(venue, witnessedIndex, 2n), events = [
      ...checkpoints.map(cp => ({ at: cp.at, kind: 1, subject: operator, bytes: encodeCommitment(cp.commitment) })),
      ...publications.map(p => ({ at: p.at, kind: 4, subject: backing, bytes: p.bytes })),
    ];
    events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    events.forEach(event => record.witness(event.kind, event.subject, event.at, event.bytes));
    const rest = checkpoints.filter(cp => cp !== chosen);
    return { selection: { domain, venue, backing, operator, sequence: chosen.sequence, root: chosen.commitment.root,
      judgingIndex: witnessedIndex, mode: "current-fixture" },
    package: { configuration: configurationBytes, commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
      directories: distinct([chosen.directory, ...rest.map(cp => cp.directory)], directoryRoot).slice(1),
      snapshot: chosen.snapshot, snapshots: distinct([chosen.snapshot, ...rest.map(cp => cp.snapshot)], x => x).slice(1),
      trail: chosen.trail, trails: distinct([chosen.trail, ...rest.map(cp => cp.trail)], x => x).slice(1) }, venue: record.export() };
  }
  async function reject(payload, check, status = "invalid-local-replay") {
    const answer = await replayLocalPackage(payload, verifier, codec);
    assert.equal(answer.status, status); assert.equal(answer.check, status === "invalid-local-replay" ? check : null);
    assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []); assert.equal(answer.spendable, false);
  }

  // The original snapshot at index 2 is the last valid checkpoint before the
  // duration-four gap opens at index 7.
  const original = segment(1n), funded = output(payerSeed, 149, 10n), issuance = await issue(original, funded, "recovery issue 10");
  const originalOpening = checkpoint(original, 1n, 1n, [], [], 0n);
  const originalTree = new NoteTree(); originalTree.append(funded.cm);
  const originalState = checkpoint(original, 2n, 2n, [issuance], [{ outputs: [funded.cm], nullifiers: [] }], 10n);
  const firstDemand = await demand(original, funded, originalTree, presenterOneSecret, 5n, 20n, "gap demand then withdrawal");
  const firstWithdrawal = withdrawal(original, firstDemand, presenterOneSecret);
  const secondDemand = await demand(original, funded, originalTree, presenterTwoSecret, 6n, 20n, "gap demand then release");
  const pad = output(payerSeed, 150, 0n);
  const released = await settlement(original, secondDemand, [funded, pad], originalTree, presenterTwoSecret, 18n, 151n,
    "gap settlement pays issuer-owned output");
  const adoptedRecords = [firstDemand, firstWithdrawal, secondDemand, released.record];
  const adoptedEffects = [{ outputs: [], nullifiers: [] }, { outputs: [], nullifiers: [] },
    { outputs: [], nullifiers: [] }, { outputs: [released.output.cm], nullifiers: [funded.nf, pad.nf] }];
  const publications = [publication(8n, 1, firstDemand), publication(8n, 4, firstWithdrawal),
    publication(9n, 1, secondDemand), publication(10n, 3, released.record)];
  const returned = segment(3n, reference(originalState));
  const returnOpening = checkpoint(returned, 3n, 11n, [], [], 10n);
  const adopted = checkpoint(returned, 4n, 12n, adoptedRecords, adoptedEffects, 10n);
  const paid = output(receiverSeed, 152, 7n), change = output(issuerSeed, 153, 3n);
  const zeroOne = output(payerSeed, 154, 0n), zeroTwo = output(payerSeed, 155, 0n);
  const localSettlementTree = new NoteTree(); localSettlementTree.append(released.output.cm);
  const payment = await spend(returned, released.output, localSettlementTree, [paid, change, zeroOne, zeroTwo],
    "returned segment pays settlement output");
  const finalRecords = [...adoptedRecords, payment], finalEffects = [...adoptedEffects,
    { outputs: [paid.cm, change.cm, zeroOne.cm, zeroTwo.cm], nullifiers: [released.output.nf, output(payerSeed, 170, 0n).nf] }];
  const finalCheckpoint = checkpoint(returned, 5n, 13n, finalRecords, finalEffects, 10n);
  const ancestry = [originalOpening, originalState, returnOpening, adopted, finalCheckpoint];
  const payload = compose(ancestry, finalCheckpoint, publications, 13n);
  const authorizations = [], intrinsicCases = [];
  // The returned segment's adopted block occupies positions 1–4 (C2b.4.2).
  const withheld = (checkpoints, chosen, target, records, position, at) => {
    const complete = compose([...checkpoints, target], chosen, publications, at);
    const partial = structuredClone(complete);
    partial.package.trails = partial.package.trails.filter(bytes => !same(bytes, target.trail));
    partial.package.faults = [compactFault(target.snapshot, records, position, codec)];
    return { complete, partial };
  };
  const equivalent = async (complete, partial, classes) => {
    const result = await replayLocalPackage(partial, verifier, codec);
    assert.equal(result.status, "selected-local-replay", JSON.stringify(result)); assert.equal(result.spendable, false);
    assert.deepEqual(result.audit.range.carrying.map(c => c.class), classes);
    assert.equal(result.audit.range.carrying.at(-1).check, "PROOF");
    const { faultEvidence, ...state } = result;
    assert.equal(faultEvidence.some(f => f.check === "PROOF" && f.position === "5"), true);
    const full = await replayLocalPackage(complete, verifier, codec);
    assert.equal(full.audit.range.carrying.at(-1).class, "excluded");
    assert.deepEqual(withoutFaultReasons(state), withoutFaultReasons(full));
    return result;
  };
  await test("compact proof faults exclude a target after the adopted block and agree with its complete trail", async () => {
    const records = structuredClone(finalRecords); records[4].proof[100] ^= 1;
    const target = checkpoint(returned, 5n, 13n, records, finalEffects, 10n);
    const { complete, partial } = withheld(ancestry.slice(0, 4), adopted, target, records, 5n, 13n);
    const result = await equivalent(complete, partial, ["valid", "valid", "valid", "valid", "excluded"]);
    assert.equal(result.audit.records, "4");
    intrinsicCases.push({ payload: partial, result });
    // A compact record cannot stand in for the kind-4 range every silence-bearing
    // read requires; the receipt walk's lazily read range is checked in receipt-check.
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: request => request.kind === 4 ? undefined : record.range(request) }; } };
    const refused = await replayLocalPackage(partial, unavailable, codec);
    assert.equal(refused.status, "unresolved-evidence"); assert.equal(refused.audit, null);
  });
  await test("the first continuation after a return excludes a compact fault after its block from the opening alone", async () => {
    const records = structuredClone(finalRecords); records[4].proof[100] ^= 1;
    const target = checkpoint(returned, 4n, 12n, records, finalEffects, 10n);
    const { complete, partial } = withheld(ancestry.slice(0, 3), returnOpening, target, records, 5n, 12n);
    const result = await equivalent(complete, partial, ["valid", "valid", "valid", "excluded"]);
    assert.equal(result.audit.records, "0");
    intrinsicCases.push({ payload: partial, result });
  });
  await test("compact faults inside the adopted block are unsupported and refuse without ordinary evidence", async () => {
    const wrongIssue = structuredClone(issuance);
    wrongIssue.authorization = ed25519.sign(codec.statementBytes(wrongIssue), b(199));
    for (const [position, substitute, check] of [[4n, undefined, "PROOF"], [1n, wrongIssue, "SIGNATURE"]]) {
      const records = structuredClone(finalRecords), effects = structuredClone(finalEffects);
      if (substitute === undefined) records[Number(position - 1n)].proof[100] ^= 1;
      else { records[Number(position - 1n)] = substitute; effects[Number(position - 1n)] = { outputs: [funded.cm], nullifiers: [] }; }
      const target = checkpoint(returned, 5n, 13n, records, effects, 10n);
      const { complete, partial } = withheld(ancestry.slice(0, 4), adopted, target, records, position, 13n);
      const full = await replayLocalPackage(complete, verifier, codec);
      assert.equal(full.status, "selected-local-replay");
      assert.equal(full.audit.range.carrying.at(-1).check, "ADOPTION");
      const result = await replayLocalPackage(partial, verifier, codec);
      assert.equal(result.status, "unresolved-evidence"); assert.equal(result.audit, null);
      assert.deepEqual(result.candidates, []); assert.equal(result.spendable, false);
      assert.equal(result.faultEvidence.some(f => f.check === check && f.position === position.toString()), true);
      intrinsicCases.push({ payload: partial, result });
    }
  });
  await test("an after-block fault record excludes beside an ignored inside-block record and never crosses checkpoints", async () => {
    const records = structuredClone(finalRecords); records[3].proof[100] ^= 1; records[4].proof[100] ^= 1;
    const target = checkpoint(returned, 5n, 13n, records, finalEffects, 10n);
    const { complete, partial } = withheld(ancestry.slice(0, 4), adopted, target, records, 5n, 13n);
    const faults = [compactFault(target.snapshot, records, 4n, codec), partial.package.faults[0]];
    for (const order of [faults, [...faults].reverse()]) {
      const supplied = { ...partial, package: { ...partial.package, faults: order } };
      const result = await equivalent(complete, supplied, ["valid", "valid", "valid", "valid", "excluded"]);
      assert.deepEqual(result.faultEvidence.map(f => f.position).sort(), ["4", "5"]);
      intrinsicCases.push({ payload: supplied, result });
    }
    // Two withheld continuations: the inside-block one stays unresolved whichever
    // sequence carries it, so the other's after-block fact rescues nothing.
    const inside = structuredClone(finalRecords); inside[3].proof[100] ^= 1;
    const after = structuredClone(finalRecords); after[4].proof[100] ^= 1;
    for (const [firstRecords, firstPosition, secondRecords, secondPosition] of
      [[inside, 4n, after, 5n], [after, 5n, inside, 4n]]) {
      const first = checkpoint(returned, 5n, 13n, firstRecords, finalEffects, 10n);
      const second = checkpoint(returned, 6n, 14n, secondRecords, finalEffects, 10n);
      const crossed = compose([...ancestry.slice(0, 4), first, second], adopted, publications, 14n);
      crossed.package.trails = crossed.package.trails.filter(bytes => !same(bytes, first.trail) && !same(bytes, second.trail));
      crossed.package.faults = [compactFault(first.snapshot, firstRecords, firstPosition, codec),
        compactFault(second.snapshot, secondRecords, secondPosition, codec)];
      const result = await replayLocalPackage(crossed, verifier, codec);
      assert.equal(result.status, "unresolved-evidence"); assert.equal(result.audit, null); assert.deepEqual(result.candidates, []);
      intrinsicCases.push({ payload: crossed, result });
    }
  });
  for (const variant of ["withdrawal", "acceptance", "release", "both"]) {
    const withdrawing = variant === "withdrawal", demandRecord = withdrawing ? firstDemand : secondDemand;
    const good = withdrawing ? firstWithdrawal : released.record, bad = structuredClone(good);
    if (withdrawing) bad.authorization = ed25519.sign(codec.withdrawalBytes(good), b(199));
    else {
      const messages = codec.settlementAuthorization(good);
      if (variant !== "release") bad.authorization.set(ed25519.sign(messages.acceptanceMessage, b(199)), 8);
      if (variant !== "acceptance") bad.authorization.set(ed25519.sign(messages.releaseMessage, b(199)), 72);
    }
    const records = [issuance, demandRecord, bad], effects = [{ outputs: [funded.cm], nullifiers: [] }, { outputs: [], nullifiers: [] },
      withdrawing ? { outputs: [], nullifiers: [] } : { outputs: [released.output.cm], nullifiers: [funded.nf, pad.nf] }];
    const invalid = checkpoint(original, 3n, 5n, records, effects, 10n);
    const complete = compose([originalOpening, originalState, invalid], originalState, [], 5n), partial = structuredClone(complete);
    partial.package.trails = partial.package.trails.filter(bytes => !same(bytes, invalid.trail));
    partial.package.faults = [compactFault(invalid.snapshot, records, 3n, codec)];
    const preimage = codec.decodeFaultEvidence(compactFault(invalid.snapshot, records, 2n, codec), 1024n);
    preimage.previous[0] ^= 1; // No authenticated demand opening is required for the named preimage.
    const expectedRole = variant === "both" ? "acceptance" : variant;
    authorizations.push(await checkAuthorizationCase({ label: variant, payload: partial, complete,
      validAuthorization: good.authorization, expectedRole, extraRoles: variant === "both" ? ["release"] : [],
      expectedSigner: ed25519.getPublicKey(expectedRole === "acceptance" ? issuerSecret : withdrawing ? presenterOneSecret : presenterTwoSecret),
      demandEvidence: codec.encodeFaultEvidence(preimage, 1024n), codec, verifier, test, operatorSecret, intrinsicProof: true }));
  }
  let result, receiver, issuerRestored, issuerPayload;
  await test("forced demand, withdrawal, demand and release adopt in exact venue order before returned service", async () => {
    result = await replayLocalPackage(payload, verifier, codec);
    receiver = await replayLocalPackage({ ...payload, seed: receiverSeed }, verifier, codec);
    assert.equal(result.status, "selected-local-replay"); assert.deepEqual(result.audit, receiver.audit);
    assert.equal(result.audit.records, "5"); assert.equal(result.audit.issued, "10"); assert.equal(result.audit.burned, "0");
    assert.equal(result.audit.outstanding, "10");
    assert.deepEqual(receiver.candidates.map(x => [x.cm, x.value]), [[paid.cm.toString(), "7"]]);
    const path = receiver.candidates[0];
    assert.equal(notePathProves(BigInt(path.anchor), BigInt(path.cm), { siblings: path.siblings.map(BigInt), right: path.right }), true);
  });
  await test("the issuer seed restores the public settlement note before its ordinary spend", async () => {
    issuerPayload = compose(ancestry.slice(0, 4), adopted, publications, 12n);
    issuerRestored = await replayLocalPackage({ ...issuerPayload, seed: issuerSeed }, verifier, codec);
    assert.equal(issuerRestored.status, "selected-local-replay");
    assert.deepEqual(issuerRestored.candidates.map(x => [x.cm, x.nf, x.value]),
      [[released.output.cm.toString(), released.output.nf.toString(), "10"]]);
  });
  await test("omitted, reordered and substituted forced records invalidate the continuation atomically", async () => {
    const variants = [
      publications.filter((_, i) => i !== 2),
      [publications[1], publications[0], publications[2], publications[3]],
      [publications[0], publications[1], publication(9n, 1, firstDemand), publications[3]],
    ];
    // A shortened exact prefix ends before the leftover source-bound record;
    // that record then fails ordinary context, not the matching prefix.
    for (const variant of variants) await reject(compose(ancestry, finalCheckpoint, variant, 13n), "CONTEXT");
    for (const records of [adoptedRecords.slice(1), [firstWithdrawal, firstDemand, secondDemand, released.record],
      [firstDemand, firstWithdrawal, firstDemand, released.record]]) {
      const effects = records.map(record => record.kind === 6 ? adoptedEffects[3] : { outputs: [], nullifiers: [] });
      const bad = checkpoint(returned, 4n, 12n, records, effects, 10n);
      await reject(compose([originalOpening, originalState, returnOpening, bad], bad, publications, 12n), "ADOPTION");
    }
  });
  await test("closed-gap, wrong-time, future-anchor and bad-authorization publications have no force", async () => {
    const closed = await demand(original, funded, originalTree, b(156), 4n, 20n, "closed-gap demand");
    const wrongTime = await demand(original, funded, originalTree, b(157), 7n, 20n, "wrong-time gap demand");
    const futureTree = new NoteTree(); futureTree.appendAll([funded.cm, released.output.cm]);
    const future = await demand(original, funded, futureTree, b(158), 5n, 20n, "future-anchor gap demand");
    const badWithdrawal = withdrawal(original, secondDemand, presenterTwoSecret, false);
    const noise = [publication(6n, 1, closed), publication(8n, 1, wrongTime), publication(8n, 1, future),
      publication(9n, 4, badWithdrawal)];
    const answer = await replayLocalPackage(compose(ancestry, finalCheckpoint, [...noise, ...publications], 13n), verifier, codec);
    assert.equal(answer.status, "selected-local-replay");
    assert.deepEqual([answer.audit.records, answer.audit.noteRoot, answer.audit.spentRoot, answer.audit.historyHash],
      [result.audit.records, result.audit.noteRoot, result.audit.spentRoot, result.audit.historyHash]);
    // A no-force witnessing does not suppress a later first effective one.
    const withdrawClosed = withdrawal(original, closed, b(156));
    const retryRecords = [closed, withdrawClosed, ...adoptedRecords];
    const retryEffects = [{ outputs: [], nullifiers: [] }, { outputs: [], nullifiers: [] }, ...adoptedEffects];
    const retryCheckpoint = checkpoint(returned, 4n, 12n, retryRecords, retryEffects, 10n);
    const retry = await replayLocalPackage(compose([originalOpening, originalState, returnOpening, retryCheckpoint],
      retryCheckpoint, [publication(6n, 1, closed), publication(7n, 1, closed), publication(7n, 4, withdrawClosed), ...publications], 12n), verifier, codec);
    assert.equal(retry.status, "selected-local-replay"); assert.equal(retry.audit.records, "6");
  });
  await test("duplicates, including at the return index, do not gain force twice", async () => {
    const duplicates = [publications[0], publications[1], publication(9n, 1, firstDemand), ...publications.slice(2),
      publication(11n, 1, secondDemand), publication(11n, 3, released.record)];
    const answer = await replayLocalPackage(compose(ancestry, finalCheckpoint, duplicates, 13n), verifier, codec);
    assert.equal(answer.status, "selected-local-replay");
    assert.deepEqual([answer.audit.records, answer.audit.noteRoot, answer.audit.spentRoot, answer.audit.historyHash],
      [result.audit.records, result.audit.noteRoot, result.audit.spentRoot, result.audit.historyHash]);
  });
  await test("a newly forced withdrawal at the return index is included in the adopted block", async () => {
    const atReturn = withdrawal(original, secondDemand, presenterTwoSecret);
    const atReturnRecords = [firstDemand, firstWithdrawal, secondDemand, atReturn];
    const atReturnEffects = atReturnRecords.map(() => ({ outputs: [], nullifiers: [] }));
    const continuation = checkpoint(returned, 4n, 12n, atReturnRecords, atReturnEffects, 10n);
    const atReturnPublications = [...publications.slice(0, 3), publication(11n, 4, atReturn)];
    const answer = await replayLocalPackage(compose(
      [originalOpening, originalState, returnOpening, continuation], continuation, atReturnPublications, 12n), verifier, codec);
    assert.equal(answer.status, "selected-local-replay"); assert.equal(answer.audit.records, "4");
  });
  let sameIndex;
  await test("repeated same-index returns preserve publication force and the exact block still owed", async () => {
    const second = segment(4n, reference(returnOpening));
    const secondOpening = checkpoint(second, 4n, 11n, [], [], 10n);
    const third = segment(5n, reference(secondOpening));
    const thirdOpening = checkpoint(third, 5n, 11n, [], [], 10n);
    const thirdAdoption = checkpoint(third, 6n, 12n, adoptedRecords, adoptedEffects, 10n);
    // Force at the opening index still reads the original strictly-before
    // snapshot, despite all three fresh checkpoints at that index.
    const throughOpening = [...publications.slice(0, 3), publication(11n, 3, released.record)];
    const openings = [originalOpening, originalState, returnOpening, secondOpening, thirdOpening];
    const p = compose([...openings, thirdAdoption], thirdAdoption, throughOpening, 12n);
    const answer = await replayLocalPackage(p, verifier, codec);
    assert.equal(answer.status, "selected-local-replay");
    assert.equal(answer.audit.records, "4"); assert.equal(answer.audit.outstanding, "10");
    assert.equal(answer.audit.spentRoot, hex(adopted.spent.root()));
    assert.deepEqual(answer.audit.range.publications.map(p => p.force), [true, true, true, true]);
    const restored = await replayLocalPackage({ ...p, seed: issuerSeed }, verifier, codec);
    assert.deepEqual(restored.candidates, issuerRestored.candidates);
    sameIndex = { payload: p, result: answer, restored };
    const sameIndexContinuation = { ...thirdAdoption, at: 11n };
    await reject(compose([...openings, sameIndexContinuation], sameIndexContinuation, throughOpening, 11n), null, "lapsed-selection");
    const old = checkpoint(original, 7n, 12n, [issuance], [{ outputs: [funded.cm], nullifiers: [] }], 10n);
    const kept = await replayLocalPackage(compose([...openings, thirdAdoption, old], thirdAdoption, throughOpening, 12n), verifier, codec);
    assert.equal(kept.status, "selected-local-replay");
    assert.equal(kept.audit.range.carrying.at(-1).class, "lapsed");
    for (const records of [[], adoptedRecords.slice(0, 3), [...adoptedRecords].reverse()]) {
      const effects = records.map(record => record.kind === 6 ? adoptedEffects[3] : { outputs: [], nullifiers: [] });
      const bad = checkpoint(third, 6n, 12n, records, effects, 10n);
      await reject(compose([...openings, bad], bad, throughOpening, 12n), "ADOPTION");
    }
    const altered = structuredClone(released.record); altered.authorization[72] ^= 1;
    const bad = checkpoint(third, 6n, 12n, [...adoptedRecords.slice(0, 3), altered], adoptedEffects, 10n);
    await reject(compose([...openings, bad], bad, throughOpening, 12n), "ADOPTION");
  });
  await test("a second silence before first adoption inherits the old adoption index", async () => {
    const returnedAgain = segment(4n, reference(returnOpening));
    const secondOpening = checkpoint(returnedAgain, 4n, 16n, [], [], 10n);
    const secondAdoption = checkpoint(returnedAgain, 5n, 17n, adoptedRecords, adoptedEffects, 10n);
    const answer = await replayLocalPackage(compose(
      [originalOpening, originalState, returnOpening, secondOpening, secondAdoption], secondAdoption, publications, 17n), verifier, codec);
    assert.equal(answer.status, "selected-local-replay"); assert.equal(answer.audit.records, "4");
  });
  await test("adoption binds the exact proof and both settlement signatures", async () => {
    const variants = [];
    const wrongProof = structuredClone(released.record); wrongProof.proof[0] ^= 1; variants.push(wrongProof);
    const wrongAcceptance = structuredClone(released.record); wrongAcceptance.authorization[8] ^= 1; variants.push(wrongAcceptance);
    const wrongRelease = structuredClone(released.record); wrongRelease.authorization[72] ^= 1; variants.push(wrongRelease);
    for (const replacement of variants) {
      const venueVariant = [...publications.slice(0, 3), publication(10n, 3, replacement)];
      await reject(compose(ancestry, finalCheckpoint, venueVariant, 13n), "CONTEXT");
    }
    for (const replacement of variants) {
      const exactMismatch = checkpoint(returned, 4n, 12n, [...adoptedRecords.slice(0, 3), replacement], adoptedEffects, 10n);
      await reject(compose([originalOpening, originalState, returnOpening, exactMismatch], exactMismatch, publications, 12n), "ADOPTION");
    }
  });
  await test("withdrawing an expired demand releases only its own lock", async () => {
    const short = await demand(original, funded, originalTree, presenterOneSecret, 5n, 9n, "short recovery lock");
    const withdrawShort = withdrawal(original, short, presenterOneSecret);
    const lockRecords = [short, secondDemand, withdrawShort];
    const lockEffects = lockRecords.map(() => ({ outputs: [], nullifiers: [] }));
    const lockPublications = [publication(8n, 1, short), publication(10n, 1, secondDemand), publication(10n, 4, withdrawShort)];
    const liveSpend = await spend(returned, funded, originalTree, [paid, change, zeroOne, zeroTwo], "live recovery lock spend");
    const lockedContinuation = checkpoint(returned, 4n, 12n, [...lockRecords, liveSpend], [...lockEffects,
      { outputs: [paid.cm, change.cm, zeroOne.cm, zeroTwo.cm], nullifiers: [funded.nf, output(payerSeed, 170, 0n).nf] }], 10n);
    await reject(compose([originalOpening, originalState, returnOpening, lockedContinuation], lockedContinuation,
      lockPublications, 12n), "LOCKED");
  });
  await test("ordinary suffixes cannot bypass spent locks, withdrawal authorization or segment context", async () => {
    const conflict = await demand(returned, funded, originalTree, b(159), 9n, 20n, "spent imported note demand");
    const locked = checkpoint(returned, 5n, 13n, [...adoptedRecords, conflict],
      [...adoptedEffects, { outputs: [], nullifiers: [] }], 10n);
    await reject(compose([originalOpening, originalState, returnOpening, adopted, locked], locked, publications, 13n), "LOCKED");

    const settlementDemand = await demand(returned, released.output, localSettlementTree, b(160), 9n, 20n, "local settlement demand");
    const badAuth = withdrawal(returned, settlementDemand, b(160), false);
    const badSignature = checkpoint(returned, 5n, 13n, [...adoptedRecords, settlementDemand, badAuth],
      [...adoptedEffects, { outputs: [], nullifiers: [] }, { outputs: [], nullifiers: [] }], 10n);
    await reject(compose([originalOpening, originalState, returnOpening, adopted, badSignature], badSignature, publications, 13n), "SIGNATURE");
    const wrongContext = withdrawal(original, settlementDemand, b(160));
    const foreign = checkpoint(returned, 5n, 13n, [...adoptedRecords, settlementDemand, wrongContext],
      [...adoptedEffects, { outputs: [], nullifiers: [] }, { outputs: [], nullifiers: [] }], 10n);
    await reject(compose([originalOpening, originalState, returnOpening, adopted, foreign], foreign, publications, 13n), "CONTEXT");
  });
  await test("missing range or ancestry evidence returns no partial state", async () => {
    const unavailable = { ...verifier, record(data) { const record = verifier.record(data); return { ...record,
      range: request => request.kind === 4 ? undefined : record.range(request) }; } };
    const answer = await replayLocalPackage({ ...payload, seed: receiverSeed }, unavailable, codec);
    assert.equal(answer.status, "unresolved-evidence"); assert.equal(answer.audit, null); assert.deepEqual(answer.candidates, []);
    for (const key of ["directories", "snapshots", "trails"]) {
      const missing = structuredClone(payload); missing.package[key] = [];
      const refused = await replayLocalPackage({ ...missing, seed: receiverSeed }, verifier, codec);
      assert.equal(refused.status, "unresolved-evidence"); assert.equal(refused.audit, null); assert.deepEqual(refused.candidates, []);
    }
  });
  const receipts = await checkReceipts({ codec, verifier, test, compose, checkpoint, segment, reference, operatorSecret,
    original, originalOpening, originalState, issuance, funded, returnOpening, returned, adopted, finalCheckpoint,
    ancestry, publications, payload, adoptedRecords, adoptedEffects, finalRecords, finalEffects });
  const nonService = await checkNonService({ codec, verifier, prove, test, compose, checkpoint, segment, reference,
    publication, demand, note, domain, venue, backing, signedTerms, operatorSecret, ruleSecret, payerSeed,
    original, originalOpening, originalState, originalTree, issuance, funded, firstDemand,
    ancestry, publications, finalCheckpoint, paid, change });
  return { payload, result, receiver, issuerSeed, issuerPayload, issuerRestored, settlement: released.output, receipts, nonService, sameIndex, authorizations, intrinsicCases };
}
