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
import { prepareExactOutput } from "../delivery/crypto.mjs";
import { loadEvidenceCodecs, LIMITS } from "../delivery/evidence-reader.mjs";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage } from "./local-replay.mjs";
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
  const program = ts.createProgram(["trail", "configuration", "terms"].map(name => join(root, `model/pool-v3-${name}.ts`)), {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false,
  });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0); assert.equal(program.emit().emitSkipped, false);
  const codec = { ...await loadEvidenceCodecs(url), ...await loadConfigurationCodecs(url) };
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
  const verifier = { configuration, verify: (kind, publicInputs, proof) => verifierBackend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, options) };
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
  function seal(records, snapshot) {
    // Recompute exact evidence even for an operator-authenticated bad proof.
    let evidence = codec.genesisEvidenceHash(segment);
    records.forEach((record, i) => { evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n); });
    snapshot = { ...snapshot, evidenceHash: evidence };
    const directory = [{ name: backing, digest: codec.snapshotDigest(snapshot) }];
    const commitment = signCommitment(operatorSecret, 3n, directoryRoot(directory));
    return { selection: { domain, venue, backing, operator, sequence: 3n, root: commitment.root,
      judgingIndex: 20n, mode: "current-fixture" },
      package: { configuration: configurationBytes, commitment: encodeCommitment(commitment), directory, snapshot: codec.snapshotBytes(snapshot),
        trail: codec.encodeTrail({ header, terms: [signedTerms], records: records.map(codec.encodeRecord) }, LIMITS) } };
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
    const beforeProof = { configuration, verify() { throw new Error("configuration guard ran too late"); } };
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
    function empty(fields, headerFields = {}) {
      const terms = codec.encodeRootTerms(fields), name = codec.rootTermsName(terms);
      const h = codec.segmentBytes({ domain, venue, operator, sequence: 1n, entries: [{ backing: name, link: name }], ...headerFields });
      const segment = new Uint8Array(Buffer.from(sha(h), "hex"));
      const s = { backing: name, segment, historyHash: codec.genesisHistoryHash(segment), evidenceHash: codec.genesisEvidenceHash(segment), issued: 0n, burned: 0n };
      const directory = [{ name, digest: codec.snapshotDigest(s) }], c = signCommitment(operatorSecret, 3n, directoryRoot(directory));
      return { selection: { ...complete.selection, backing: name, root: c.root }, package: {
        configuration: configurationBytes, commitment: encodeCommitment(c), directory, snapshot: codec.snapshotBytes(s),
        trail: codec.encodeTrail({ header: h, terms: [{ terms, signature: ed25519.sign(codec.rootTermsSignatureMessage(terms), issuerSecret) }], records: [] }, LIMITS),
      } };
    }
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
      const mutating = { configuration, verify: async (...args) => {
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
    const mutating = { configuration, verify: async (...args) => {
      if (calls++ === 0) { payload.selection.root.fill(0); payload.package.snapshot.fill(0); payload.package.trail.fill(0); payload.package.configuration.fill(0); }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await replayLocalPackage(payload, mutating, codec), audit);
    const failure = new Error("verifier unavailable");
    await assert.rejects(replayLocalPackage(complete, { configuration, verify() { throw failure; } }, codec), error => error === failure);
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
  await api.destroy(); api = undefined;
  function worker(payload) {
    const child = spawnSync(process.execPath, [join(here, "local-worker.mjs"), url], {
      input: serialize(payload), timeout: 60_000, cwd: build, windowsHide: true, maxBuffer: 1_048_576,
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  }
  await test("fresh public verifier has no wallet seed; separate receiver restores from public evidence only", () => {
    assert.deepEqual(Object.keys(complete).sort(), ["package", "selection"]);
    assert.deepEqual(worker(complete), audit);
    assert.deepEqual(worker({ ...complete, seed: receiverSeed }), receiver);
  });
  await test("fresh verifier refuses a changed artifact against its independently held key pin", () => {
    for (const kind of [2, 7]) {
      const keyPath = join(build, `${kind}.vk`), key = readFileSync(keyPath);
      try {
        writeFileSync(keyPath, readFileSync(join(build, "3.vk")));
        const child = spawnSync(process.execPath, [join(here, "local-worker.mjs"), url], {
          input: serialize(complete), timeout: 60_000, cwd: build, windowsHide: true, maxBuffer: 1_048_576,
        });
        assert.equal(child.error, undefined); assert.equal(child.status, 1); assert.equal(child.stdout.length, 0);
        assert.equal(child.stderr.toString(), "local replay fixture failed\n");
      } finally { writeFileSync(keyPath, key); }
    }
  });
  await test("successful replay retains unresolved production authority and currentness", () => {
    for (const result of [receiver, audit]) {
      assert.equal(result.candidateConfigurationChecked, true); assert.equal(result.signedTermsAuthenticated, true);
      for (const key of ["fullV3Replay", "currentRangeAuthenticated", "termsAuthorityAuthenticated", "completenessClaim", "noMatchesMeansZeroBalance", "spendable"]) assert.equal(result[key], false);
      assert.equal(result.unresolvedCoverage, true);
      result.candidates.forEach(x => assert.equal(x.spendable, false));
    }
  });
  const sources = ["scripts/pool/v3/local-replay.mjs", "scripts/pool/v3/local-worker.mjs", "scripts/pool/v3/local-check.mjs",
    "scripts/pool/delivery/evidence-reader.mjs", "scripts/pool/delivery/crypto.mjs", "scripts/pool/spent-set/radix.mjs",
    "model/pool-v3-records.ts", "model/pool-v3-commitments.ts", "model/pool-v3-trail.ts", "model/pool-v3-headers.ts",
    "model/pool-v3-configuration.ts", "model/pool-v3-terms.ts", "scripts/pool/v3/candidate.mjs", "scripts/pool/v3/candidate-manifest.json",
    "src/pool/note-tree.ts", "src/pool/scope.ts", "scripts/pool/v3/circuits/issue.nr", "scripts/pool/v3/circuits/spend.nr", "scripts/pool/v3/circuits/burn.nr"];
  checkCandidateSources(manifest);
  const report = { schema: "moe-v3-local-replay-experiment-2", specification: "916bffb", node: process.version,
    candidateDomain: hex(domain), configurationBytes: configurationBytes.length, backing: hex(backing),
    platform: process.platform, checks, identities, metrics,
    sourceSha256Lf: Object.fromEntries(sources.map(path => [path, sha(readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n"))])),
    audit, receiver,
    limits: ["Candidate configuration and signed constant-root terms checked; no adopted domain or registered/current authority. Selected checkpoint and empty opening remain fixture assumptions.",
      "Only issue/spend/burn in one empty-opening segment; no recovery, imports, revocation, clock or venue-range validation.",
      "Real proof/signature/state replay and local membership paths do not grant full finality, current completeness or spending permission."] };
  writeFileSync(join(scratch, "pool-v3-local-replay-results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS: ${checks.length} local replay groups, ${metrics.length} real proofs; scratch/pool-v3-local-replay-results.json`);
} finally {
  if (api) await api.destroy();
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error("unsafe replay build cleanup");
  rmSync(target, { recursive: true, force: true });
}
