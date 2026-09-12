// Fresh-process candidate restoration from canonical v3 local evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serialize } from "node:v8";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { ed25519 } from "@noble/curves/ed25519.js";
import { directoryRoot, encodeCommitment, signCommitment } from "../../../dist/commitment.js";
import { limbsOf } from "../../../dist/pool/field.js";
import { prepareExactOutput } from "./crypto.mjs";
import { inspectRestorationEvidence, loadEvidenceCodecs, LIMITS } from "./evidence-reader.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "../../..");
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(join(root, "scratch"));
const build = realpathSync(mkdtempSync(join(scratch, "pool-restoration-evidence-")));
const reportFile = join(scratch, "pool-restoration-evidence-results.json");
const tested = [], b = n => new Uint8Array(32).fill(n), clone = structuredClone;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");
const test = (name, fn) => { fn(); tested.push(name); };

try {
  // Compile only the codec dependency closure. Nothing is installed or copied
  // into the package; this temporary build is removed even after test failure.
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram([join(root, "model/pool-v3-trail.ts")], {
    ...parsed.options, noEmit: false, rootDir: root, outDir: build,
    declaration: false, sourceMap: false, incremental: false,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: name => name, getNewLine: () => "\n",
  }));
  assert.equal(program.emit().emitSkipped, false);
  const buildUrl = pathToFileURL(build + sep).href, codec = await loadEvidenceCodecs(buildUrl);
  const domain = b(11), venue = b(12), backing = b(13), operatorSecret = b(14);
  const payerSeed = b(21), receiverSeed = b(22), otherSeed = b(23);
  const operator = ed25519.getPublicKey(operatorSecret);
  const header = codec.segmentBytes({ domain, venue, operator, sequence: 1n,
    entries: [{ backing, link: b(15) }] });
  const segment = hash(header), scopeRoot = 42n;
  const P = [...limbsOf(domain), ...limbsOf(segment), scopeRoot];
  const output = (seed, id, value) => prepareExactOutput(seed, domain, b(id), backing, value);
  const funded = output(payerSeed, 31, 10n), payment = output(receiverSeed, 32, 7n);
  const change = output(payerSeed, 33, 3n), zero = output(payerSeed, 34, 0n);
  const zero2 = output(payerSeed, 35, 0n), nextPayment = output(otherSeed, 36, 5n);
  const receiverChange = output(receiverSeed, 37, 2n), rz = output(receiverSeed, 38, 0n);
  const rz2 = output(receiverSeed, 39, 0n), padding = output(payerSeed, 40, 0n);
  const receiverPadding = output(receiverSeed, 41, 0n);
  const digest = outputs => limbsOf(codec.deliveryHash(domain, outputs.map(x => x.cm), outputs.map(x => x.capsule)));
  const issue = { domain, kind: 1, publicInputs: [...P, ...limbsOf(backing), 10n, funded.cm, ...digest([funded])],
    proof: b(51), authorization: new Uint8Array(64).fill(52), capsules: [funded.capsule] };
  const spend = (inputs, outputs) => ({ domain, kind: 2,
    publicInputs: [...P, 1n, 1n, ...inputs.map(x => x.nf), ...outputs.map(x => x.cm), ...digest(outputs)],
    proof: b(53), authorization: new Uint8Array(), capsules: outputs.map(x => x.capsule) });
  const firstSpend = spend([funded, padding], [payment, change, zero, zero2]);
  const secondSpend = spend([payment, receiverPadding], [nextPayment, receiverChange, rz, rz2]);

  function evidence(records, sequence, replacementHeader = header) {
    const currentSegment = hash(replacementHeader);
    let evidenceHash = codec.genesisEvidenceHash(currentSegment);
    records.forEach((record, index) => { evidenceHash = codec.nextEvidenceHash(evidenceHash,
      codec.evidenceHashes(record), BigInt(index) + 1n); });
    // Deliberately no state replay: history root and proof bytes are synthetic.
    const snapshot = { backing, segment: currentSegment, historyHash: b(54), evidenceHash, issued: 10n, burned: 0n };
    const directory = [{ name: backing, digest: codec.snapshotDigest(snapshot) }];
    const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
    const trail = { header: replacementHeader,
      terms: [{ terms: new Uint8Array([1, 2, 3]), signature: new Uint8Array(64) }],
      records: records.map(codec.encodeRecord) };
    return {
      package: { commitment: encodeCommitment(commitment), directory, snapshot: codec.snapshotBytes(snapshot),
        trail: codec.encodeTrail(trail, LIMITS) },
      selection: { domain, venue, backing, operator, sequence, root: commitment.root,
        judgingIndex: sequence + 10n, mode: "current-fixture" },
    };
  }
  const historical = evidence([issue, firstSpend], 2n);
  const current = evidence([issue, firstSpend, secondSpend], 3n);
  const input = (fixture = current, seed = receiverSeed) => ({ seed, ...clone(fixture) });
  function worker(payload) {
    const child = spawnSync(process.execPath, [join(here, "evidence-worker.mjs"), buildUrl], {
      input: serialize(payload), cwd: build, timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr.toString());
    assert.equal(child.stderr.length, 0);
    return JSON.parse(child.stdout.toString());
  }
  function limits(result) {
    for (const flag of ["authenticatedFullV3Finality", "completenessClaim", "noMatchesMeansZeroBalance", "spendable"]) {
      assert.equal(result[flag], false);
    }
    assert.equal(result.unresolvedCoverage, true);
    assert.equal(result.selectionSource, "independent-test-fixture");
    result.candidates.forEach(note => assert.equal(note.spendable, false));
  }
  function expectRefusal(payload, status) {
    const result = worker(payload); limits(result);
    assert.equal(result.status, status); assert.deepEqual(result.candidates, []); assert.equal(result.stats, null);
  }
  function changedTrail(mutator) {
    const payload = input(), trail = clone(codec.decodeTrail(payload.package.trail, LIMITS));
    mutator(trail);
    payload.package.trail = codec.encodeTrail(trail, LIMITS);
    return payload;
  }
  let currentResult;
  test("fresh receiver restores only change 2 from exact signed local evidence, without a request journal", () => {
    const payload = input();
    assert.deepEqual(Object.keys(payload).sort(), ["package", "seed", "selection"]);
    currentResult = worker(payload); limits(currentResult);
    assert.equal(currentResult.status, "selected-evidence-candidates");
    assert.deepEqual(currentResult.candidates.map(x => [x.cm, x.value]), [[receiverChange.cm.toString(), "2"]]);
    assert.equal(currentResult.stats.trials, 9);
  });
  test("payer restores change 3; issued input, spent payment, zero and foreign outputs are filtered", () => {
    const result = worker(input(current, payerSeed)); limits(result);
    assert.deepEqual(result.candidates.map(x => [x.cm, x.value]), [[change.cm.toString(), "3"]]);
    assert.equal(result.candidates.some(x => x.cm === funded.cm.toString()), false);
  });
  test("burn nullifiers remove the received note and its bound change remains discoverable", () => {
    const burnChange = output(receiverSeed, 42, 4n);
    const burn = { domain, kind: 3,
      publicInputs: [...P, ...limbsOf(backing), 3n, 1n, 1n, payment.nf, receiverPadding.nf,
        burnChange.cm, ...digest([burnChange])],
      proof: b(55), authorization: new Uint8Array(), capsules: [burnChange.capsule] };
    const result = worker(input(evidence([issue, firstSpend, burn], 3n))); limits(result);
    assert.deepEqual(result.candidates.map(x => [x.cm, x.value]), [[burnChange.cm.toString(), "4"]]);
  });
  test("old complete package is historical only and cannot substitute for the current selection", () => {
    const payload = input(historical); payload.selection.mode = "historical-fixture";
    const result = worker(payload); limits(result);
    assert.equal(result.status, "historical-candidates");
    assert.deepEqual(result.candidates.map(x => [x.cm, x.value]), [[payment.cm.toString(), "7"]]);
    payload.selection = clone(current.selection);
    expectRefusal(payload, "selection-mismatch");
  });
  test("same-sequence signed alternative and wrong operator cannot replace independent selection", () => {
    const alternative = evidence([issue, firstSpend], 3n);
    expectRefusal({ ...input(), package: alternative.package }, "selection-mismatch");
    const payload = input();
    payload.package.commitment = encodeCommitment(signCommitment(b(61), 3n, current.selection.root));
    expectRefusal(payload, "selection-mismatch");
  });
  test("omitted record, reordered records and missing or corrupted capsule leave no partial candidates", () => {
    expectRefusal(changedTrail(trail => trail.records.pop()), "unresolved-evidence");
    expectRefusal(changedTrail(trail => trail.records.reverse()), "unresolved-evidence");
    expectRefusal(changedTrail(trail => { trail.records[2] = trail.records[2].slice(0, -89); }), "unresolved-evidence");
    expectRefusal(changedTrail(trail => { trail.records[2][trail.records[2].length - 1] ^= 1; }), "unresolved-evidence");
  });
  test("substituted proof, authorization, snapshot, directory and commitment signature refuse", () => {
    for (const field of ["proof", "authorization"]) {
      expectRefusal(changedTrail(trail => {
        const record = clone(codec.decodeRecord(trail.records[0])); record[field][0] ^= 1;
        trail.records[0] = codec.encodeRecord(record);
      }), "unresolved-evidence");
    }
    for (const field of ["snapshot", "commitment"]) {
      const payload = input(); payload.package[field][payload.package[field].length - 1] ^= 1;
      expectRefusal(payload, "unresolved-evidence");
    }
    const payload = input(); payload.package.directory[0].digest[0] ^= 1;
    expectRefusal(payload, "unresolved-evidence");
  });
  test("missing public components and empty view never become complete zero balance", () => {
    for (const field of ["trail", "snapshot", "directory", "commitment"]) {
      const payload = input(); delete payload.package[field]; expectRefusal(payload, "unresolved-evidence");
    }
    const result = worker(input(evidence([], 1n))); limits(result);
    assert.deepEqual(result.candidates, []); assert.equal(result.status, "selected-evidence-candidates");
    const wrongSeed = worker(input(current, b(62))); limits(wrongSeed); assert.deepEqual(wrongSeed.candidates, []);
  });
  test("request journal cannot override public spentness or supply an output", () => {
    for (const journal of [[], [{ request: "current", fulfilled: false }], [{ request: "stale", value: "7" }]]) {
      const payload = input(); payload.requestJournal = journal;
      const child = spawnSync(process.execPath, [join(here, "evidence-worker.mjs"), buildUrl], {
        input: serialize(payload), cwd: build, timeout: 30_000, windowsHide: true,
      });
      assert.equal(child.status, 1); assert.equal(child.stdout.length, 0);
      assert.equal(child.stderr.toString(), "restoration fixture failed\n");
    }
    assert.deepEqual(worker(input()), currentResult);
  });
  test("retained independent bytes survive source loss; replacement restores unavailable evidence", () => {
    const retained = input(), source = input(); source.package.trail.fill(0);
    expectRefusal(source, "unresolved-evidence");
    assert.deepEqual(worker(retained), currentResult);
    source.package.trail = clone(retained.package.trail);
    assert.deepEqual(worker(source), currentResult);
  });
  test("wrong venue/domain and authenticated foreign statement context refuse", () => {
    for (const field of ["domain", "venue"]) {
      const payload = input(); payload.selection[field] = b(71); expectRefusal(payload, "unresolved-evidence");
    }
    for (const [position, value] of [[2, 1n], [4, scopeRoot + 1n]]) {
      const other = clone(secondSpend); other.publicInputs[position] = value;
      expectRefusal(input(evidence([issue, firstSpend, other], 3n)), "unresolved-evidence");
    }
  });
  test("imports and recovery statements remain explicit unsupported scope", () => {
    const importedHeader = codec.segmentBytes({ domain, venue, operator, sequence: 2n,
      entries: [{ backing, link: b(15), opening: { operator, sequence: 1n, root: b(72) } }] });
    expectRefusal(input(evidence([], 3n, importedHeader)), "unsupported-scope");
    const withdrawal = { domain, kind: 5, publicInputs: [...P, ...limbsOf(b(73))],
      proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] };
    expectRefusal(input(evidence([issue, withdrawal], 3n)), "unsupported-scope");
  });
  test("bound local bytes authenticate even invalid proof and totals; never certify replay or spendability", () => {
    const payload = input(), snapshot = clone(codec.decodeSnapshot(payload.package.snapshot));
    snapshot.burned = 11n;
    payload.package.snapshot = codec.snapshotBytes(snapshot);
    payload.package.directory[0].digest = codec.snapshotDigest(snapshot);
    const commitment = signCommitment(operatorSecret, 3n, directoryRoot(payload.package.directory));
    payload.package.commitment = encodeCommitment(commitment); payload.selection.root = commitment.root;
    const result = worker(payload); limits(result);
    assert.equal(result.status, "selected-evidence-candidates");
    assert.deepEqual(result.candidates, currentResult.candidates);
    const changedTerms = changedTrail(trail => { trail.terms[0].terms.fill(255); trail.terms[0].signature.fill(255); });
    const termsResult = worker(changedTerms); limits(termsResult);
    assert.deepEqual(termsResult.candidates, currentResult.candidates);
  });
  test("reader budgets are resource refusal and unexpected code errors propagate", () => {
    const payload = input(); payload.package.trail = new Uint8Array(Number(LIMITS.maxBytes) + 1);
    expectRefusal(payload, "resource-refusal");
    const failure = new Error("programming failure");
    assert.throws(() => inspectRestorationEvidence(receiverSeed, current.selection, current.package,
      { ...codec, decodeSnapshot() { throw failure; } }), error => error === failure);
  });
  const sources = ["scripts/pool/delivery/evidence-reader.mjs", "scripts/pool/delivery/evidence-worker.mjs",
    "scripts/pool/delivery/evidence-check.mjs", "scripts/pool/delivery/crypto.mjs", "model/pool-v3-trail.ts",
    "model/pool-v3-records.ts", "model/pool-v3-headers.ts", "model/pool-v3-commitments.ts"];
  const report = { schema: "moe-successor-restoration-evidence-experiment-1", node: process.version,
    platform: process.platform, specification: "7ea0ee8", checks: tested,
    sourceSha256Lf: Object.fromEntries(sources.map(name => [name, hex(hash(readFileSync(join(root, name), "utf8").replaceAll("\r\n", "\n")))])),
    fixtureBytes: { currentTrail: current.package.trail.length, historicalTrail: historical.package.trail.length },
    currentReceiver: currentResult,
    limitations: ["Synthetic proofs, history root, terms, authority and venue selection; no final v3 configuration.",
      "Local byte authentication and capsule scanning only; no full replay, supply verification, range completeness or certified paths.",
      "Single backing/segment without imports or recovery; candidates never authorize spending.",
      "Memory-only local fixture IPC; no custody, network retrieval, permanent retention or durable invoice restoration evidence."] };
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(`PASS: ${tested.length} successor restoration evidence checks. Report: scratch/pool-restoration-evidence-results.json`);
} finally {
  const target = realpathSync(build);
  if (!target.startsWith(scratch + sep)) throw new Error("unsafe restoration evidence build cleanup");
  rmSync(target, { recursive: true, force: true });
}
