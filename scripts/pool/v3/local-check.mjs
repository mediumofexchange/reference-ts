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
import { encodeReplacement, replacementMessage, ROLE_OPERATOR } from "../../../dist/replacement.js";
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
    return { ...input, package: codec.encodeEvidencePackage(canonical([
      { kind: 1, payload: p.configuration }, { kind: 2, payload: p.commitment },
      ...directories.map(entries => ({ kind: 3, payload: codec.encodeEvidenceDirectory(entries, PACKAGE_LIMITS) })),
      { kind: 4, payload: p.snapshot }, { kind: 6, payload: p.trail },
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
    return { range: request => witnessed.answer(request, codec, RANGE_LIMITS), witnessedIndex: () => witnessed.witnessedIndex };
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
  function witnessed(commitment) {
    const record = new FixtureVenue(venue, 20n);
    record.witness(1, operator, 1n, encodeCommitment(earlier));
    record.witness(1, operator, 3n, encodeCommitment(commitment));
    record.witness(1, operator, 7n, encodeCommitment(later));
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
  function emptyPackage(fields, headerFields = {}) {
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
      venue: witnessed(c) };
  }
  const records = [issue, payment, burn], effects = [
    { outputs: [funded.cm], nullifiers: [] },
    { outputs: [paid.cm, change.cm, zero1.cm, zero2.cm], nullifiers: [funded.nf, pad.nf] },
    { outputs: [burnChange.cm], nullifiers: [paid.nf, receiverPad.nf] },
  ];
  const complete = packageFor(records, effects), snapshot = codec.decodeSnapshot(complete.package.snapshot);
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
    assert.deepEqual(audit.audit.range, { judgingIndex: "20", checkpointIndex: "3", revokedAt: null, heldBefore: 1, heldAfter: 1 });
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
    assert.deepEqual(past.audit.range, { judgingIndex: "8", checkpointIndex: "3", revokedAt: null, heldBefore: 1, heldAfter: 1 });
  });
  await test("record ranges refuse a contradicted empty opening, a later carrying checkpoint, a missing directory, a revoked issuer and a replaced operator", async () => {
    const carryingBefore = [{ name: backing, digest: b(84) }], c1 = signCommitment(operatorSecret, 1n, directoryRoot(carryingBefore));
    const carried = clone(complete); carried.venue.records[0] = { kind: 1, subject: operator, index: 1n, record: encodeCommitment(c1) };
    carried.package.directories = [carryingBefore, after];
    await reject(carried, "OPENING");
    const carryingAfter = [{ name: backing, digest: b(85) }], c4 = signCommitment(operatorSecret, 4n, directoryRoot(carryingAfter));
    const superseded = clone(complete); superseded.venue.records[2] = { kind: 1, subject: operator, index: 7n, record: encodeCommitment(c4) };
    superseded.package.directories = [before, carryingAfter];
    assert.equal((await replayLocalPackage(superseded, verifier, codec)).status, "unsupported-scope");
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
    const ruleSecret = b(87), successorSecret = b(89), ruled = emptyPackage({ ...termsFields, replacementRule: ed25519.getPublicKey(ruleSecret) });
    const name = ruled.selection.backing, successor = ed25519.getPublicKey(successorSecret);
    const fields = { role: ROLE_OPERATOR, successor, predecessor: name, effective: 40n, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(name, fields);
    const signed = { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, successorSecret) };
    assert.equal((await replayLocalPackage(ruled, verifier, codec)).status, "selected-local-replay");
    const replaced = clone(ruled); replaced.venue.records.push({ kind: 2, subject: name, index: 5n, record: encodeReplacement(name, signed) });
    assert.equal((await replayLocalPackage(replaced, verifier, codec)).status, "unsupported-scope");
    const strangers = clone(ruled);
    strangers.venue.records.push({ kind: 2, subject: name, index: 5n, record: encodeReplacement(name, { ...signed, signature: ed25519.sign(message, b(90)) }) });
    assert.equal((await replayLocalPackage(strangers, verifier, codec)).status, "selected-local-replay");
    const unruled = clone(complete); unruled.venue.records.push({ kind: 2, subject: backing, index: 5n, record: encodeReplacement(backing, signed) });
    assert.deepEqual(await replayLocalPackage(unruled, verifier, codec), audit);
    // With an admitted replacement the party in force at index 1 is not established here: no opening verdict.
    const both = clone(replaced); both.venue.records[0] = { kind: 1, subject: operator, index: 1n, record: encodeCommitment(c1) };
    both.package.directories = [carryingBefore, after];
    const undecided = await replayLocalPackage(both, verifier, codec);
    assert.equal(undecided.status, "unsupported-scope"); assert.equal(undecided.check, null);
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
    const silent = { ...verifier, record: () => ({ range: () => undefined, witnessedIndex: () => 20n }) };
    assert.equal((await replayLocalPackage(complete, silent, codec)).status, "unresolved-evidence");
    // A flood at the operator's location beyond the reader's entry budget is a resource refusal, never a verdict.
    const flooded = clone(complete), junk = new Uint8Array(136).fill(7);
    for (let i = 0; i <= Number(RANGE_LIMITS.maxEntries); i++) flooded.venue.records.push({ kind: 1, subject: operator, index: 2n, record: junk });
    const refusal = await replayLocalPackage(flooded, verifier, codec);
    assert.equal(refusal.status, "resource-refusal"); assert.equal(refusal.audit, null);
    assert.equal((await replayLocalPackage(complete, { configuration, verify: verifier.verify }, codec)).status, "unresolved-evidence");
    const failure = new Error("range service unavailable");
    await assert.rejects(replayLocalPackage(complete, { ...verifier, record: () => ({ range() { throw failure; }, witnessedIndex: () => 20n }) }, codec), error => error === failure);
    const { venue: omitted, ...withoutVenue } = complete;
    assert.equal(omitted.records.length, 3);
    const plain = await replayLocalPackage(withoutVenue, verifier, codec);
    assert.equal(plain.status, "selected-local-replay"); assert.equal(plain.rangeEvidence, "none");
    assert.equal(plain.currentRangeAuthenticated, false); assert.equal(plain.termsAuthorityAuthenticated, false); assert.equal(plain.audit.range, null);
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
    for (const result of [receiver, audit]) {
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
  const report = { schema: "moe-v3-local-replay-experiment-4", specification: "6272040", node: process.version,
    packageBytes: portable(complete).package.length, fixtureVenueRecords: complete.venue.records.length,
    candidateDomain: hex(domain), configurationBytes: configurationBytes.length, backing: hex(backing),
    platform: process.platform, checks, identities, metrics,
    sourceSha256Lf: Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n"))])),
    audit, receiver,
    limits: ["Candidate configuration and signed constant-root terms checked; no adopted domain. The selected checkpoint, its empty opening, currency, the original operator's force and the absent revocation are established against a harness-owned fixture venue record only, not a venue profile or authenticated chain evidence.",
      "Only issue/spend/burn in one empty-opening segment; no recovery, imports, clock, later carrying checkpoints or replacement chains.",
      "Real proof/signature/state replay and local membership paths do not grant full finality, complete-certificate verdicts or spending permission."] };
  writeFileSync(join(scratch, "pool-v3-local-replay-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS: ${checks.length} local replay groups, ${metrics.length} real proofs; scratch/pool-v3-local-replay-results.json`);
} finally {
  if (api) await api.destroy();
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error("unsafe replay build cleanup");
  rmSync(target, { recursive: true, force: true });
}
