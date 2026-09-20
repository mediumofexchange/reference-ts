// Conditional C2.10 scope split/rejoin fixtures. Proofs are supplied by the
// caller so the same trace can first probe replay with a cheap fixture oracle.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree, notePathProves } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { limbsOf, fieldToBytes } from "../../../dist/pool/field.js";
import { signCommitment, encodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR } from "../../../dist/replacement.js";
import { encodeRevocation, signRevocation } from "../../../dist/revocation.js";
import { prepareExactOutput } from "../delivery/crypto.mjs";
import { LIMITS } from "../delivery/evidence-reader.mjs";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage } from "./local-replay.mjs";
import { mergeFinalizedPrefixes } from "./scope-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";
import { compactFault } from "./fault-check.mjs";
import { checkNormalScopeReceipts } from "./scope-receipt-check.mjs";
import { checkNormalScopeCounts } from "./scope-count-check.mjs";

const b = n => new Uint8Array(32).fill(n), hex = bytes => Buffer.from(bytes).toString("hex");
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const same = (a, b) => Buffer.compare(a, b) === 0;
const distinct = (values, bytes) => values.filter((value, i) => values.findIndex(other => same(bytes(value), bytes(other))) === i);

export async function checkScopes({ codec, verifier, configurationBytes, domain, venue, prove, test,
  operatorSecret, issuerSecret, receiverSeed, payerSeed }) {
  const ruleSecret = b(151), successorSecret = b(152), operator = ed25519.getPublicKey(operatorSecret);
  const issuer = ed25519.getPublicKey(issuerSecret), issuerSecretY = b(150), issuerY = ed25519.getPublicKey(issuerSecretY);
  const backings = ["scope fixture x", "scope fixture y"].map((thing, i) => {
    const secret = i === 0 ? issuerSecret : issuerSecretY;
    const terms = codec.encodeRootTerms({ obligor: ed25519.getPublicKey(secret), operator, configuration: domain, venue, interval: 10n,
      payout: { thing, quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(ruleSecret),
      ...(i === 0 ? { nonService: { duration: 2n, count: 1n, window: 20n } } : {}) });
    return { backing: codec.rootTermsName(terms), signed: { terms,
      signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), secret) } };
  });
  const [x, y] = backings.map(t => t.backing);
  const reference = cp => ({ operator: cp.commitment.operator, sequence: cp.commitment.sequence, root: cp.commitment.root });
  function replacement(secret, predecessor, effective, at) {
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(secret), predecessor, effective,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(x, fields), signed = { ...fields, signature: ed25519.sign(message, ruleSecret),
      successorSignature: ed25519.sign(message, secret) };
    return { kind: 2, subject: x, index: at, record: encodeReplacement(x, signed), link: replacementHash(x, signed) };
  }
  const toB = replacement(successorSecret, x, 6n, 1n), toA = replacement(operatorSecret, toB.link, 12n, 7n);
  function segment(secret, sequence, entries) {
    entries = [...entries].sort((a, b) => Buffer.compare(a.backing, b.backing));
    const header = codec.segmentBytes({ domain, venue, operator: ed25519.getPublicKey(secret), sequence, entries });
    const id = hash(header), scope = new ScopeTree(entries);
    const paths = new Map(entries.map((entry, i) => [hex(entry.backing), { ...entry, path: scope.path(i) }]));
    return { secret, header, id, entries, prefix: [...limbsOf(domain), ...limbsOf(id), scope.root()], paths,
      base: { domain: limbsOf(domain).map(String), segment: limbsOf(id).map(String), scope: scope.root().toString() } };
  }
  const entry = (backing, link = backing, opening) => ({ backing, link, ...(opening === undefined ? {} : { opening: reference(opening) }) });
  const output = (backing, seed, id, value) => ({ ...prepareExactOutput(seed, domain, b(id), backing, value), backing });
  const digest = outputs => limbsOf(codec.deliveryHash(domain, outputs.map(o => o.cm), outputs.map(o => o.capsule)));
  const note = out => ({ backing: limbsOf(out.backing).map(String), value: out.opening.value.toString(),
    owner: out.opening.owner.toString(), rho: out.opening.rho.toString() });
  const membership = (ctx, backing) => {
    const { link, path } = ctx.paths.get(hex(backing));
    return { link: limbsOf(link).map(String), scope_siblings: path.siblings.map(String), scope_right: [...path.right] };
  };
  async function issue(ctx, out, label) {
    const record = await prove(1, { ...ctx.base, ...membership(ctx, out.backing), backing: limbsOf(out.backing).map(String),
      quantity: out.opening.value.toString(), cm: out.cm.toString(), owner: out.opening.owner.toString(),
      rho: out.opening.rho.toString(), delivery: digest([out]).map(String) },
    [...ctx.prefix, ...limbsOf(out.backing), out.opening.value, out.cm, ...digest([out])], [out], label);
    // The shared proof harness signs with x's issuer; scoped authorization is
    // independently supplied by the issuer committed into each backing's terms.
    if (same(out.backing, y)) record.authorization = ed25519.sign(codec.statementBytes(record), issuerSecretY);
    return record;
  }
  function inputWitness(inputs, positions, trees) {
    const paths = trees.map((tree, i) => tree.path(positions[i]));
    return { inputs: inputs.map(note), secrets: inputs.map(o => o.secret.toString()),
      anchors: trees.map(tree => tree.root().toString()), nullifiers: inputs.map(o => o.nf.toString()),
      siblings: paths.map(path => path.siblings.map(String)), right: paths.map(path => [...path.right]) };
  }
  async function spend(ctx, inputs, positions, trees, outputs, label) {
    const memberships = inputs.map(o => membership(ctx, o.backing));
    return prove(2, { ...ctx.base, ...inputWitness(inputs, positions, trees), links: memberships.map(m => m.link),
      scope_siblings: memberships.map(m => m.scope_siblings), scope_right: memberships.map(m => m.scope_right),
      output_notes: outputs.map(note), outputs: outputs.map(o => o.cm.toString()), delivery: digest(outputs).map(String) },
    [...ctx.prefix, ...trees.map(tree => tree.root()), ...inputs.map(o => o.nf), ...outputs.map(o => o.cm), ...digest(outputs)], outputs, label);
  }
  async function burn(ctx, inputs, positions, trees, change, quantity, label) {
    return prove(3, { ...ctx.base, ...membership(ctx, change.backing), ...inputWitness(inputs, positions, trees),
      backing: limbsOf(change.backing).map(String), quantity: quantity.toString(), change: note(change),
      cm_change: change.cm.toString(), delivery: digest([change]).map(String) },
    [...ctx.prefix, ...limbsOf(change.backing), quantity, ...trees.map(tree => tree.root()), ...inputs.map(o => o.nf),
      change.cm, ...digest([change])], [change], label);
  }
  const effect = (outputs, inputs = []) => ({ outputs: outputs.map(o => o.cm), nullifiers: inputs.map(o => o.nf) });
  const totals = (xi = 10n, xb = 0n, yi = 20n, yb = 0n) => new Map([[hex(x), { issued: xi, burned: xb }], [hex(y), { issued: yi, burned: yb }]]);
  // Independent assertion fold: imported history supplies only spent elements;
  // each segment starts its own local note tree and local hash chains.
  function checkpoint(ctx, sequence, at, records = [], effects = [], { supply = totals(), nullifiers = [] } = {}) {
    const tree = new NoteTree(), spent = new RadixSpentSet();
    for (const nf of new Set(nullifiers)) spent.insert(fieldToBytes(nf));
    let history = codec.genesisHistoryHash(ctx.id), evidence = codec.genesisEvidenceHash(ctx.id);
    records.forEach((record, i) => {
      tree.appendAll(effects[i].outputs);
      for (const nf of effects[i].nullifiers) if (!spent.has(fieldToBytes(nf))) spent.insert(fieldToBytes(nf));
      history = codec.nextHistoryHash(history, codec.statementHash(record), tree.root(), spent.root(), BigInt(i) + 1n);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n);
    });
    const snapshots = ctx.entries.map(({ backing }) => codec.snapshotBytes({ backing, segment: ctx.id,
      historyHash: history, evidenceHash: evidence, ...supply.get(hex(backing)) }));
    const directory = ctx.entries.map(({ backing }, i) => ({ name: backing, digest: hash(snapshots[i]) }));
    return { ctx, at, records, effects, importedNullifiers: nullifiers, snapshots, directory, tree, spent,
      commitment: signCommitment(ctx.secret, sequence, directoryRoot(directory)),
      trail: codec.encodeTrail({ header: ctx.header, terms: ctx.entries.map(({ backing }) => backings.find(t => same(t.backing, backing)).signed),
        records: records.map(codec.encodeRecord) }, LIMITS) };
  }
  function compose(checkpoints, chosen = checkpoints.at(-1), backing = x, replacements = [toB, toA], at = 20n, publications = []) {
    const record = new FixtureVenue(venue, at, 2n);
    for (const cp of checkpoints) record.witness(1, cp.commitment.operator, cp.at, encodeCommitment(cp.commitment));
    for (const r of replacements) record.witness(r.kind, r.subject, r.index, r.record);
    for (const p of publications) record.witness(4, p.backing, p.at, p.bytes);
    const snapshot = chosen.snapshots.find(bytes => same(codec.decodeSnapshot(bytes).backing, backing));
    const rest = checkpoints.filter(cp => cp !== chosen);
    return { selection: { domain, venue, backing, operator: chosen.commitment.operator, sequence: chosen.commitment.sequence,
      root: chosen.commitment.root, judgingIndex: at, mode: "current-fixture" },
    package: { configuration: configurationBytes, commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
      directories: distinct([chosen.directory, ...rest.map(cp => cp.directory)], directoryRoot).slice(1),
      snapshot, snapshots: distinct([snapshot, ...checkpoints.flatMap(cp => cp.snapshots)], bytes => bytes).slice(1),
      trail: chosen.trail, trails: distinct([chosen.trail, ...rest.map(cp => cp.trail)], bytes => bytes).slice(1) }, venue: record.export() };
  }
  const accepted = async payload => {
    const result = await replayLocalPackage(payload, verifier, codec);
    assert.equal(result.status, "selected-local-replay", JSON.stringify(result)); return result;
  };
  const refused = async (payload, status, check, selectedVerifier = verifier) => {
    const result = await replayLocalPackage({ ...payload, seed: receiverSeed }, selectedVerifier, codec);
    assert.equal(result.status, status, JSON.stringify(result));
    if (check !== undefined) assert.equal(result.check, check);
    assert.equal(result.audit, null); assert.deepEqual(result.candidates, []); assert.equal(result.spendable, false); return result;
  };
  const assertPaths = result => {
    for (const candidate of result.candidates) assert.equal(notePathProves(BigInt(candidate.anchor), BigInt(candidate.cm),
      { siblings: candidate.siblings.map(BigInt), right: candidate.right }), true);
  };

  const shared = segment(operatorSecret, 1n, [entry(x), entry(y)]);
  const fundedX = output(x, payerSeed, 153, 10n), fundedY = output(y, payerSeed, 154, 20n);
  const issuanceX = await issue(shared, fundedX, "scope shared issue x 10"), issuanceY = await issue(shared, fundedY, "scope shared issue y 20");
  const a0 = checkpoint(shared, 1n, 1n, [], [], { supply: totals(0n, 0n, 0n) });
  const a1 = checkpoint(shared, 2n, 2n, [issuanceX, issuanceY], [effect([fundedX]), effect([fundedY])]);
  const splitX = segment(successorSecret, 1n, [entry(x, toB.link, a1)]);
  const splitY = segment(operatorSecret, 3n, [entry(y, y, a1)]);
  const x0 = checkpoint(splitX, 1n, 6n), y0 = checkpoint(splitY, 3n, 6n);
  const paidX = output(x, receiverSeed, 155, 7n), changeX = output(x, payerSeed, 156, 3n);
  const zerosX = [output(x, payerSeed, 157, 0n), output(x, payerSeed, 158, 0n)], padX = output(x, payerSeed, 159, 0n);
  const paidY = output(y, receiverSeed, 160, 15n), changeY = output(y, payerSeed, 161, 5n);
  const zerosY = [output(y, payerSeed, 162, 0n), output(y, payerSeed, 163, 0n)], padY = output(y, payerSeed, 164, 0n);
  const outputsX = [paidX, changeX, ...zerosX], outputsY = [paidY, changeY, ...zerosY];
  const paymentX = await spend(splitX, [fundedX, padX], [0n, 0n], [a1.tree, a1.tree], outputsX, "scope independent x payment");
  const paymentY = await spend(splitY, [fundedY, padY], [1n, 0n], [a1.tree, a1.tree], outputsY, "scope independent y payment");
  const xEffect = effect(outputsX, [fundedX, padX]), yEffect = effect(outputsY, [fundedY, padY]);
  const x1 = checkpoint(splitX, 2n, 8n, [paymentX], [xEffect]), y1 = checkpoint(splitY, 4n, 9n, [paymentY], [yEffect]);
  const history = [a0, a1, x0, y0, x1, y1], imports = [...xEffect.nullifiers, ...yEffect.nullifiers];
  const joined = segment(operatorSecret, 5n, [entry(x, toA.link, x1), entry(y, y, y1)]);
  const j0 = checkpoint(joined, 5n, 12n, [], [], { nullifiers: imports });
  const mixedX = output(x, receiverSeed, 165, 7n), mixedY = output(y, receiverSeed, 166, 15n);
  const mixedOutputs = [mixedX, mixedY, output(x, receiverSeed, 167, 0n), output(y, receiverSeed, 168, 0n)];
  assert.notEqual(x1.tree.root(), y1.tree.root());
  const mixed = await spend(joined, [paidX, paidY], [0n, 0n], [x1.tree, y1.tree], mixedOutputs, "scope joined mixed spend with distinct anchors");
  const mixedEffect = effect(mixedOutputs, [paidX, paidY]);
  const j1 = checkpoint(joined, 6n, 14n, [mixed], [mixedEffect], { nullifiers: imports });
  const finalX = output(x, receiverSeed, 169, 6n), burnPad = output(x, receiverSeed, 170, 0n);
  const burned = await burn(joined, [mixedX, burnPad], [0n, 0n], [j1.tree, j1.tree], finalX, 1n, "scope joined continuation burns x 1");
  const j2 = checkpoint(joined, 7n, 15n, [mixed, burned], [mixedEffect, effect([finalX], [mixedX, burnPad])],
    { nullifiers: imports, supply: totals(10n, 1n) });
  const payload = compose([...history, j0, j1, j2]), payloadY = compose([...history, j0, j1, j2], j2, y);
  let result, receiver, receiverY;
  await test("shared two-backing prefix restores only the independently selected backing", async () => {
    for (const [backing, funded, quantity] of [[x, fundedX, "10"], [y, fundedY, "20"]]) {
      const answer = await accepted({ ...compose([a0, a1], a1, backing, []), seed: payerSeed });
      assert.equal(answer.audit.issued, quantity); assert.equal(answer.audit.burned, "0");
      assert.equal(answer.audit.noteRoot, a1.tree.root().toString());
      assert.deepEqual(answer.candidates.map(c => [c.cm, c.value]), [[funded.cm.toString(), quantity]]); assertPaths(answer);
    }
  });
  await test("split scopes independently continue one shared prefix without duplicating its issuance", async () => {
    const shrunk = await accepted({ ...compose([a0, a1, x0], x0, x, [toB]), seed: payerSeed });
    assert.equal(shrunk.audit.noteRoot, new NoteTree().root().toString());
    assert.deepEqual(shrunk.candidates.map(c => [c.cm, c.anchor, c.pathScope]),
      [[fundedX.cm.toString(), a1.tree.root().toString(), "replayed-imported-tree-only"]]); assertPaths(shrunk);
    for (const [backing, chosen, paid, change, issued] of [[x, x1, paidX, changeX, "10"], [y, y1, paidY, changeY, "20"]]) {
      const p = compose(history, chosen, backing, [toB]);
      const answer = await accepted({ ...p, seed: receiverSeed }), payer = await accepted({ ...p, seed: payerSeed });
      assert.equal(answer.audit.issued, issued); assert.equal(answer.audit.records, "1");
      assert.equal(answer.audit.noteRoot, chosen.tree.root().toString()); assert.equal(answer.audit.spentRoot, hex(chosen.spent.root()));
      assert.deepEqual(answer.candidates.map(c => c.cm), [paid.cm.toString()]);
      assert.deepEqual(payer.candidates.map(c => c.cm), [change.cm.toString()]); assertPaths(answer); assertPaths(payer);
    }
  });
  await test("rejoined scope unions exact shared events once and accepts distinct imported anchors", async () => {
    const opened = await accepted({ ...compose([...history, j0]), seed: receiverSeed });
    assert.equal(opened.audit.records, "0"); assert.equal(opened.audit.noteRoot, new NoteTree().root().toString());
    assert.equal(opened.audit.spentRoot, hex(j0.spent.root()));
    assert.deepEqual(opened.candidates.map(c => [c.cm, c.anchor, c.pathScope]),
      [[paidX.cm.toString(), x1.tree.root().toString(), "replayed-imported-tree-only"]]); assertPaths(opened);
    const paid = await accepted({ ...compose([...history, j0, j1]), seed: receiverSeed });
    assert.deepEqual(paid.candidates.map(c => c.cm), [mixedX.cm.toString()]);
    assert.equal(paid.audit.noteRoot, j1.tree.root().toString()); assert.equal(paid.audit.spentRoot, hex(j1.spent.root())); assertPaths(paid);
  });
  await test("later shared continuation preserves independent totals and selected-backing wallet paths", async () => {
    result = await accepted(payload); receiver = await accepted({ ...payload, seed: receiverSeed });
    receiverY = await accepted({ ...payloadY, seed: receiverSeed });
    for (const [answer, issued, burned, out] of [[receiver, "10", "1", finalX], [receiverY, "20", "0", mixedY]]) {
      assert.equal(answer.audit.records, "2"); assert.equal(answer.audit.issued, issued); assert.equal(answer.audit.burned, burned);
      assert.equal(answer.audit.outstanding, (BigInt(issued) - BigInt(burned)).toString());
      assert.equal(answer.audit.noteRoot, j2.tree.root().toString()); assert.equal(answer.audit.spentRoot, hex(j2.spent.root()));
      assert.deepEqual(answer.candidates.map(c => [c.cm, c.value, c.anchor, c.pathScope]),
        [[out.cm.toString(), out.opening.value.toString(), j2.tree.root().toString(), "replayed-local-tree-only"]]); assertPaths(answer);
    }
    for (const [p, out] of [[payload, changeX], [payloadY, changeY]]) {
      const payer = await accepted({ ...p, seed: payerSeed });
      assert.deepEqual(payer.candidates.map(c => c.cm), [out.cm.toString()]); assertPaths(payer);
    }
    assert.deepEqual(result.audit, receiver.audit);
  });
  await test("every withheld dependency of the other selected scope fails without partial restoration", async () => {
    for (const key of ["directories", "snapshots", "trails"]) {
      const missing = structuredClone(payload); missing.package[key] = [];
      await refused(missing, "unresolved-evidence");
    }
    for (const source of [x1, y1]) {
      const missing = structuredClone(payload);
      missing.package.snapshots = missing.package.snapshots.filter(bytes => !source.snapshots.some(s => same(s, bytes)));
      await refused(missing, "unresolved-evidence");
      const absent = structuredClone(payload);
      absent.package.trails = absent.package.trails.filter(bytes => !same(source.trail, bytes));
      await refused(absent, "unresolved-evidence");
    }
    const unselected = structuredClone(payload);
    unselected.package.snapshots = unselected.package.snapshots.filter(bytes =>
      !same(codec.decodeSnapshot(bytes).segment, joined.id) || !same(codec.decodeSnapshot(bytes).backing, y));
    await refused(unselected, "unresolved-evidence");
    for (const [kind, subject] of [[2, y], [3, issuerY]]) {
      const unavailable = { ...verifier, record(data) {
        const record = verifier.record(data);
        return { ...record, range: request => request.kind === kind && same(request.subject, subject) ? undefined : record.range(request) };
      } };
      await refused(payload, "unresolved-evidence", undefined, unavailable);
    }
  });
  await test("each scoped issuer's revocation voids new issuance but preserves its finalized earlier prefix", async () => {
    const early = compose([a0, a1], a1, x, []);
    early.venue.records.push({ kind: 3, subject: issuerY, index: 2n, record: encodeRevocation(signRevocation(issuerSecretY)) });
    await refused(early, "invalid-local-replay", "REVOKED");
    for (const [subject, secret] of [[issuer, issuerSecret], [issuerY, issuerSecretY]]) {
      const later = structuredClone(payload);
      later.venue.records.push({ kind: 3, subject, index: 3n, record: encodeRevocation(signRevocation(secret)) });
      const answer = await accepted({ ...later, seed: receiverSeed });
      assert.deepEqual(answer.candidates, receiver.candidates);
      assert.equal(answer.audit.issued, "10"); assert.equal(answer.audit.burned, "1");
      assert.equal(answer.audit.noteRoot, receiver.audit.noteRoot); assert.equal(answer.audit.spentRoot, receiver.audit.spentRoot);
    }
  });
  let lapse, compact;
  await test("one ended operator term lapses the whole shared scope without its event history", async () => {
    const bad = structuredClone(issuanceY); bad.proof[100] ^= 1;
    const late = checkpoint(shared, 3n, 7n, [issuanceX, bad], [effect([fundedX]), effect([fundedY])]);
    await refused(compose([a0, a1, x0, late], late, y, [toB]), "lapsed-selection");
    const smaller = segment(operatorSecret, 4n, [entry(y, y, a1)]), resumed = checkpoint(smaller, 4n, 8n);
    const answer = await accepted({ ...compose([a0, a1, x0, late, resumed], resumed, y, [toB]), seed: payerSeed });
    assert.equal(answer.audit.issued, "20"); assert.equal(answer.audit.records, "0");
    assert.deepEqual(answer.candidates.map(c => c.cm), [fundedY.cm.toString()]); assertPaths(answer);
    assert.equal(answer.audit.range.carrying.some(c => c.class === "lapsed"), true);
    const withheld = compose([a0, a1, x0, late, resumed], resumed, y, [toB]);
    withheld.package.trails = withheld.package.trails.filter(bytes => !same(bytes, late.trail));
    const result = await accepted(withheld);
    assert.deepEqual(result, await accepted(compose([a0, a1, x0, late, resumed], resumed, y, [toB])));
    lapse = { payload: withheld, result };
    // The compact opening is for sibling x although this read selects y.
    const fault = compactFault(late.snapshots.find(s => same(codec.decodeSnapshot(s).backing, x)), [issuanceX, bad], 2n, codec);
    const reported = { ...withheld, package: { ...withheld.package, faults: [fault] } };
    const observation = await accepted(reported);
    assert.equal(observation.faultEvidence.length, 1);
    assert.equal(observation.faultEvidence[0].backing, hex(x));
    const { faultEvidence, ...unchanged } = observation; assert.deepEqual(unchanged, result);
    compact = { payload: reported, result: observation };
    const partialDirectory = { ...late, directory: late.directory.filter(e => same(e.name, y)) };
    partialDirectory.commitment = signCommitment(operatorSecret, 3n, directoryRoot(partialDirectory.directory));
    const incomplete = compose([a0, a1, x0, partialDirectory, resumed], resumed, y, [toB]);
    incomplete.package.trails = incomplete.package.trails.filter(bytes => !same(bytes, late.trail));
    assert.equal((await accepted(incomplete)).audit.range.carrying.some(c => c.class === "lapsed"), true);
    const partialLive = compose([a0, a1, { ...partialDirectory, at: 4n }, x0, resumed], resumed, y, [toB]);
    partialLive.package.trails = partialLive.package.trails.filter(bytes => !same(bytes, late.trail));
    await refused(partialLive, "unresolved-evidence");
    // A later replacement cannot excuse a checkpoint that was live at its
    // original prefix, and withholding the earlier canonical prefix still blocks.
    await refused({ ...withheld, venue: { ...withheld.venue, records: withheld.venue.records.map(r =>
      r.kind === 1 && same(r.record, encodeCommitment(late.commitment)) ? { ...r, index: 4n } : r) } }, "unresolved-evidence");
    const missingPrior = structuredClone(withheld);
    missingPrior.package.trails = missingPrior.package.trails.filter(bytes => !same(bytes, a1.trail));
    await refused(missingPrior, "unresolved-evidence");
    const missingRange = { ...verifier, record(data) { const v = verifier.record(data); return { ...v,
      range: r => r.kind === 2 && same(r.subject, x) ? undefined : v.range(r) }; } };
    await refused(withheld, "unresolved-evidence", undefined, missingRange);
    // An ended sibling term takes precedence over an unknown sibling link.
    const malformed = segment(operatorSecret, 3n, [entry(x), entry(y, b(211))]);
    const malformedLate = checkpoint(malformed, 3n, 7n, [issuanceX, bad], [effect([fundedX]), effect([fundedY])]);
    const metadata = codec.encodeTrail({ ...codec.decodeTrail(malformedLate.trail, LIMITS), records: [] }, LIMITS);
    const partial = compose([a0, a1, x0, { ...malformedLate, trail: metadata }, resumed], resumed, y, [toB]);
    assert.equal((await accepted(partial)).audit.range.carrying.some(c => c.class === "lapsed"), true);
    // Invalid signed-term copies must not shadow the available authentic scope.
    const invalidTerms = codec.decodeTrail(metadata, LIMITS), altered = structuredClone(invalidTerms);
    altered.terms[0].signature[0] ^= 1;
    const invalidMetadata = codec.encodeTrail(altered, LIMITS);
    const malformedTerms = structuredClone(invalidTerms); malformedTerms.terms[0].terms[0] ^= 1;
    for (const invalidCopy of [invalidMetadata, codec.encodeTrail(malformedTerms, LIMITS)]) {
      for (const trails of [[invalidCopy, ...partial.package.trails], [...partial.package.trails, invalidCopy]]) {
        assert.deepEqual(await accepted({ ...partial, package: { ...partial.package, trails } }), await accepted(partial));
      }
    }
    const unavailableScope = structuredClone(partial);
    unavailableScope.package.trails = unavailableScope.package.trails.filter(bytes => !same(bytes, metadata));
    unavailableScope.package.trails.push(invalidMetadata);
    await refused(unavailableScope, "unresolved-evidence");
    const forged = structuredClone(partial), wrongHeader = structuredClone(invalidTerms);
    wrongHeader.header[25] ^= 1;
    forged.package.trails = forged.package.trails.filter(bytes => !same(bytes, metadata));
    forged.package.trails.push(codec.encodeTrail(wrongHeader, LIMITS));
    await refused(forged, "unresolved-evidence");
    const alien = segment(successorSecret, 3n, [entry(x), entry(y)]);
    const alienCp = checkpoint(alien, 3n, 7n, [issuanceX, bad], [effect([fundedX]), effect([fundedY])]);
    alienCp.commitment = signCommitment(operatorSecret, 3n, directoryRoot(alienCp.directory));
    const alienPartial = { ...alienCp, trail: codec.encodeTrail({ ...codec.decodeTrail(alienCp.trail, LIMITS), records: [] }, LIMITS) };
    // Even a provable header-context fault cannot exclude missing event evidence.
    await refused(compose([a0, a1, x0, alienPartial, resumed], resumed, y, [toB]), "unresolved-evidence");
    // Exact snapshot backing is checked even when the signed directory binds it.
    const wrong = { ...late, snapshots: late.snapshots.map(bytes => same(codec.decodeSnapshot(bytes).backing, y)
      ? codec.snapshotBytes({ ...codec.decodeSnapshot(bytes), backing: x }) : bytes) };
    wrong.directory = late.directory.map(e => same(e.name, y) ? { ...e, digest: hash(wrong.snapshots[late.directory.findIndex(e => same(e.name, y))]) } : e);
    wrong.commitment = signCommitment(operatorSecret, 3n, directoryRoot(wrong.directory));
    await refused(compose([a0, a1, x0, wrong, resumed], resumed, y, [toB]), "unresolved-evidence");
  });
  await test("same-index lower held sequences qualify as exact predecessors and stale references fail", async () => {
    const again = segment(operatorSecret, 6n, [entry(x, toA.link, j0), entry(y, y, j0)]);
    const second = checkpoint(again, 6n, 12n, [], [], { nullifiers: imports });
    const thirdContext = segment(operatorSecret, 7n, [entry(x, toA.link, second), entry(y, y, second)]);
    const third = checkpoint(thirdContext, 7n, 12n, [], [], { nullifiers: imports });
    const answer = await accepted({ ...compose([...history, j0, second, third]), seed: receiverSeed });
    assert.equal(answer.audit.spentRoot, hex(j0.spent.root()));
    assert.deepEqual(answer.candidates.map(c => c.cm), [paidX.cm.toString()]); assertPaths(answer);
    for (const [openX, openY] of [[j0, second], [second, j0]]) {
      const stale = segment(operatorSecret, 7n, [entry(x, toA.link, openX), entry(y, y, openY)]);
      await refused(compose([...history, j0, second, checkpoint(stale, 7n, 12n, [], [], { nullifiers: imports })]),
        "invalid-local-replay", "IMPORT");
    }
    // Another operator's same-index checkpoint cannot become the takeover's
    // predecessor, even when its complete bytes and proofs are supplied.
    await refused(compose([a0, { ...a1, at: 6n }, x0], x0, x, [toB]), "invalid-local-replay", "IMPORT");
  });
  await test("a mixed silence clause excludes required shared ancestry even after selection shrinks scope", async () => {
    const terms = codec.encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue, interval: 10n,
      payout: { thing: "unsupported scoped recovery ancestor", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: 4n, challengeWindow: 5n } });
    const backing = codec.rootTermsName(terms);
    backings.push({ backing, signed: { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) } });
    const supply = new Map([[hex(y), { issued: 0n, burned: 0n }], [hex(backing), { issued: 0n, burned: 0n }]]);
    const original = checkpoint(segment(operatorSecret, 1n, [entry(y), entry(backing)]), 1n, 1n, [], [], { supply });
    const smaller = checkpoint(segment(operatorSecret, 2n, [entry(y, y, original)]), 2n, 2n, [], [], { supply });
    await refused(compose([original, smaller], smaller, y, []), "invalid-local-replay", "IMPORT");
  });
  await test("one stale opening cannot substitute for either required split predecessor", async () => {
    for (const [openX, openY] of [[x0, y1], [x1, y0], [a1, y1], [x1, a1]]) {
      const stale = segment(operatorSecret, 5n, [entry(x, toA.link, openX), entry(y, y, openY)]);
      await refused(compose([...history, checkpoint(stale, 5n, 12n, [], [], { nullifiers: imports })]), "invalid-local-replay", "IMPORT");
    }
  });
  await test("a proof-invalid scoped tail is excluded for every backing before the split", async () => {
    const unused = output(y, payerSeed, 171, 1n), invalid = structuredClone(issuanceY);
    invalid.proof[100] ^= 1; invalid.publicInputs[7] = 1n; invalid.publicInputs[8] = unused.cm;
    invalid.publicInputs.splice(9, 2, ...digest([unused])); invalid.capsules = [unused.capsule];
    invalid.authorization = ed25519.sign(codec.statementBytes(invalid), issuerSecretY);
    const tail = checkpoint(shared, 3n, 4n, [issuanceX, issuanceY, invalid], [effect([fundedX]), effect([fundedY]), effect([unused])],
      { supply: totals(10n, 0n, 21n) });
    // Only the successor opens here, so the original's excluded sequence 3
    // cannot collide with its independent y-scope opening from the main trace.
    const next = segment(successorSecret, 1n, [entry(x, toB.link, a1)]), opened = checkpoint(next, 1n, 6n);
    const answer = await accepted(compose([a0, a1, tail, opened], opened, x, [toB]));
    assert.equal(answer.audit.issued, "10");
    assert.equal(answer.audit.range.carrying.some(c => c.class === "excluded" && c.check === "PROOF"), true);
    const bad = segment(successorSecret, 1n, [entry(x, toB.link, tail)]);
    await refused(compose([a0, a1, tail, checkpoint(bad, 1n, 6n)], undefined, x, [toB]), "invalid-local-replay", "IMPORT");
  });
  await test("a signed partial directory cannot finalize any part of a two-backing scope", async () => {
    const partial = { ...j1, directory: j1.directory.filter(e => same(e.name, x)) };
    partial.commitment = signCommitment(operatorSecret, 6n, directoryRoot(partial.directory));
    await refused(compose([...history, j0, partial]), "invalid-local-replay", "SCOPE");
    const next = segment(operatorSecret, 7n, [entry(x, toA.link, j0), entry(y, y, j0)]);
    const answer = await accepted(compose([...history, j0, partial, checkpoint(next, 7n, 15n, [], [], { nullifiers: imports })]));
    assert.equal(answer.audit.range.carrying.some(c => c.class === "excluded" && c.check === "SCOPE"), true);
  });
  await test("wrong totals in the unselected backing invalidate the shared checkpoint atomically", async () => {
    const wrong = checkpoint(joined, 6n, 14n, [mixed], [mixedEffect], { nullifiers: imports, supply: totals(10n, 0n, 21n) });
    await refused(compose([...history, j0, wrong]), "invalid-local-replay", "SNAPSHOT");
  });
  const conflictPad = output(x, payerSeed, 172, 0n);
  const conflictOutputs = [output(x, receiverSeed, 173, 6n), output(x, payerSeed, 174, 4n),
    output(x, payerSeed, 175, 0n), output(x, payerSeed, 176, 0n)];
  const doubleSpend = await spend(joined, [fundedX, conflictPad], [0n, 0n], [a1.tree, a1.tree], conflictOutputs,
    "scope valid proof reuses a nullifier from a split history");
  const duplicate = await issue(joined, changeX, "scope valid issue proof repeats an output from a split history");
  await test("otherwise valid joined proofs cannot reuse imported nullifiers or output commitments", async () => {
    const repeated = checkpoint(joined, 6n, 14n, [doubleSpend], [effect(conflictOutputs, [fundedX, conflictPad])], { nullifiers: imports });
    await refused(compose([...history, j0, repeated]), "invalid-local-replay", "SPENT");
    const duplicated = checkpoint(joined, 6n, 14n, [duplicate], [effect([changeX])], { nullifiers: imports, supply: totals(13n) });
    await refused(compose([...history, j0, duplicated]), "invalid-local-replay", "OUTPUT");
  });
  await test("isolated finalized-prefix merge deduplicates common events and rejects conflicting histories", async () => {
    // These deliberately conflicting parent states probe the merger directly;
    // they do not claim that canonical disjoint scopes can finalize a conflict.
    const parent = (id, record) => ({ state: { events: new Map([[id, { identity: hex(codec.statementHash(record)), record }]]),
      anchors: new Set(), scanOutputs: [], outputPositions: new Map() } });
    const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { check: code }); };
    let charged = 0n;
    const common = mergeFinalizedPrefixes([parent("shared:1", issuanceX), parent("shared:1", issuanceX)],
      { check, chargeEvents: count => { charged += count; } });
    assert.equal(common.events.size, 1); assert.equal(common.outputsSeen.size, 1); assert.equal(charged, 2n);
    assert.deepEqual(common.totals.get(hex(x)), { issued: 10n, burned: 0n });
    for (const [left, right, expected] of [
      [parent("shared:1", issuanceX), parent("shared:1", issuanceY), "CONTINUITY"],
      [parent("left:1", paymentX), parent("right:1", paymentX), "SPENT"],
      [parent("left:1", issuanceX), parent("right:1", issuanceX), "OUTPUT"],
    ]) assert.throws(() => mergeFinalizedPrefixes([left, right], { check, chargeEvents: () => {} }), error => error.check === expected);
  });
  const receipts = await checkNormalScopeReceipts({ codec, verifier, test, operatorSecret, checkpoint, compose, segment, entry,
    x, y, a0, a1, y1, j0, j1, j2, history, payload, payloadY, toB });
  const nonService = await checkNormalScopeCounts({ codec, verifier, prove, test, domain, note, operatorSecret,
    successorSecret, checkpoint, compose, x, y, a0, a1, x0, y0, x1, y1, j0, j1, history, toB, toA,
    fundedX, paidX, issuanceX, issuanceY, effect, receipts });
  return { payload, payloadY, result, receiver, receiverY, receipts, nonService, lapse, compact };
}
