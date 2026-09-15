// Real-proof conditional initial-segment replay and restoration experiment.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { serialize } from "node:v8";
import ts from "typescript";
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree, notePathProves } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { limbsOf, fieldToBytes } from "../../../dist/pool/field.js";
import { signCommitment, encodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { decodeReplacement, encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR } from "../../../dist/replacement.js";
import { encodeRevocation, signRevocation } from "../../../dist/revocation.js";
import { prepareExactOutput } from "../delivery/crypto.mjs";
import { loadEvidenceCodecs, LIMITS } from "../delivery/evidence-reader.mjs";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage, replayEvidencePackage, PACKAGE_LIMITS, RANGE_LIMITS } from "./local-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";
import { field } from "../fixtures.mjs";
import { RELATION_KINDS, loadCandidateManifest, checkCandidateSources, candidateConfiguration,
  readCandidateKeys, loadConfigurationCodecs } from "./candidate.mjs";

const here = import.meta.dirname, root = resolve(here, "../../..");
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(join(root, "scratch"));
const build = realpathSync(mkdtempSync(join(scratch, "pool-v3-local-replay-")));
const url = pathToFileURL(build + sep).href;
const checks = [], metrics = [], b = n => new Uint8Array(32).fill(n), clone = structuredClone;
const hex = bytes => Buffer.from(bytes).toString("hex");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const test = async (name, fn) => { await fn(); checks.push(name); };
let api;
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error("TypeScript configuration unreadable");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(["trail", "configuration", "terms", "package", "range"].map(name => join(root, `model/pool-v3-${name}.ts`)), {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0); assert.equal(program.emit().emitSkipped, false);
  const codec = { ...await loadEvidenceCodecs(url), ...await loadConfigurationCodecs(url),
    ...await import(new URL("model/pool-v3-package.js", url)), ...await import(new URL("model/pool-v3-range.js", url)) };
  const canonical = items => items.sort((a, b) => a.kind - b.kind || Buffer.compare(Buffer.from(sha(a.payload), "hex"), Buffer.from(sha(b.payload), "hex")));
  function portable(input) {
    const p = input.package, directories = [p.directory, ...(p.directories ?? [])];
    const snapshots = [p.snapshot, ...(p.snapshots ?? [])], trails = [p.trail, ...(p.trails ?? [])];
    return { ...input, package: codec.encodeEvidencePackage(canonical([
      { kind: 1, payload: p.configuration }, { kind: 2, payload: p.commitment },
      ...directories.map(entries => ({ kind: 3, payload: codec.encodeEvidenceDirectory(entries, PACKAGE_LIMITS) })),
      ...snapshots.map(payload => ({ kind: 4, payload })), ...trails.map(payload => ({ kind: 6, payload })),
    ]), PACKAGE_LIMITS) };
  }
  const manifest = loadCandidateManifest(); checkCandidateSources(manifest);
  const configuration = candidateConfiguration(manifest, codec), configurationBytes = codec.configurationBytes(configuration);
  execFileSync(process.execPath, [join(here, "compile.mjs"), build], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
  checkCandidateSources(manifest);
  const circuits = {}, identities = {}, options = { verifierTarget: manifest.verifierTarget };
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath: join(scratch, "private-payment-crs") });
  for (const [kind, name] of RELATION_KINDS) {
    const artifact = JSON.parse(readFileSync(join(build, `${name}.json`), "utf8"));
    const backend = new UltraHonkBackend(artifact.bytecode, api), vk = await backend.getVerificationKey(options);
    circuits[kind] = { backend, noir: new Noir(artifact), vk };
    identities[name] = { bytecode: sha(Buffer.from(artifact.bytecode, "base64")), vk: sha(vk) };
    assert.deepEqual(identities[name], manifest.circuits[name]);
    writeFileSync(join(build, `${kind}.vk`), vk);
  }
  const keys = readCandidateKeys(build, manifest);
  const verifierBackend = new UltraHonkVerifierBackend(api);
  // The harness selects the range verifier: a fixture venue rebuilt from the
  // fixture's own witnessed records (pool-v3 §13.2), never from the package.
  const verifier = { configuration, verify: (kind, publicInputs, proof) => verifierBackend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, options), record: data => {
    const witnessed = FixtureVenue.from(data);
    return { range: request => witnessed.answer(request, codec, RANGE_LIMITS), witnessedIndex: () => witnessed.witnessedIndex, lag: () => witnessed.lag };
  } };
  const domain = codec.configurationHash(configuration), venue = b(12), issuerSecret = b(15), operatorSecret = b(16);
  const payerSeed = b(21), receiverSeed = b(22), issuerKey = ed25519.getPublicKey(issuerSecret);
  const operator = ed25519.getPublicKey(operatorSecret);
  const termsFields = { obligor: issuerKey, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n },
    operator, configuration: domain, venue, interval: 10n };
  const termsBytes = codec.encodeRootTerms(termsFields), backing = codec.rootTermsName(termsBytes), link = backing;
  const signedTerms = { terms: termsBytes, signature: ed25519.sign(codec.rootTermsSignatureMessage(termsBytes), issuerSecret) };
  const header = codec.segmentBytes({ domain, venue, operator, sequence: 1n, entries: [{ backing, link }] });
  const segment = new Uint8Array(Buffer.from(sha(header), "hex")), scope = new ScopeTree([{ backing, link }]);
  const sp = scope.path(0), prefix = [...limbsOf(domain), ...limbsOf(segment), scope.root()];
  const output = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  const funded = output(payerSeed, 31, 10n), paid = output(receiverSeed, 32, 7n), change = output(payerSeed, 33, 3n);
  const zero1 = output(payerSeed, 34, 0n), zero2 = output(payerSeed, 35, 0n), pad = output(payerSeed, 36, 0n);
  const burnChange = output(receiverSeed, 37, 2n), receiverPad = output(receiverSeed, 38, 0n);
  const digest = outputs => limbsOf(codec.deliveryHash(domain, outputs.map(x => x.cm), outputs.map(x => x.capsule)));
  const note = output => ({ backing: limbsOf(backing).map(String), value: output.opening.value.toString(),
    owner: output.opening.owner.toString(), rho: output.opening.rho.toString() });
  const base = { domain: limbsOf(domain).map(String), segment: limbsOf(segment).map(String), scope: scope.root().toString() };
  const singleScope = { link: limbsOf(link).map(String), scope_siblings: sp.siblings.map(String), scope_right: [...sp.right] };
  async function prove(kind, witness, publicInputs, outputs, label) {
    const start = performance.now();
    const { witness: executed } = await circuits[kind].noir.execute(witness);
    const proof = await circuits[kind].backend.generateProof(executed, options);
    assert.deepEqual(proof.publicInputs.map(BigInt), publicInputs);
    assert.equal(await verifier.verify(kind, publicInputs, proof.proof), true);
    metrics.push({ label, kind, proofBytes: proof.proof.length, elapsedMs: performance.now() - start });
    const record = { domain, kind, publicInputs, proof: proof.proof, authorization: new Uint8Array(), capsules: outputs.map(x => x.capsule) };
    if (kind === 1) record.authorization = ed25519.sign(codec.statementBytes(record), issuerSecret);
    return record;
  }
  const issueInputs = [...prefix, ...limbsOf(backing), 10n, funded.cm, ...digest([funded])];
  const issueWitness = { ...base, ...singleScope, backing: limbsOf(backing).map(String), quantity: "10",
    cm: funded.cm.toString(), owner: funded.opening.owner.toString(), rho: funded.opening.rho.toString(), delivery: digest([funded]).map(String) };
  const issue = await prove(1, issueWitness, issueInputs, [funded], "issue 10");
  const tree = new NoteTree(); tree.append(funded.cm);
  function inputWitness(inputs, positions, localTree = tree) {
    const paths = positions.map(position => localTree.path(position));
    return { inputs: inputs.map(note), secrets: inputs.map(x => x.secret.toString()),
      anchors: inputs.map(() => localTree.root().toString()), nullifiers: inputs.map(x => x.nf.toString()),
      siblings: paths.map(x => x.siblings.map(String)), right: paths.map(x => [...x.right]) };
  }
  async function spend(inputs, positions, outputs, label, localTree = tree) {
    const iw = inputWitness(inputs, positions, localTree);
    const witness = { ...base, ...iw, links: [singleScope.link, singleScope.link],
      scope_siblings: [singleScope.scope_siblings, singleScope.scope_siblings], scope_right: [sp.right, sp.right],
      output_notes: outputs.map(note), outputs: outputs.map(x => x.cm.toString()), delivery: digest(outputs).map(String) };
    return prove(2, witness, [...prefix, ...iw.anchors.map(BigInt), ...inputs.map(x => x.nf),
      ...outputs.map(x => x.cm), ...digest(outputs)], outputs, label);
  }
  const payment = await spend([funded, pad], [0n, 0n], [paid, change, zero1, zero2], "pay 7, change 3");
  tree.appendAll([paid.cm, change.cm, zero1.cm, zero2.cm]);
  const bw = inputWitness([paid, receiverPad], [1n, 0n]);
  const burnWitness = { ...base, ...singleScope, ...bw, backing: limbsOf(backing).map(String), quantity: "5",
    change: note(burnChange), cm_change: burnChange.cm.toString(), delivery: digest([burnChange]).map(String) };
  const burn = await prove(3, burnWitness, [...prefix, ...limbsOf(backing), 5n, ...bw.anchors.map(BigInt),
    paid.nf, receiverPad.nf, burnChange.cm, ...digest([burnChange])], [burnChange], "burn 5, change 2");

  // Independent fixture fold: infer no validity here. Construct the asserted
  // roots from explicit fixture effects, then make the reader reproduce them.
  function packageFor(records, effects, totals = { issued: 10n, burned: 5n }) {
    const t = new NoteTree(), s = new RadixSpentSet();
    let history = codec.genesisHistoryHash(segment), evidence = codec.genesisEvidenceHash(segment);
    records.forEach((record, i) => {
      const effect = effects[i];
      t.appendAll(effect.outputs); effect.nullifiers.forEach(nf => { if (!s.has(fieldToBytes(nf))) s.insert(fieldToBytes(nf)); });
      const position = BigInt(i) + 1n;
      history = codec.nextHistoryHash(history, codec.statementHash(record), t.root(), s.root(), position);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), position);
    });
    const snapshot = { backing, segment, historyHash: history, evidenceHash: evidence, ...totals };
    return seal(records, snapshot);
  }
  // The fixture venue holds the operator's commitments 1 (index 1) and 4
  // (index 7) carrying another backing, around the selected checkpoint 3 at
  // index 3; the reader must pass both by their directories (C2.4.2, C2.7.3).
  const otherName = b(77), before = [{ name: otherName, digest: b(78) }], after = [{ name: otherName, digest: b(79) }];
  const earlier = signCommitment(operatorSecret, 1n, directoryRoot(before)), later = signCommitment(operatorSecret, 4n, directoryRoot(after));
  // The fixture venue's lag is 2, so a replacement's lead floor is its witnessing plus 5 (C2.5.3).
  function witnessed(commitment, { at = 3n, laterAt = 7n, extra = [] } = {}) {
    const record = new FixtureVenue(venue, 20n, 2n);
    record.witness(1, operator, 1n, encodeCommitment(earlier));
    record.witness(1, operator, at, encodeCommitment(commitment));
    record.witness(1, operator, laterAt, encodeCommitment(later));
    for (const r of extra) record.witness(r.kind, r.subject, r.index, r.record);
    return record.export();
  }
  function seal(records, snapshot) {
    // Recompute exact evidence even for an operator-authenticated bad proof.
    let evidence = codec.genesisEvidenceHash(segment);
    records.forEach((record, i) => { evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n); });
    snapshot = { ...snapshot, evidenceHash: evidence };
    const directory = [{ name: backing, digest: codec.snapshotDigest(snapshot) }];
    const commitment = signCommitment(operatorSecret, 3n, directoryRoot(directory));
    return { selection: { domain, venue, backing, operator, sequence: 3n, root: commitment.root,
      judgingIndex: 20n, mode: "current-fixture" },
      package: { configuration: configurationBytes, commitment: encodeCommitment(commitment), directory, directories: [before, after],
        snapshot: codec.snapshotBytes(snapshot),
        trail: codec.encodeTrail({ header, terms: [signedTerms], records: records.map(codec.encodeRecord) }, LIMITS) },
      venue: witnessed(commitment) };
  }
  function emptyPackage(fields, headerFields = {}, venueOptions = {}) {
    const terms = codec.encodeRootTerms(fields), name = codec.rootTermsName(terms);
    const h = codec.segmentBytes({ domain, venue, operator, sequence: 1n, entries: [{ backing: name, link: name }], ...headerFields });
    const emptySegment = new Uint8Array(Buffer.from(sha(h), "hex"));
    const s = { backing: name, segment: emptySegment, historyHash: codec.genesisHistoryHash(emptySegment),
      evidenceHash: codec.genesisEvidenceHash(emptySegment), issued: 0n, burned: 0n };
    const directory = [{ name, digest: codec.snapshotDigest(s) }], c = signCommitment(operatorSecret, 3n, directoryRoot(directory));
    return { selection: { domain, venue, backing: name, operator, sequence: 3n, root: c.root, judgingIndex: 20n, mode: "current-fixture" },
      package: { configuration: configurationBytes, commitment: encodeCommitment(c), directory, directories: [before, after],
        snapshot: codec.snapshotBytes(s),
        trail: codec.encodeTrail({ header: h, terms: [{ terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) }], records: [] }, LIMITS) },
      venue: witnessed(c, venueOptions) };
  }
  const records = [issue, payment, burn], effects = [
    { outputs: [funded.cm], nullifiers: [] },
    { outputs: [paid.cm, change.cm, zero1.cm, zero2.cm], nullifiers: [funded.nf, pad.nf] },
    { outputs: [burnChange.cm], nullifiers: [paid.nf, receiverPad.nf] },
  ];
  const complete = packageFor(records, effects), snapshot = codec.decodeSnapshot(complete.package.snapshot);
  // A fourth statement extends the segment: the payer spends change 3 into 2 for the receiver and change 1.
  const afterBurn = new NoteTree(); afterBurn.appendAll([funded.cm, paid.cm, change.cm, zero1.cm, zero2.cm, burnChange.cm]);
  const pad2 = output(payerSeed, 39, 0n), paid2 = output(receiverSeed, 40, 2n), change2 = output(payerSeed, 41, 1n);
  const zero3 = output(payerSeed, 42, 0n), zero4 = output(payerSeed, 43, 0n);
  const payment2 = await spend([change, pad2], [2n, 0n], [paid2, change2, zero3, zero4], "pay 2, change 1", afterBurn);
  const records4 = [...records, payment2], effects4 = [...effects, { outputs: [paid2.cm, change2.cm, zero3.cm, zero4.cm], nullifiers: [change.nf, pad2.nf] }];
  // One checkpoint of the fixture segment at a signed sequence over explicit
  // fixture effects; the committed evidence is recomputed over the supplied
  // bytes, so an authenticated bad proof stays authenticated.
  function checkpointOf(checkpointRecords, checkpointEffects, sequence, totals = { issued: 10n, burned: 5n }) {
    const t = new NoteTree(), s = new RadixSpentSet();
    let history = codec.genesisHistoryHash(segment), evidence = codec.genesisEvidenceHash(segment);
    checkpointRecords.forEach((record, i) => {
      const effect = checkpointEffects[i];
      t.appendAll(effect.outputs); effect.nullifiers.forEach(nf => { if (!s.has(fieldToBytes(nf))) s.insert(fieldToBytes(nf)); });
      history = codec.nextHistoryHash(history, codec.statementHash(record), t.root(), s.root(), BigInt(i) + 1n);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n);
    });
    const state = { backing, segment, historyHash: history, evidenceHash: evidence, ...totals };
    const directory = [{ name: backing, digest: codec.snapshotDigest(state) }];
    return { snapshot: codec.snapshotBytes(state), directory, commitment: signCommitment(operatorSecret, sequence, directoryRoot(directory)),
      trail: codec.encodeTrail({ header, terms: [signedTerms], records: checkpointRecords.map(codec.encodeRecord) }, LIMITS) };
  }
  // A package selecting one of several checkpoints of the segment, each
  // witnessed at its index, with the others' evidence packaged beside it.
  function compose(checkpoints, selected, { judgingIndex = 20n, extra = [] } = {}) {
    const record = new FixtureVenue(venue, 20n, 2n);
    record.witness(1, operator, 1n, encodeCommitment(earlier));
    for (const { checkpoint, at } of checkpoints) record.witness(1, operator, at, encodeCommitment(checkpoint.commitment));
    for (const r of extra) record.witness(r.kind, r.subject, r.index, r.record);
    const chosen = checkpoints[selected].checkpoint, rest = checkpoints.filter((_, i) => i !== selected).map(x => x.checkpoint);
    return { selection: { domain, venue, backing, operator, sequence: chosen.commitment.sequence, root: chosen.commitment.root, judgingIndex, mode: "current-fixture" },
      package: { configuration: configurationBytes, commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
        directories: [before, ...rest.map(x => x.directory)], snapshot: chosen.snapshot, snapshots: rest.map(x => x.snapshot),
        trail: chosen.trail, trails: rest.map(x => x.trail) },
      venue: record.export() };
  }
  const third = checkpointOf(records, effects, 3n), fourth = checkpointOf(records4, effects4, 4n);
  const extended = compose([{ checkpoint: third, at: 3n }, { checkpoint: fourth, at: 7n }], 1);
  // A carrying checkpoint of another segment for the same backing.
  const foreign = { backing, segment: b(50), historyHash: codec.genesisHistoryHash(b(50)), evidenceHash: codec.genesisEvidenceHash(b(50)), issued: 0n, burned: 0n };
  const foreignDirectory = [{ name: backing, digest: codec.snapshotDigest(foreign) }];
  const genesisChain = [{ operator: hex(operator), from: "0", link: hex(backing) }];
  const ruleSecret = b(87), successorSecret = b(89), rule = ed25519.getPublicKey(ruleSecret), successor = ed25519.getPublicKey(successorSecret);
  function replacementFor(name, secret, effective, predecessor = name, signer = ruleSecret) {
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(secret), predecessor, effective,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(name, fields);
    return encodeReplacement(name, { ...fields, signature: ed25519.sign(message, signer), successorSignature: ed25519.sign(message, secret) });
  }
  async function reject(payload, expected) {
    const result = await replayLocalPackage(payload, verifier, codec);
    assert.equal(result.status, "invalid-local-replay"); assert.equal(result.check, expected);
    assert.equal(result.audit, null); assert.deepEqual(result.candidates, []);
  }
  let receiver, audit;
  await test("all six candidate sources, bytecodes and retained keys match independent pins", () => {
    for (const [kind, name] of RELATION_KINDS) {
      const bad = clone(manifest); bad.sources[`${name}.nr`] = "00".repeat(32);
      assert.throws(() => checkCandidateSources(bad), /candidate identity mismatch/);
      for (const filename of [`${kind}.vk`, `${name}.json`]) {
        const path = join(build, filename), original = readFileSync(path);
        try {
          if (filename.endsWith(".vk")) {
            const changed = Buffer.from(original); changed[0] ^= 1; writeFileSync(path, changed);
          } else {
            const artifact = JSON.parse(original); const changed = Buffer.from(artifact.bytecode, "base64");
            changed[0] ^= 1; artifact.bytecode = changed.toString("base64"); writeFileSync(path, JSON.stringify(artifact));
          }
          assert.throws(() => readCandidateKeys(build, manifest), /candidate identity mismatch/);
        } finally { writeFileSync(path, original); }
      }
    }
  });
  await test("configuration substitutions and loose issuer overrides refuse before any proof", async () => {
    const beforeProof = { ...verifier, verify() { throw new Error("configuration guard ran too late"); } };
    for (const offset of [18, 18 + 5 * 64 + 32, 438]) {
      const payload = clone(complete); payload.package.configuration[offset] ^= 1;
      const result = await replayLocalPackage(payload, beforeProof, codec);
      assert.equal(result.check, "CONFIGURATION"); assert.equal(result.audit, null);
    }
    const missing = clone(complete); delete missing.package.configuration;
    assert.equal((await replayLocalPackage(missing, beforeProof, codec)).check, "CONFIGURATION");
    assert.equal((await replayLocalPackage({ ...complete, issuerKey }, beforeProof, codec)).check, "INPUT_FIELDS");
    const domainSwap = clone(complete); domainSwap.selection.domain = b(88);
    assert.equal((await replayLocalPackage(domainSwap, beforeProof, codec)).check, "CONFIGURATION");
  });
  await test("signed scoped terms refuse changed signature, payout, key and name independently", async () => {
    const replaceTerms = signed => {
      const payload = clone(complete), trail = codec.decodeTrail(payload.package.trail, LIMITS);
      payload.package.trail = codec.encodeTrail({ ...trail, terms: [signed] }, LIMITS); return payload;
    };
    const bad = clone(signedTerms); bad.signature[0] ^= 1;
    await reject(replaceTerms(bad), "TERMS_SIGNATURE");
    for (const fields of [{ ...termsFields, payout: { ...termsFields.payout, perUnit: 2n } },
      { ...termsFields, obligor: ed25519.getPublicKey(b(91)) }]) {
      const terms = codec.encodeRootTerms(fields);
      await reject(replaceTerms({ terms, signature: signedTerms.signature }), "TERMS_SIGNATURE");
      const secret = fields.obligor === issuerKey ? issuerSecret : b(91);
      await reject(replaceTerms({ terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), secret) }), "TERMS_NAME");
    }
  });
  await test("otherwise valid empty evidence cannot borrow wrong terms domain, venue or original scope", async () => {
    const empty = emptyPackage;
    const valid = await replayLocalPackage(empty(termsFields), verifier, codec);
    assert.equal(valid.status, "selected-local-replay"); assert.equal(valid.audit.outstanding, "0");
    assert.equal(valid.noMatchesMeansZeroBalance, false); assert.equal(valid.spendable, false);
    await reject(empty({ ...termsFields, configuration: b(92) }), "TERMS_CONTEXT");
    await reject(empty({ ...termsFields, venue: b(92) }), "TERMS_CONTEXT");
    await reject(empty({ ...termsFields, operator: ed25519.getPublicKey(b(92)) }), "TERMS_INITIAL_SCOPE");
    await reject(empty(termsFields, { entries: [{ backing, link: b(92) }] }), "TERMS_INITIAL_SCOPE");
  });
  await test("shared key, seed and selection storage refuses before asynchronous verification", async () => {
    for (const field of ["configuration", "seed", "domain", "trail"]) {
      const payload = { ...clone(complete), seed: clone(receiverSeed) };
      const original = field === "configuration" || field === "trail" ? payload.package[field] : field === "seed" ? receiverSeed : domain;
      const shared = new Uint8Array(new SharedArrayBuffer(original.length)); shared.set(original);
      if (field === "domain") payload.selection.domain = shared;
      else if (field === "seed") payload.seed = shared;
      else payload.package[field] = shared;
      let calls = 0;
      const mutating = { ...verifier, verify: async (...args) => {
        calls += 1;
        shared.fill(99);
        return verifier.verify(...args);
      } };
      const result = await replayLocalPackage(payload, mutating, codec);
      assert.equal(result.status, "unresolved-evidence"); assert.equal(calls, 0);
      assert.equal(result.audit, null); assert.deepEqual(result.candidates, []);
    }
  });
  await test("real proof replay derives supply 10 minus 5 and the receiver's local path to change 2", async () => {
    receiver = await replayLocalPackage({ ...complete, seed: receiverSeed }, verifier, codec);
    audit = await replayLocalPackage(complete, verifier, codec);
    assert.equal(receiver.status, "selected-local-replay"); assert.deepEqual(receiver.audit, audit.audit);
    assert.equal(audit.audit.outstanding, "5"); assert.equal(audit.audit.issued, "10"); assert.equal(audit.audit.burned, "5");
    assert.deepEqual(audit.candidates, []);
    assert.deepEqual(receiver.candidates.map(x => [x.cm, x.value]), [[burnChange.cm.toString(), "2"]]);
    const restored = receiver.candidates[0];
    assert.equal(notePathProves(BigInt(restored.anchor), BigInt(restored.cm), { siblings: restored.siblings.map(BigInt), right: restored.right }), true);
    const payer = await replayLocalPackage({ ...complete, seed: payerSeed }, verifier, codec);
    assert.deepEqual(payer.candidates.map(x => [x.cm, x.value]), [[change.cm.toString(), "3"]]);
  });
  await test("exact repeated reads agree while duplicate history records refuse", async () => {
    assert.deepEqual(await replayLocalPackage(complete, verifier, codec), audit);
    await reject(seal([issue, payment, burn, burn], snapshot), "REPEATED_STATEMENT");
  });
  await test("authenticated invalid proof, wrong proof kind and wrong issuer signature fail independently", async () => {
    const invalid = clone(burn); invalid.proof[100] ^= 1;
    await reject(seal([issue, payment, invalid], snapshot), "PROOF");
    const crossKind = clone(burn); crossKind.proof = payment.proof;
    await reject(seal([issue, payment, crossKind], snapshot), "PROOF");
    const wrongSignature = clone(issue); wrongSignature.authorization[0] ^= 1;
    await reject(seal([wrongSignature, payment, burn], snapshot), "SIGNATURE");
    await reject({ ...complete, issuerKey: ed25519.getPublicKey(b(99)) }, "INPUT_FIELDS");
  });
  await test("operator-signed false totals or history root cannot authenticate a state assertion", async () => {
    for (const bad of [{ ...snapshot, issued: 11n }, { ...snapshot, burned: 6n }, { ...snapshot, historyHash: b(77) }]) {
      await reject(seal(records, bad), "SNAPSHOT");
    }
  });
  await test("individually valid issuances cannot overflow the public u64 total", async () => {
    const maximum = output(payerSeed, 60, (1n << 64n) - 1n);
    const witness = { ...issueWitness, quantity: maximum.opening.value.toString(), cm: maximum.cm.toString(),
      owner: maximum.opening.owner.toString(), rho: maximum.opening.rho.toString(), delivery: digest([maximum]).map(String) };
    const record = await prove(1, witness, [...prefix, ...limbsOf(backing), maximum.opening.value, maximum.cm,
      ...digest([maximum])], [maximum], "valid maximum issuance");
    await reject(seal([record, issue], snapshot), "SUPPLY");
  });
  await test("a real proof for a different scope root cannot borrow the selected header", async () => {
    const differentScope = new ScopeTree([{ backing, link: b(61) }]), path = differentScope.path(0);
    const witness = { ...issueWitness, scope: differentScope.root().toString(), link: limbsOf(b(61)).map(String),
      scope_siblings: path.siblings.map(String), scope_right: path.right };
    const inputs = [...issueInputs]; inputs[4] = differentScope.root();
    const record = await prove(1, witness, inputs, [funded], "valid proof, different scope");
    await reject(seal([record], snapshot), "SCOPE");
  });
  await test("otherwise valid proof of an absent anchor refuses", async () => {
    const unused = output(payerSeed, 50, 1n);
    // A real spend against a tree containing the payer's note but never accepted
    // by this segment. Membership passes; the local forest check must reject.
    const foreignTree = new NoteTree(); foreignTree.appendAll([funded.cm, unused.cm]);
    const absent = await spend([funded, pad], [0n, 0n], [paid, change, zero1, zero2], "valid proof, unaccepted anchor", foreignTree);
    await reject(seal([issue, absent], snapshot), "ANCHOR");
  });
  await test("a distinct valid spend of a spent input refuses at the spent set", async () => {
    const repeatedOutputs = [output(payerSeed, 51, 4n), output(payerSeed, 52, 6n), output(payerSeed, 53, 0n), output(payerSeed, 54, 0n)];
    const doubleSpend = await spend([funded, pad], [0n, 0n], repeatedOutputs, "valid proof, spent input");
    await reject(seal([issue, payment, doubleSpend], snapshot), "SPENT");
  });
  await test("a separately valid spend cannot append a duplicate output", async () => {
    // Same statement with another proof is duplicate identity. To isolate the
    // output guard, use a distinct valid spend of change 3 into an existing
    // zero output plus fresh positive outputs.
    const out = [output(payerSeed, 55, 1n), output(payerSeed, 56, 2n), zero1, output(payerSeed, 57, 0n)];
    const padding = output(payerSeed, 58, 0n);
    const duplicate = await spend([change, padding], [2n, 0n], out, "valid proof, duplicate output");
    await reject(seal([issue, payment, duplicate], snapshot), "OUTPUT");
  });
  await test("replica substitution stays unresolved rather than becoming invalid local replay", async () => {
    const payload = clone(complete); payload.package.trail[payload.package.trail.length - 1] ^= 1;
    const result = await replayLocalPackage(payload, verifier, codec);
    assert.equal(result.status, "unresolved-evidence"); assert.equal(result.audit, null); assert.deepEqual(result.candidates, []);
  });
  await test("unsupported recovery records and imported openings do not produce partial audit results", async () => {
    const withdrawal = { domain, kind: 5, publicInputs: [...prefix, ...limbsOf(b(63))],
      proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] };
    const recovery = await replayLocalPackage(seal([issue, withdrawal], snapshot), verifier, codec);
    assert.equal(recovery.status, "unsupported-scope"); assert.equal(recovery.audit, null); assert.deepEqual(recovery.candidates, []);
    const payload = clone(complete), trail = clone(codec.decodeTrail(payload.package.trail, LIMITS));
    trail.header = codec.segmentBytes({ domain, venue, operator, sequence: 2n,
      entries: [{ backing, link, opening: { operator, sequence: 1n, root: b(64) } }] });
    payload.package.trail = codec.encodeTrail(trail, LIMITS);
    const imported = await replayLocalPackage(payload, verifier, codec);
    assert.equal(imported.status, "unsupported-scope"); assert.equal(imported.audit, null); assert.deepEqual(imported.candidates, []);
  });
  await test("inputs are owned across asynchronous proof verification and unexpected failures propagate", async () => {
    const payload = clone(complete); let calls = 0;
    const mutating = { ...verifier, verify: async (...args) => {
      if (calls++ === 0) { payload.selection.root.fill(0); payload.package.snapshot.fill(0); payload.package.trail.fill(0); payload.package.configuration.fill(0); }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await replayLocalPackage(payload, mutating, codec), audit);
    const failure = new Error("verifier unavailable");
    await assert.rejects(replayLocalPackage(complete, { ...verifier, verify() { throw failure; } }, codec), error => error === failure);
  });
  await test("historical replay and wrong seed never assert current spendability or a complete zero balance", async () => {
    const historical = packageFor([issue, payment], effects.slice(0, 2), { issued: 10n, burned: 0n });
    historical.selection.mode = "historical-fixture";
    const result = await replayLocalPackage({ ...historical, seed: receiverSeed }, verifier, codec);
    assert.equal(result.status, "historical-local-replay"); assert.equal(result.spendable, false);
    assert.deepEqual(result.candidates.map(x => x.value), ["7"]);
    const stale = await replayLocalPackage({ ...historical, selection: complete.selection }, verifier, codec);
    assert.equal(stale.status, "selection-mismatch"); assert.equal(stale.audit, null);
    const wrongSeed = await replayLocalPackage({ ...complete, seed: b(62) }, verifier, codec);
    assert.deepEqual(wrongSeed.candidates, []); assert.equal(wrongSeed.noMatchesMeansZeroBalance, false);
  });
  await test("fixture record ranges establish the held checkpoint, empty opening, currency, chain and revocation", async () => {
    assert.equal(audit.rangeEvidence, "fixture-verifier"); assert.equal(audit.currentRangeAuthenticated, true);
    assert.equal(audit.termsAuthorityAuthenticated, true); assert.equal(audit.fullV3Replay, false);
    assert.deepEqual(audit.audit.range, { judgingIndex: "20", lag: "2", checkpointIndex: "3", revokedAt: null, heldBefore: 1, heldAfter: 1,
      chain: genesisChain, carrying: [{ sequence: "3", index: "3", class: "valid" }], clock: null });
    // Junk at the operator's location: a forged signature, another key, a
    // repeated and a stale sequence. None is held; none is a hole (§13.3).
    const noisy = clone(complete), forged = encodeCommitment(signCommitment(operatorSecret, 2n, b(80))); forged[135] ^= 1;
    noisy.venue.records.push({ kind: 1, subject: operator, index: 2n, record: forged },
      { kind: 1, subject: operator, index: 2n, record: encodeCommitment(signCommitment(b(81), 2n, b(80))) },
      { kind: 1, subject: operator, index: 5n, record: encodeCommitment(signCommitment(operatorSecret, 3n, b(82))) },
      { kind: 1, subject: operator, index: 9n, record: encodeCommitment(signCommitment(operatorSecret, 2n, b(83))) },
      { kind: 3, subject: issuerKey, index: 4n, record: encodeRevocation(signRevocation(b(81))) });
    assert.deepEqual(await replayLocalPackage(noisy, verifier, codec), audit);
    const historical = clone(complete); historical.selection.mode = "historical-fixture"; historical.selection.judgingIndex = 8n;
    const past = await replayLocalPackage(historical, verifier, codec);
    assert.equal(past.status, "historical-local-replay"); assert.equal(past.currentRangeAuthenticated, false);
    assert.equal(past.rangeEvidence, "fixture-verifier");
    assert.deepEqual(past.audit.range, { judgingIndex: "8", lag: "2", checkpointIndex: "3", revokedAt: null, heldBefore: 1, heldAfter: 1,
      chain: genesisChain, carrying: [{ sequence: "3", index: "3", class: "valid" }], clock: null });
  });
  await test("record ranges refuse a contradicted empty opening, another segment's later checkpoint, a missing directory, a revoked issuer and a pending handover", async () => {
    // An earlier carrying commitment of this operator: of another segment it contradicts the
    // header's empty opening (C2.7.3); without its snapshot preimage the read is unresolved.
    const c1 = signCommitment(operatorSecret, 1n, directoryRoot(foreignDirectory));
    const carried = clone(complete); carried.venue.records[0] = { kind: 1, subject: operator, index: 1n, record: encodeCommitment(c1) };
    carried.package.directories = [foreignDirectory, after]; carried.package.snapshots = [codec.snapshotBytes(foreign)];
    await reject(carried, "OPENING");
    const unopened = clone(carried); unopened.package.snapshots = [];
    assert.equal((await replayLocalPackage(unopened, verifier, codec)).status, "unresolved-evidence");
    // A later carrying commitment of another segment is a scope change this experiment cannot classify.
    const c4 = signCommitment(operatorSecret, 4n, directoryRoot(foreignDirectory));
    const changed = clone(complete); changed.venue.records[2] = { kind: 1, subject: operator, index: 7n, record: encodeCommitment(c4) };
    changed.package.directories = [before, foreignDirectory]; changed.package.snapshots = [codec.snapshotBytes(foreign)];
    assert.equal((await replayLocalPackage(changed, verifier, codec)).status, "unsupported-scope");
    const unread = clone(changed); unread.package.snapshots = [];
    assert.equal((await replayLocalPackage(unread, verifier, codec)).status, "unresolved-evidence");
    const missing = clone(complete); missing.package.directories = [before];
    assert.equal((await replayLocalPackage(missing, verifier, codec)).status, "unresolved-evidence");
    const revocation = encodeRevocation(signRevocation(issuerSecret));
    for (const at of [2n, 3n]) {
      const revoked = clone(complete); revoked.venue.records.push({ kind: 3, subject: issuerKey, index: at, record: revocation });
      await reject(revoked, "REVOKED");
    }
    const revokedLater = clone(complete); revokedLater.venue.records.push({ kind: 3, subject: issuerKey, index: 10n, record: revocation });
    const later = await replayLocalPackage(revokedLater, verifier, codec);
    assert.equal(later.status, "selected-local-replay"); assert.equal(later.audit.range.revokedAt, "10");
    const ruled = emptyPackage({ ...termsFields, replacementRule: rule }), name = ruled.selection.backing;
    assert.equal((await replayLocalPackage(ruled, verifier, codec)).status, "selected-local-replay");
    // A handover effective after t is pending: the original is in force throughout the range.
    const pending = clone(ruled); pending.venue.records.push({ kind: 2, subject: name, index: 5n, record: replacementFor(name, successorSecret, 40n) });
    const notYet = await replayLocalPackage(pending, verifier, codec);
    assert.equal(notYet.status, "selected-local-replay");
    assert.deepEqual(notYet.audit.range.chain, [{ operator: hex(operator), from: "0", link: hex(name) }]);
    const strangers = clone(ruled);
    strangers.venue.records.push({ kind: 2, subject: name, index: 5n, record: replacementFor(name, successorSecret, 40n, name, b(90)) });
    assert.equal((await replayLocalPackage(strangers, verifier, codec)).status, "selected-local-replay");
    const unruled = clone(complete); unruled.venue.records.push({ kind: 2, subject: backing, index: 5n, record: replacementFor(backing, successorSecret, 15n) });
    assert.deepEqual(await replayLocalPackage(unruled, verifier, codec), audit);
  });
  await test("the chain from kind-2 answers fixes the party in force: lead floor, supersession, revocation, term end and a successor's commitments", async () => {
    const otherSecret = b(95), otherSuccessor = ed25519.getPublicKey(otherSecret), ruledFields = { ...termsFields, replacementRule: rule };
    const name = emptyPackage(ruledFields).selection.backing, kind2 = (index, record) => ({ kind: 2, subject: name, index, record });
    const withRecords = (extra, options = {}) => emptyPackage(ruledFields, {}, { ...options, extra });
    const inForce = kind2(5n, replacementFor(name, successorSecret, 15n));
    // In force from 15 the original's term ends at 14; its checkpoint at 3 is still the snapshot at 20.
    const handover = await replayLocalPackage(withRecords([inForce]), verifier, codec);
    assert.equal(handover.status, "selected-local-replay");
    assert.deepEqual(handover.audit.range.chain.map(l => [l.operator, l.from]), [[hex(operator), "0"], [hex(successor), "15"]]);
    // The selection witnessed at or after its term's end is lapsed, whatever its trail (C2.10.11).
    assert.equal((await replayLocalPackage(withRecords([inForce], { at: 15n, laterAt: 18n }), verifier, codec)).status, "lapsed-selection");
    assert.equal((await replayLocalPackage(withRecords([inForce], { at: 14n, laterAt: 18n }), verifier, codec)).status, "selected-local-replay");
    // Below the lead floor (witnessed at 5 with lag 2, so 10) a record is no replacement (C2.5.3).
    const early = await replayLocalPackage(withRecords([kind2(5n, replacementFor(name, successorSecret, 9n))]), verifier, codec);
    assert.equal(early.status, "selected-local-replay"); assert.equal(early.audit.range.chain.length, 1);
    // A later record witnessed before the standing candidate's force supersedes it (C2.5.5); naming the incumbent revokes (C2.5.4).
    const superseded = await replayLocalPackage(withRecords([inForce, kind2(8n, replacementFor(name, otherSecret, 13n))]), verifier, codec);
    assert.deepEqual(superseded.audit.range.chain.map(l => [l.operator, l.from]), [[hex(operator), "0"], [hex(otherSuccessor), "13"]]);
    const revoked = await replayLocalPackage(withRecords([inForce, kind2(8n, replacementFor(name, operatorSecret, 13n))]), verifier, codec);
    assert.equal(revoked.status, "selected-local-replay"); assert.equal(revoked.audit.range.chain.length, 1);
    // The successor's commitments in its term are read by their directories: a carrying one opens a segment this experiment cannot classify.
    const idle = { kind: 1, subject: successor, index: 18n, record: encodeCommitment(signCommitment(successorSecret, 1n, directoryRoot(after))) };
    assert.equal((await replayLocalPackage(withRecords([inForce, idle]), verifier, codec)).status, "selected-local-replay");
    const carryingDirectory = [{ name, digest: b(86) }], took = signCommitment(successorSecret, 1n, directoryRoot(carryingDirectory));
    const taken = withRecords([inForce, { kind: 1, subject: successor, index: 18n, record: encodeCommitment(took) }]);
    taken.package.directories = [before, after, carryingDirectory];
    assert.equal((await replayLocalPackage(taken, verifier, codec)).status, "unsupported-scope");
    const undirected = withRecords([inForce, { kind: 1, subject: successor, index: 18n, record: encodeCommitment(took) }]);
    assert.equal((await replayLocalPackage(undirected, verifier, codec)).status, "unresolved-evidence");
    // Inside its lead time the successor's commitment is not read (C2.7.1); neither is the original's after its term.
    const leading = withRecords([inForce, { kind: 1, subject: successor, index: 12n, record: encodeCommitment(took) }]);
    assert.equal((await replayLocalPackage(leading, verifier, codec)).status, "selected-local-replay");
    const stale = { kind: 1, subject: operator, index: 18n, record: encodeCommitment(signCommitment(operatorSecret, 5n, directoryRoot(carryingDirectory))) };
    const afterTerm = await replayLocalPackage(withRecords([inForce, stale]), verifier, codec);
    assert.equal(afterTerm.status, "selected-local-replay"); assert.equal(afterTerm.audit.range.heldAfter, 1);
    // A key named twice holds two terms (C2.5.8): between them the selection is lapsed, in the second it opens a segment this
    // experiment does not read, and in the first it is the snapshot still.
    const firstLink = replacementHash(name, decodeReplacement(inForce.record).replacement);
    const back = kind2(12n, replacementFor(name, operatorSecret, 17n, firstLink));
    const twice = await replayLocalPackage(withRecords([inForce, back]), verifier, codec);
    assert.equal(twice.status, "selected-local-replay"); assert.deepEqual(twice.audit.range.chain.map(l => l.from), ["0", "15", "17"]);
    assert.equal((await replayLocalPackage(withRecords([inForce, back], { at: 16n, laterAt: 19n }), verifier, codec)).status, "lapsed-selection");
    assert.equal((await replayLocalPackage(withRecords([inForce, back], { at: 18n, laterAt: 19n }), verifier, codec)).status, "unsupported-scope");
    // Read at an earlier index the handover is pending and the chain is the genesis link.
    const pastRead = withRecords([inForce]); pastRead.selection.mode = "historical-fixture"; pastRead.selection.judgingIndex = 10n;
    const past = await replayLocalPackage(pastRead, verifier, codec);
    assert.equal(past.status, "historical-local-replay"); assert.equal(past.audit.range.chain.length, 1);
    // A handover in force changes no opening verdict at an index where the original was in force.
    const foreignName = { ...foreign, backing: name }, foreignNameDirectory = [{ name, digest: codec.snapshotDigest(foreignName) }];
    const contradicted = withRecords([inForce]);
    contradicted.venue.records[0] = { kind: 1, subject: operator, index: 1n, record: encodeCommitment(signCommitment(operatorSecret, 1n, directoryRoot(foreignNameDirectory))) };
    contradicted.package.directories = [foreignNameDirectory, after]; contradicted.package.snapshots = [codec.snapshotBytes(foreignName)];
    await reject(contradicted, "OPENING");
  });
  await test("the no-commitment clock reads the classified carrying checkpoints, and silence retires the segment (C2b.6.1, C2b.4.1)", async () => {
    // Empty-segment checkpoints under terms declaring a clause: the opening checkpoint at sequence 1 carries
    // the backing with its empty state (C2b.4.1), and every later one carries the same empty snapshot, so
    // classification and the clock turn on witnessed indices and committed totals alone.
    const openingAt = 1n, checkpoint = (sequence, at, totals, foreign = false) => ({ sequence, at, foreign, ...(totals === undefined ? {} : { totals }) });
    function silentPackage({ duration = 10n, checkpoints = [checkpoint(3n, 3n)], selected = 0, judgingIndex = 20n, mode = "current-fixture",
      opens = true, headerSequence = 1n, openingAtIndex = openingAt, openingTotals, extra = [] } = {}) {
      const fields = { ...termsFields, silence: { noCommitmentDuration: duration, challengeWindow: 5n } };
      const terms = codec.encodeRootTerms(fields), name = codec.rootTermsName(terms);
      const segmentOf = sequence => new Uint8Array(Buffer.from(sha(codec.segmentBytes({ domain, venue, operator, sequence, entries: [{ backing: name, link: name }] })), "hex"));
      const h = codec.segmentBytes({ domain, venue, operator, sequence: headerSequence, entries: [{ backing: name, link: name }] });
      const emptySegment = segmentOf(headerSequence), foreignSegment = segmentOf(9n);
      const signed = { terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) };
      const trailBytes = codec.encodeTrail({ header: h, terms: [signed], records: [] }, LIMITS);
      const all = opens === true ? [checkpoint(headerSequence, openingAtIndex, openingTotals), ...checkpoints] : checkpoints, chosenAt = opens === true ? selected + 1 : selected;
      const built = all.map(({ sequence, at, totals = { issued: 0n, burned: 0n }, foreign }) => {
        const segment = foreign ? foreignSegment : emptySegment;
        const s = { backing: name, segment, historyHash: codec.genesisHistoryHash(segment), evidenceHash: codec.genesisEvidenceHash(segment), ...totals };
        const directory = [{ name, digest: codec.snapshotDigest(s) }];
        return { at, snapshot: codec.snapshotBytes(s), directory, commitment: signCommitment(operatorSecret, sequence, directoryRoot(directory)) };
      });
      const record = new FixtureVenue(venue, 20n, 2n);
      // "other": the operator's sequence 1 carries another backing, as in the proof fixtures; false: nothing at the opening sequence.
      if (opens === "other") record.witness(1, operator, openingAt, encodeCommitment(earlier));
      for (const c of built) record.witness(1, operator, c.at, encodeCommitment(c.commitment));
      for (const e of extra) record.witness(1, operator, e.at, encodeCommitment(signCommitment(operatorSecret, e.sequence, directoryRoot(e.directory))));
      const chosen = built[chosenAt], rest = built.filter((_, i) => i !== chosenAt);
      // Checkpoints sharing the empty snapshot share one payload; the §12 inventory carries each once.
      const distinct = (items, key) => items.filter((item, i) => items.findIndex(other => key(other) === key(item)) === i);
      const snapshots = distinct(rest.map(x => x.snapshot), hex).filter(s => hex(s) !== hex(chosen.snapshot));
      const directories = distinct([...rest.map(x => x.directory), ...extra.map(e => e.directory)], d => hex(directoryRoot(d)))
        .filter(d => hex(directoryRoot(d)) !== hex(directoryRoot(chosen.directory)));
      return { selection: { domain, venue, backing: name, operator, sequence: chosen.commitment.sequence, root: chosen.commitment.root, judgingIndex, mode },
        package: { configuration: configurationBytes, commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
          directories: [before, ...directories], snapshot: chosen.snapshot, snapshots, trail: trailBytes, trails: [] },
        venue: record.export() };
    }
    const silentName = duration => codec.rootTermsName(codec.encodeRootTerms({ ...termsFields, silence: { noCommitmentDuration: duration, challengeWindow: 5n } }));
    const clockOf = result => result.audit.range.clock, classes = result => result.audit.range.carrying.map(c => c.class);
    const clock = (duration, snapshotIndex, gap, open, boundary, opening = "1") => ({ duration, snapshotIndex, gap, open, boundary, opening });
    const settled = async (input, expected = "selected-local-replay", check = null) => {
      const result = await replayLocalPackage(input, verifier, codec);
      assert.equal(result.status, expected, `${result.status} ${result.check}`); assert.equal(result.check ?? null, check);
      return result;
    };
    // The opening checkpoint at index 1 closes the interval that ran from index zero; the selection at 3 is the snapshot at 20.
    const single = await settled(silentPackage());
    assert.deepEqual(classes(single), ["valid", "valid"]);
    assert.deepEqual(clockOf(single), clock("10", "3", "17", true, "14"));
    assert.deepEqual(clockOf(await settled(silentPackage({ duration: 20n }))), clock("20", "3", "17", false, null));
    // A continuation witnessed after the boundary is lapsed for its whole scope: selecting it refuses with the clock
    // record proving the lapse, and the earlier checkpoint stays the snapshot.
    const pair = [checkpoint(3n, 3n), checkpoint(4n, 15n)];
    const lapsed = await settled(silentPackage({ checkpoints: pair, selected: 1 }), "lapsed-selection");
    assert.equal(lapsed.audit, null); assert.deepEqual(lapsed.clock, clock("10", "3", "12", true, "14"));
    const kept = await settled(silentPackage({ checkpoints: pair }));
    assert.deepEqual(classes(kept), ["valid", "valid", "lapsed"]);
    assert.deepEqual(clockOf(kept), clock("10", "3", "17", true, "14"));
    // Witnessed at the last index the duration allows, a checkpoint closes the interval and supersedes.
    const inTime = [checkpoint(3n, 3n), checkpoint(4n, 13n)];
    await settled(silentPackage({ checkpoints: inTime }), "superseded-selection");
    assert.deepEqual(clockOf(await settled(silentPackage({ checkpoints: inTime, selected: 1 }))), clock("10", "13", "7", false, null));
    // Two at one index after the gap opened both lapse; the same-index rule shows where a checkpoint stands at the
    // judging index itself: it is not strictly before it, so the snapshot at that index is the opening.
    const twinned = await settled(silentPackage({ checkpoints: [checkpoint(3n, 3n), checkpoint(4n, 14n), checkpoint(5n, 14n)] }));
    assert.deepEqual(classes(twinned), ["valid", "valid", "lapsed", "lapsed"]);
    const atJudging = await settled(silentPackage({ checkpoints: [checkpoint(3n, 11n)], judgingIndex: 11n, mode: "historical-fixture" }), "historical-local-replay");
    assert.deepEqual(classes(atJudging), ["valid", "valid"]); assert.deepEqual(clockOf(atJudging), clock("10", "1", "10", false, null));
    // Non-opening checkpoints at the opening's own index lapse under a zero duration whatever their sequence order.
    const sameIndex = await settled(silentPackage({ duration: 0n, checkpoints: [checkpoint(2n, 1n), checkpoint(3n, 1n)], selected: -1 }));
    assert.deepEqual(classes(sameIndex), ["valid", "lapsed", "lapsed"]); assert.deepEqual(clockOf(sameIndex), clock("0", "1", "19", true, "2"));
    // An excluded checkpoint closes nothing, so the next lapses; valid, it closes and the next stands.
    const broken = [checkpoint(3n, 3n), checkpoint(4n, 8n, { issued: 1n, burned: 0n }), checkpoint(5n, 15n)];
    const passed = await settled(silentPackage({ checkpoints: broken }));
    assert.deepEqual(passed.audit.range.carrying.map(c => [c.class, c.check ?? null]), [["valid", null], ["valid", null], ["excluded", "SNAPSHOT"], ["lapsed", null]]);
    assert.deepEqual(clockOf(passed), clock("10", "3", "17", true, "14"));
    const standing = await settled(silentPackage({ checkpoints: [checkpoint(3n, 3n), checkpoint(4n, 8n), checkpoint(5n, 15n)], selected: 2 }));
    assert.deepEqual(classes(standing), ["valid", "valid", "valid", "valid"]);
    assert.deepEqual(clockOf(standing), clock("10", "15", "5", false, null));
    // An excluded opening anchors the boundary but closes nothing: the clock runs from index zero.
    const openingBroken = { issued: 1n, burned: 0n };
    const unclosed = await settled(silentPackage({ openingTotals: openingBroken }));
    assert.deepEqual(classes(unclosed), ["excluded", "valid"]); assert.deepEqual(clockOf(unclosed), clock("10", "3", "17", true, "14"));
    const fromZero = await settled(silentPackage({ openingTotals: openingBroken, duration: 2n }), "lapsed-selection");
    assert.deepEqual(fromZero.clock, clock("2", "0", "3", true, "3"));
    // Read at an earlier index the boundary is not reached.
    const then = await settled(silentPackage({ judgingIndex: 12n, mode: "historical-fixture" }), "historical-local-replay");
    assert.deepEqual(clockOf(then), clock("10", "3", "9", false, null));
    // A zero duration: only the opening ever stands, and the gap opens at the index after it.
    const zero = await settled(silentPackage({ duration: 0n, selected: -1 }));
    assert.deepEqual(classes(zero), ["valid", "lapsed"]); assert.deepEqual(clockOf(zero), clock("0", "1", "19", true, "2"));
    // The first carrying checkpoint after the opening is judged from the opening, not from index zero.
    const late = await settled(silentPackage({ duration: 5n, checkpoints: [checkpoint(3n, 6n)] }));
    assert.deepEqual(classes(late), ["valid", "valid"]); assert.deepEqual(clockOf(late), clock("5", "6", "14", true, "12"));
    await settled(silentPackage({ duration: 4n, checkpoints: [checkpoint(3n, 6n)] }), "lapsed-selection");
    // A lower-sequence carrying checkpoint contradicts the empty opening before any clock is read (C2.7.3), and a
    // checkpoint of another segment witnessed after the boundary is that segment's, not a lapse of this one.
    const earlierSegment = { sequence: 1n, at: 6n, directory: [{ name: silentName(5n), digest: b(86) }] };
    await settled(silentPackage({ duration: 5n, headerSequence: 2n, openingAtIndex: 7n, checkpoints: [checkpoint(3n, 8n)], extra: [earlierSegment] }), "invalid-local-replay", "OPENING");
    await settled(silentPackage({ checkpoints: [checkpoint(3n, 3n), checkpoint(4n, 15n, undefined, true)] }), "unsupported-scope");
    // An opening carrying nothing for the backing is a contradiction the record proves; an opening the record does
    // not hold is missing evidence; without ranges the clock is not read.
    await settled(silentPackage({ opens: "other" }), "invalid-local-replay", "OPENING");
    await settled(silentPackage({ opens: false }), "unresolved-evidence");
    const { venue: _unread, ...noVenue } = silentPackage();
    await settled(noVenue, "unsupported-scope");
    // The portable package reads the same clock.
    assert.deepEqual((await replayEvidencePackage(portable(silentPackage({ checkpoints: pair })), verifier, codec)).audit.range.clock, clockOf(kept));
  });
  await test("record ranges are the verifier's own: another venue, an unwitnessed index, a stale answer or an unheld selection cannot certify", async () => {
    const elsewhere = clone(complete); elsewhere.venue.id = b(13);
    assert.equal((await replayLocalPackage(elsewhere, verifier, codec)).status, "unresolved-evidence");
    const future = clone(complete); future.selection.judgingIndex = 21n;
    assert.equal((await replayLocalPackage(future, verifier, codec)).status, "unresolved-evidence");
    const notNow = clone(complete); notNow.selection.judgingIndex = 15n;
    assert.equal((await replayLocalPackage(notNow, verifier, codec)).status, "unresolved-evidence");
    const unheld = clone(complete); unheld.venue.records.splice(1, 1);
    assert.equal((await replayLocalPackage(unheld, verifier, codec)).status, "selection-mismatch");
    // Another root at sequence 3 and index 3: the lesser record bytes stand for the sequence (§13.3).
    const selected = complete.package.commitment;
    let twin, fill = 91;
    do { twin = encodeCommitment(signCommitment(operatorSecret, 3n, b(fill++))); } while (Buffer.compare(twin, selected) > 0);
    const outranked = clone(complete); outranked.venue.records.splice(1, 0, { kind: 1, subject: operator, index: 3n, record: twin });
    assert.equal((await replayLocalPackage(outranked, verifier, codec)).status, "selection-mismatch");
    do { twin = encodeCommitment(signCommitment(operatorSecret, 3n, b(fill++))); } while (Buffer.compare(twin, selected) < 0);
    const outranking = clone(complete); outranking.venue.records.splice(1, 0, { kind: 1, subject: operator, index: 3n, record: twin });
    assert.deepEqual(await replayLocalPackage(outranking, verifier, codec), audit);
    const stale = { ...verifier, record: data => {
      const own = verifier.record(data);
      return { ...own, range: request => own.range({ ...request, toIndex: request.toIndex - 1n }) };
    } };
    assert.equal((await replayLocalPackage(complete, stale, codec)).status, "unresolved-evidence");
    const silent = { ...verifier, record: () => ({ range: () => undefined, witnessedIndex: () => 20n, lag: () => 2n }) };
    assert.equal((await replayLocalPackage(complete, silent, codec)).status, "unresolved-evidence");
    // A flood at the operator's location beyond the reader's entry budget is a resource refusal, never a verdict.
    const flooded = clone(complete), junk = new Uint8Array(136).fill(7);
    for (let i = 0; i <= Number(RANGE_LIMITS.maxEntries); i++) flooded.venue.records.push({ kind: 1, subject: operator, index: 2n, record: junk });
    const refusal = await replayLocalPackage(flooded, verifier, codec);
    assert.equal(refusal.status, "resource-refusal"); assert.equal(refusal.audit, null);
    assert.equal((await replayLocalPackage(complete, { configuration, verify: verifier.verify }, codec)).status, "unresolved-evidence");
    const failure = new Error("range service unavailable");
    await assert.rejects(replayLocalPackage(complete, { ...verifier, record: () => ({ range() { throw failure; }, witnessedIndex: () => 20n, lag: () => 2n }) }, codec), error => error === failure);
    const { venue: omitted, ...withoutVenue } = complete;
    assert.equal(omitted.records.length, 3);
    const plain = await replayLocalPackage(withoutVenue, verifier, codec);
    assert.equal(plain.status, "selected-local-replay"); assert.equal(plain.rangeEvidence, "none");
    assert.equal(plain.currentRangeAuthenticated, false); assert.equal(plain.termsAuthorityAuthenticated, false); assert.equal(plain.audit.range, null);
    assert.equal((await replayEvidencePackage(portable(withoutVenue), verifier, codec)).status, "unsupported-scope");
  });
  let dependency;
  await test("a second checkpoint of the segment is classified from its own trail and extends the last valid prefix (C2.10.4, C2.10.12)", async () => {
    dependency = await replayLocalPackage(extended, verifier, codec);
    assert.equal(dependency.status, "selected-local-replay"); assert.equal(dependency.audit.records, "4"); assert.equal(dependency.audit.outstanding, "5");
    assert.deepEqual(dependency.audit.range, { judgingIndex: "20", lag: "2", checkpointIndex: "7", revokedAt: null, heldBefore: 2, heldAfter: 0, chain: genesisChain,
      carrying: [{ sequence: "3", index: "3", class: "valid" }, { sequence: "4", index: "7", class: "valid" }], clock: null });
    const receiver2 = await replayLocalPackage({ ...extended, seed: receiverSeed }, verifier, codec);
    assert.deepEqual(receiver2.candidates.map(x => [x.cm, x.value]), [[burnChange.cm.toString(), "2"], [paid2.cm.toString(), "2"]]);
    const payer2 = await replayLocalPackage({ ...extended, seed: payerSeed }, verifier, codec);
    assert.deepEqual(payer2.candidates.map(x => [x.cm, x.value]), [[change2.cm.toString(), "1"]]);
    // The earlier checkpoint is behind a valid later one: not current (C2.7.5), though it is the snapshot at an earlier index.
    const behind = compose([{ checkpoint: third, at: 3n }, { checkpoint: fourth, at: 7n }], 0);
    assert.equal((await replayLocalPackage(behind, verifier, codec)).status, "superseded-selection");
    const earlierRead = clone(behind); earlierRead.selection.mode = "historical-fixture"; earlierRead.selection.judgingIndex = 5n;
    const then = await replayLocalPackage(earlierRead, verifier, codec);
    assert.equal(then.status, "historical-local-replay"); assert.deepEqual(then.audit.range.carrying, [{ sequence: "3", index: "3", class: "valid" }]);
    // At one index the lower sequence is the higher one's own prefix (C2.10.4).
    const sameIndex = [{ checkpoint: third, at: 7n }, { checkpoint: fourth, at: 7n }];
    const together = await replayLocalPackage(compose(sameIndex, 1), verifier, codec);
    assert.equal(together.status, "selected-local-replay"); assert.equal(together.audit.range.checkpointIndex, "7");
    assert.deepEqual(together.audit.range.carrying.map(c => c.class), ["valid", "valid"]);
    assert.equal((await replayLocalPackage(compose(sameIndex, 0), verifier, codec)).status, "superseded-selection");
    // A re-commitment of the same state extends its own length.
    const repeated = await replayLocalPackage(compose([{ checkpoint: third, at: 3n }, { checkpoint: checkpointOf(records, effects, 4n), at: 7n }], 1), verifier, codec);
    assert.equal(repeated.status, "selected-local-replay"); assert.deepEqual(repeated.audit.range.carrying.map(c => c.class), ["valid", "valid"]);
    // K's revocation voids only issuance witnessed at or after it (C2b.1): a prefix a valid checkpoint finalized before it stands.
    const pair = [{ checkpoint: third, at: 3n }, { checkpoint: fourth, at: 7n }], revocation = encodeRevocation(signRevocation(issuerSecret));
    const revokedBetween = { extra: [{ kind: 3, subject: issuerKey, index: 5n, record: revocation }] };
    const continued = await replayLocalPackage(compose(pair, 1, revokedBetween), verifier, codec);
    assert.equal(continued.status, "selected-local-replay"); assert.equal(continued.audit.range.revokedAt, "5");
    assert.deepEqual(continued.audit.range.carrying.map(c => c.class), ["valid", "valid"]);
    assert.equal((await replayLocalPackage(compose(pair, 0, revokedBetween), verifier, codec)).status, "superseded-selection");
    // Revoked at the first checkpoint's index, it is excluded and the later one witnesses the issuance anew, after the revocation.
    const revokedAtFirst = { extra: [{ kind: 3, subject: issuerKey, index: 3n, record: revocation }] };
    await reject(compose(pair, 1, revokedAtFirst), "REVOKED");
    await reject(compose(pair, 0, revokedAtFirst), "REVOKED");
    // A carrying checkpoint naming other backings too is outside the experiment's one-backing scope, as a selection is.
    const wideDirectory = [{ name: backing, digest: third.directory[0].digest }, { name: otherName, digest: b(79) }].sort((x, y) => Buffer.compare(x.name, y.name));
    const wide = clone(extended);
    wide.venue.records[1] = { kind: 1, subject: operator, index: 3n, record: encodeCommitment(signCommitment(operatorSecret, 3n, directoryRoot(wideDirectory))) };
    wide.package.directories = [before, wideDirectory];
    assert.equal((await replayLocalPackage(wide, verifier, codec)).status, "unsupported-scope");
  });
  await test("excluded checkpoints are passed: a stale twin, diverging evidence or a bad suffix never moves the last valid prefix (C2.10.12)", async () => {
    const corrupt = record => { const bad = clone(record); bad.proof[100] ^= 1; return bad; };
    const twin = checkpointOf(records.slice(0, 2), effects.slice(0, 2), 4n, { issued: 10n, burned: 0n });
    const diverging = checkpointOf([issue, payment, corrupt(burn)], effects, 4n);
    const badSuffix = checkpointOf([...records, corrupt(payment2)], effects4, 4n);
    for (const [checkpoint, check] of [[twin, "CONTINUITY"], [diverging, "CONTINUITY"], [badSuffix, "PROOF"]]) {
      const passed = await replayLocalPackage(compose([{ checkpoint: third, at: 3n }, { checkpoint, at: 7n }], 0), verifier, codec);
      assert.equal(passed.status, "selected-local-replay"); assert.equal(passed.currentRangeAuthenticated, true);
      assert.deepEqual(passed.audit.range.carrying, [{ sequence: "3", index: "3", class: "valid" }, { sequence: "4", index: "7", class: "excluded", check }]);
      assert.deepEqual(passed.audit, { ...audit.audit, range: passed.audit.range });
      // Selected, the same checkpoint refuses on its own check.
      await reject(compose([{ checkpoint: third, at: 3n }, { checkpoint, at: 7n }], 1), check);
    }
    // An excluded earlier checkpoint is passed inside the segment: the next valid one extends the last valid prefix before it, here none.
    const badThird = checkpointOf([issue, payment, corrupt(burn)], effects, 3n);
    const repaired = await replayLocalPackage(compose([{ checkpoint: badThird, at: 3n }, { checkpoint: fourth, at: 7n }], 1), verifier, codec);
    assert.equal(repaired.status, "selected-local-replay");
    assert.deepEqual(repaired.audit.range.carrying, [{ sequence: "3", index: "3", class: "excluded", check: "PROOF" }, { sequence: "4", index: "7", class: "valid" }]);
    assert.deepEqual({ ...repaired.audit, range: null }, { ...dependency.audit, range: null });
    const shorter = await replayLocalPackage(compose([{ checkpoint: badThird, at: 3n }, { checkpoint: twin, at: 7n }], 1), verifier, codec);
    assert.equal(shorter.status, "selected-local-replay"); assert.equal(shorter.audit.records, "2");
    assert.deepEqual(shorter.audit.range.carrying.map(c => c.class), ["excluded", "valid"]);
    // Three checkpoints with the middle one excluded: the last extends the first.
    const three = [{ checkpoint: third, at: 3n }, { checkpoint: diverging, at: 7n }, { checkpoint: checkpointOf(records4, effects4, 5n), at: 12n }];
    const last = await replayLocalPackage(compose(three, 2), verifier, codec);
    assert.equal(last.status, "selected-local-replay"); assert.deepEqual(last.audit.range.carrying.map(c => c.class), ["valid", "excluded", "valid"]);
    assert.equal((await replayLocalPackage(compose(three, 0), verifier, codec)).status, "superseded-selection");
    assert.equal((await replayLocalPackage(compose(three, 1), verifier, codec)).status, "invalid-local-replay");
  });
  await test("dependency evidence must be complete and authenticated: missing, substituted or ambiguous snapshots and trails leave the read unresolved", async () => {
    const without = key => { const p = clone(extended); p.package[key] = []; return p; };
    assert.equal((await replayLocalPackage(without("snapshots"), verifier, codec)).status, "unresolved-evidence");
    assert.equal((await replayLocalPackage(without("trails"), verifier, codec)).status, "unresolved-evidence");
    const substituted = clone(extended); substituted.package.trails[0][substituted.package.trails[0].length - 1] ^= 1;
    assert.equal((await replayLocalPackage(substituted, verifier, codec)).status, "unresolved-evidence");
    // Two trails authenticate one snapshot's evidence, since the terms signature is outside the chain: ambiguous, so unsupported.
    const decoded = codec.decodeTrail(third.trail, LIMITS), badTerms = clone(signedTerms); badTerms.signature[0] ^= 1;
    const other = codec.encodeTrail({ ...decoded, terms: [badTerms] }, LIMITS);
    const ambiguous = clone(extended); ambiguous.package.trails = [third.trail, other];
    assert.equal((await replayLocalPackage(ambiguous, verifier, codec)).status, "unsupported-scope");
    const unsigned = clone(extended); unsigned.package.trails = [other];
    assert.equal((await replayLocalPackage(unsigned, verifier, codec)).status, "unresolved-evidence");
    // A trail that does not decode is no evidence for any checkpoint and does not block the read, in either form.
    const junk = clone(extended); junk.package.trails.push(new Uint8Array(40).fill(3));
    assert.deepEqual(await replayLocalPackage(junk, verifier, codec), dependency);
    assert.deepEqual(await replayEvidencePackage(portable(junk), verifier, codec), dependency);
    // Dependencies are resolved before any proof: nothing partial.
    const beforeProof = { ...verifier, verify() { throw new Error("dependency guard ran too late"); } };
    assert.equal((await replayLocalPackage(without("snapshots"), beforeProof, codec)).status, "unresolved-evidence");
    const undirected = clone(extended); undirected.package.directories = [before];
    assert.equal((await replayLocalPackage(undirected, verifier, codec)).status, "unresolved-evidence");
    // The portable form carries every snapshot and trail; the fresh reader resolves the selection and its dependencies by hash.
    assert.deepEqual(await replayEvidencePackage(portable(extended), verifier, codec), dependency);
    assert.deepEqual(await replayEvidencePackage(portable({ ...extended, seed: receiverSeed }), verifier, codec),
      await replayLocalPackage({ ...extended, seed: receiverSeed }, verifier, codec));
    const packed = portable(extended), items = codec.decodeEvidencePackage(packed.package, PACKAGE_LIMITS);
    assert.equal(items.filter(i => i.kind === 4).length, 2); assert.equal(items.filter(i => i.kind === 6).length, 2);
    for (const [kind, payload] of [[4, third.snapshot], [6, third.trail]]) {
      const dropped = items.filter(item => !(item.kind === kind && Buffer.compare(item.payload, payload) === 0));
      assert.equal((await replayEvidencePackage({ ...packed, package: codec.encodeEvidencePackage(dropped, PACKAGE_LIMITS) }, verifier, codec)).status, "unresolved-evidence");
    }
    const { venue: omitted, ...withoutVenue } = extended;
    assert.equal(omitted.records.length, 3);
    assert.equal((await replayEvidencePackage(portable(withoutVenue), verifier, codec)).status, "unsupported-scope");
  });
  await test("canonical evidence package replays the same audit and receiver through one engine", async () => {
    assert.deepEqual(await replayEvidencePackage(portable(complete), verifier, codec), audit);
    assert.deepEqual(await replayEvidencePackage(portable({ ...complete, seed: receiverSeed }), verifier, codec), receiver);
    const historical = portable({ ...complete, selection: { ...complete.selection, mode: "historical-fixture" } });
    assert.equal((await replayEvidencePackage(historical, verifier, codec)).status, "historical-local-replay");
  });
  await test("missing, conflicting, unsupported and resource-limited package evidence returns no partial result", async () => {
    const packed = portable(complete), items = codec.decodeEvidencePackage(packed.package, PACKAGE_LIMITS);
    const beforeProof = { ...verifier, verify() { throw new Error("package guard ran too late"); } };
    async function refuse(p, status) {
      const result = await replayEvidencePackage(p, beforeProof, codec);
      assert.equal(result.status, status); assert.equal(result.audit, null); assert.deepEqual(result.candidates, []);
      assert.equal(result.spendable, false); assert.equal(result.currentRangeAuthenticated, false);
    }
    for (let i = 0; i < items.length; i++) {
      await refuse({ ...packed, package: codec.encodeEvidencePackage(items.filter((_, j) => i !== j), PACKAGE_LIMITS) }, "unresolved-evidence");
    }
    const order = entries => entries.sort((a, b) => a.kind - b.kind || Buffer.compare(Buffer.from(sha(a.payload), "hex"), Buffer.from(sha(b.payload), "hex")));
    const other = { kind: 2, payload: encodeCommitment(signCommitment(operatorSecret, 4n, b(94))) };
    await refuse({ ...packed, package: codec.encodeEvidencePackage(order([...items, other]), PACKAGE_LIMITS) }, "unsupported-scope");
    const claimedRange = { kind: 11, payload: Buffer.from('{"complete":true,"final":true}') };
    await refuse({ ...packed, package: codec.encodeEvidencePackage([...items, claimedRange], PACKAGE_LIMITS) }, "unsupported-scope");
    await refuse({ ...packed, package: new Uint8Array(Number(PACKAGE_LIMITS.maxBytes) + 1) }, "resource-refusal");
    const originalClone = globalThis.structuredClone;
    try {
      globalThis.structuredClone = () => { throw new Error("unbounded input reached ownership copy"); };
      await refuse({ ...packed, package: new Uint8Array(Number(PACKAGE_LIMITS.maxBytes) + 1) }, "resource-refusal");
      await refuse({ ...packed, selection: { ...packed.selection, extra: new Uint8Array(2048) } }, "unresolved-evidence");
      await refuse({ ...packed, seed: new Uint8Array(33) }, "unresolved-evidence");
    } finally { globalThis.structuredClone = originalClone; }
    await refuse({ ...packed, package: packed.package.subarray(0, packed.package.length - 1) }, "unresolved-evidence");
    await refuse({ ...packed, package: complete.package }, "unresolved-evidence");
    await refuse({ ...packed, complete: true }, "invalid-local-replay");
    for (const tag of [2, 3, 4, 6]) {
      const changed = items.map(item => ({ ...item, payload: new Uint8Array(item.payload) }));
      const entry = changed.find(item => item.kind === tag); entry.payload[entry.payload.length - 1] ^= 1;
      await refuse({ ...packed, package: codec.encodeEvidencePackage(canonical(changed), PACKAGE_LIMITS) }, "unresolved-evidence");
    }
    await refuse({ ...packed, selection: { ...packed.selection, root: b(93) } }, "selection-mismatch");
  });
  await test("portable bytes and seed are owned before proof awaits; shared input and source failures cannot certify", async () => {
    const packed = portable(clone({ ...complete, seed: receiverSeed })); let calls = 0;
    const mutating = { ...verifier, verify: async (...args) => {
      if (calls++ === 0) { packed.package.fill(0); packed.selection.root.fill(0); packed.seed.fill(0); }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await replayEvidencePackage(packed, mutating, codec), receiver);
    const viewed = portable(clone({ ...complete, seed: receiverSeed }));
    for (const key of ["package", "seed"]) {
      const storage = new Uint8Array(2_097_152); storage.set(viewed[key], 17);
      viewed[key] = storage.subarray(17, 17 + viewed[key].length);
    }
    const storage = new Uint8Array(2_097_152); storage.set(viewed.selection.root, 17);
    viewed.selection.root = storage.subarray(17, 49);
    const originalClone = globalThis.structuredClone;
    let ownershipCopies = 0;
    try {
      globalThis.structuredClone = (value, ...options) => {
        if (value?.package && value?.selection) {
          ownershipCopies += 1;
          assert.equal(value.package.configuration.buffer.byteLength, value.package.configuration.length);
          assert.equal(value.selection.root.buffer.byteLength, 32); assert.equal(value.seed.buffer.byteLength, 32);
        }
        return originalClone(value, ...options);
      };
      assert.deepEqual(await replayEvidencePackage(viewed, verifier, codec), receiver);
      assert.equal(ownershipCopies, 1);
    } finally { globalThis.structuredClone = originalClone; }
    for (const field of ["package", "seed"]) {
      const p = portable({ ...complete, seed: receiverSeed }), original = p[field];
      p[field] = new Uint8Array(new SharedArrayBuffer(original.length)); p[field].set(original);
      const result = await replayEvidencePackage(p, { ...verifier, verify() { throw new Error("shared input reached proof"); } }, codec);
      assert.equal(result.status, "unresolved-evidence"); assert.equal(result.audit, null);
    }
    const failure = new Error("range/proof service unavailable");
    await assert.rejects(replayEvidencePackage(portable(complete), { ...verifier, verify() { throw failure; } }, codec), error => error === failure);
  });
  await api.destroy(); api = undefined;
  function worker(payload) {
    const child = spawnSync(process.execPath, [join(here, "local-worker.mjs"), url], {
      input: serialize(portable(payload)), timeout: 60_000, cwd: build, windowsHide: true, maxBuffer: 1_048_576,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  }
  await test("fresh public verifier has no wallet seed; separate receiver restores from public evidence only", () => {
    assert.deepEqual(Object.keys(complete).sort(), ["package", "selection", "venue"]);
    assert.deepEqual(worker(complete), audit);
    assert.deepEqual(worker({ ...complete, seed: receiverSeed }), receiver);
    assert.deepEqual(worker(extended), dependency);
  });
  await test("fresh verifier refuses a changed artifact against its independently held key pin", () => {
    for (const kind of [2, 7]) {
      const keyPath = join(build, `${kind}.vk`), key = readFileSync(keyPath);
      try {
        writeFileSync(keyPath, readFileSync(join(build, "3.vk")));
        const child = spawnSync(process.execPath, [join(here, "local-worker.mjs"), url], {
          input: serialize(portable(complete)), timeout: 60_000, cwd: build, windowsHide: true, maxBuffer: 1_048_576,
        });
        assert.equal(child.error, undefined); assert.equal(child.status, 1); assert.equal(child.stdout.length, 0);
        assert.equal(child.stderr.toString(), "local replay fixture failed\n");
      } finally { writeFileSync(keyPath, key); }
    }
  });
  await test("successful replay retains unresolved production authority; ranges are the fixture verifier's only", () => {
    for (const result of [receiver, audit, dependency]) {
      assert.equal(result.candidateConfigurationChecked, true); assert.equal(result.signedTermsAuthenticated, true);
      assert.equal(result.currentRangeAuthenticated, true); assert.equal(result.termsAuthorityAuthenticated, true);
      assert.equal(result.rangeEvidence, "fixture-verifier");
      for (const key of ["fullV3Replay", "completenessClaim", "noMatchesMeansZeroBalance", "spendable"]) assert.equal(result[key], false);
      assert.equal(result.unresolvedCoverage, true);
      result.candidates.forEach(x => assert.equal(x.spendable, false));
    }
  });
  const sources = ["scripts/pool/v3/local-replay.mjs", "scripts/pool/v3/local-worker.mjs", "scripts/pool/v3/local-check.mjs",
    "scripts/pool/v3/fixture-venue.mjs",
    "scripts/pool/delivery/evidence-reader.mjs", "scripts/pool/delivery/crypto.mjs", "scripts/pool/spent-set/radix.mjs",
    "model/pool-v3-records.ts", "model/pool-v3-commitments.ts", "model/pool-v3-trail.ts", "model/pool-v3-headers.ts",
    "model/pool-v3-configuration.ts", "model/pool-v3-terms.ts", "model/pool-v3-package.ts", "model/pool-v3-range.ts",
    "scripts/pool/v3/candidate.mjs", "scripts/pool/v3/candidate-manifest.json",
    "src/pool/note-tree.ts", "src/pool/scope.ts", "scripts/pool/v3/circuits/issue.nr", "scripts/pool/v3/circuits/spend.nr", "scripts/pool/v3/circuits/burn.nr"];
  checkCandidateSources(manifest);
  const report = { schema: "moe-v3-local-replay-experiment-5", specification: "3ed1800", node: process.version,
    packageBytes: portable(complete).package.length, dependencyPackageBytes: portable(extended).package.length,
    fixtureVenueRecords: complete.venue.records.length,
    candidateDomain: hex(domain), configurationBytes: configurationBytes.length, backing: hex(backing),
    platform: process.platform, checks, identities, metrics,
    sourceSha256Lf: Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n"))])),
    audit, receiver, dependency,
    limits: ["Candidate configuration and signed constant-root terms checked; no adopted domain. The replacement chain, the selected checkpoint's record prefix, currency, its operator's force and the absent revocation are established against a harness-owned fixture venue record only, not a venue profile or authenticated chain evidence.",
      "Only issue/spend/burn in one empty-opening segment of the original operator; every carrying checkpoint of that segment is classified from its own trail with last-valid-prefix continuity. No imports, silence clock, successor segments, same-operator scope changes or recovery publications.",
      "Real proof/signature/state replay and local membership paths do not grant full finality, complete-certificate verdicts or spending permission."] };
  writeFileSync(join(scratch, "pool-v3-local-replay-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS: ${checks.length} local replay groups, ${metrics.length} real proofs; scratch/pool-v3-local-replay-results.json`);
} finally {
  if (api) await api.destroy();
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error("unsafe replay build cleanup");
  rmSync(target, { recursive: true, force: true });
}
