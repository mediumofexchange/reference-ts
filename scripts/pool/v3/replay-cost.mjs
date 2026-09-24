// Replay and retention cost of the conditional local replay (recovery map
// A13, probe P3). One synthetic segment per case: an issue, then spends with
// fresh nullifiers and outputs, a checkpoint every K events, the last one
// selected. A counting stub verifier replaces proof verification, whose cost
// the conformance report measures separately. Not a check, not runtime.
//   node scripts/pool/v3/replay-cost.mjs [--out docs/pool-replay-cost-verification.json]
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoteTree, EMPTY_NOTE_ROOT } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { limbsOf, fieldToBytes } from "../../../dist/pool/field.js";
import { poseidon2Hash, poseidon2Permutation } from "../../../dist/pool/poseidon2.js";
import { BarretenbergSync } from "@aztec/bb.js";
import { signCommitment, encodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { loadEvidenceCodecs, LIMITS } from "../delivery/evidence-reader.mjs";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { replayLocalPackage, RANGE_LIMITS } from "./local-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";
import { loadCandidateManifest, candidateConfiguration, loadConfigurationCodecs } from "./candidate.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--out"), "usage: replay-cost.mjs [--out file]");
const root = resolve(import.meta.dirname, "../../.."), scratch = join(root, "scratch");
mkdirSync(scratch, { recursive: true });
const build = realpathSync(mkdtempSync(join(realpathSync(scratch), "replay-cost-")));
const url = pathToFileURL(build + sep).href;
const sha = bytes => createHash("sha256").update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString("hex");
try {
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const models = ["trail", "configuration", "terms", "package", "range", "fault-evidence"].map(n => `model/pool-v3-${n}.ts`);
  const program = ts.createProgram(models.map(file => join(root, file)),
    { ...parsed.options, noEmit: false, rootDir: root, outDir: build, declaration: false, sourceMap: false });
  assert.equal(ts.getPreEmitDiagnostics(program).length, 0); assert.equal(program.emit().emitSkipped, false);
  const codec = { ...await loadEvidenceCodecs(url), ...await loadConfigurationCodecs(url),
    ...await import(new URL("model/pool-v3-fault-evidence.js", url)), ...await import(new URL("model/pool-v3-package.js", url)),
    ...await import(new URL("model/pool-v3-range.js", url)) };

  const b = n => new Uint8Array(32).fill(n);
  const MODULUS = 21888242871839275222246405745257275088548364400416903490308238158651n;
  const fieldOf = () => { for (;;) { const v = BigInt("0x" + randomBytes(32).toString("hex")) % MODULUS; if (v !== 0n) return v; } };
  const configuration = candidateConfiguration(loadCandidateManifest(), codec), configurationBytes = codec.configurationBytes(configuration);
  const domain = codec.configurationHash(configuration), venue = b(12), issuerSecret = b(15), operatorSecret = b(16);
  const issuerKey = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
  const termsBytes = codec.encodeRootTerms({ obligor: issuerKey, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n },
    operator, configuration: domain, venue, interval: 10n });
  const backing = codec.rootTermsName(termsBytes), link = backing;
  const signedTerms = { terms: termsBytes, signature: ed25519.sign(codec.rootTermsSignatureMessage(termsBytes), issuerSecret) };
  const header = codec.segmentBytes({ domain, venue, operator, sequence: 1n, entries: [{ backing, link }] });
  const segment = new Uint8Array(sha(header)), prefix = [...limbsOf(domain), ...limbsOf(segment), new ScopeTree([{ backing, link }]).root()];
  const capsule = () => { const c = new Uint8Array(randomBytes(89)); c[0] = 1; return c; };
  const digest = (outputs, capsules) => limbsOf(codec.deliveryHash(domain, outputs, capsules));

  /** An issue of 1000 and n-1 spends; anchors are the empty root, which every replay accepts. */
  function segmentRecords(n, proofBytes) {
    const records = [], effects = [];
    const cm = fieldOf(), caps = [capsule()];
    const issue = { domain, kind: 1, publicInputs: [...prefix, ...limbsOf(backing), 1000n, cm, ...digest([cm], caps)],
      proof: new Uint8Array(randomBytes(proofBytes)), authorization: new Uint8Array(), capsules: caps };
    issue.authorization = ed25519.sign(codec.statementBytes(issue), issuerSecret);
    records.push(issue); effects.push({ outputs: [cm], nullifiers: [] });
    for (let i = 1; i < n; i++) {
      const nfs = [fieldOf(), fieldOf()], outs = [fieldOf(), fieldOf(), fieldOf(), fieldOf()], caps = outs.map(capsule);
      records.push({ domain, kind: 2, publicInputs: [...prefix, EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT, ...nfs, ...outs, ...digest(outs, caps)],
        proof: new Uint8Array(randomBytes(proofBytes)), authorization: new Uint8Array(), capsules: caps });
      effects.push({ outputs: outs, nullifiers: nfs });
    }
    return { records, effects, encoded: records.map(codec.encodeRecord) };
  }

  async function measure(n, every, proofBytes) {
    const { records, effects, encoded } = segmentRecords(n, proofBytes);
    const positions = []; for (let p = every; p < n; p += every) positions.push(p); positions.push(n);
    const states = new Map(), t = new NoteTree(), s = new RadixSpentSet();
    let history = codec.genesisHistoryHash(segment), evidence = codec.genesisEvidenceHash(segment);
    records.forEach((record, i) => {
      t.appendAll(effects[i].outputs); effects[i].nullifiers.forEach(nf => s.insert(fieldToBytes(nf)));
      history = codec.nextHistoryHash(history, codec.statementHash(record), t.root(), s.root(), BigInt(i) + 1n);
      evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), BigInt(i) + 1n);
      if (positions.includes(i + 1)) states.set(i + 1, { history, evidence });
    });
    const checkpoint = (position, sequence) => {
      const state = { backing, segment, historyHash: states.get(position).history, evidenceHash: states.get(position).evidence, issued: 1000n, burned: 0n };
      const directory = [{ name: backing, digest: codec.snapshotDigest(state) }];
      return { snapshot: codec.snapshotBytes(state), directory, commitment: signCommitment(operatorSecret, sequence, directoryRoot(directory)),
        trail: codec.encodeTrail({ header, terms: [signedTerms], records: encoded.slice(0, position) }, LIMITS) };
    };
    const openingState = { backing, segment, historyHash: codec.genesisHistoryHash(segment), evidenceHash: codec.genesisEvidenceHash(segment), issued: 0n, burned: 0n };
    const openingDirectory = [{ name: backing, digest: codec.snapshotDigest(openingState) }];
    const opening = { commitment: signCommitment(operatorSecret, 1n, directoryRoot(openingDirectory)), directory: openingDirectory,
      snapshot: codec.snapshotBytes(openingState), trail: codec.encodeTrail({ header, terms: [signedTerms], records: [] }, LIMITS) };
    const checkpoints = positions.map((p, i) => checkpoint(p, BigInt(i) + 2n));
    const judging = BigInt(checkpoints.length) + 20n, witnessed = new FixtureVenue(venue, judging, 2n);
    witnessed.witness(1, operator, 1n, encodeCommitment(opening.commitment));
    checkpoints.forEach((c, i) => witnessed.witness(1, operator, BigInt(i) + 2n, encodeCommitment(c.commitment)));
    const chosen = checkpoints.at(-1), rest = checkpoints.slice(0, -1);
    const input = { selection: { domain, venue, backing, operator, sequence: chosen.commitment.sequence, root: chosen.commitment.root,
      judgingIndex: judging, mode: "current-fixture" },
    package: { configuration: configurationBytes, commitment: encodeCommitment(chosen.commitment), directory: chosen.directory,
      directories: [opening.directory, ...rest.map(x => x.directory)], snapshot: chosen.snapshot, snapshots: [opening.snapshot, ...rest.map(x => x.snapshot)],
      trail: chosen.trail, trails: [opening.trail, ...rest.map(x => x.trail)] },
    venue: witnessed.export() };
    let calls = 0;
    const verifier = { configuration, verify: async () => { calls++; return true; }, record: data => {
      const record = FixtureVenue.from(data);
      return { evidenceKind: "fixture-verifier", range: request => record.answer(request, codec, RANGE_LIMITS),
        witnessedIndex: () => record.witnessedIndex, lag: () => record.lag };
    } };
    const start = performance.now();
    const result = await replayLocalPackage(input, verifier, codec);
    const ms = performance.now() - start;
    assert.equal(result.status, "selected-local-replay");
    assert.deepEqual(result.audit.range.carrying.map(c => c.class), Array(checkpoints.length + 1).fill("valid"));
    // Linear in events: each position is verified once however many checkpoints extend it.
    assert.equal(calls, n);
    const prefixSum = positions.reduce((a, p) => a + p, 0);
    // pool-v3 §12.1: the selected trail alone serves every earlier checkpoint as a prefix.
    calls = 0;
    const longestStart = performance.now();
    const longest = await replayLocalPackage({ ...input, package: { ...input.package, trails: [] } }, verifier, codec);
    const longestMs = performance.now() - longestStart;
    assert.deepEqual(longest, result); assert.equal(calls, n);
    return { events: n, checkpointEvery: every, carryingCheckpoints: checkpoints.length + 1, proofBytes,
      verifyCalls: n, verifyCallsIfEachPrefixReplayed: prefixSum, replayMs: Math.round(ms), replayMsPerEvent: +(ms / n).toFixed(2),
      selectedTrailBytes: chosen.trail.length, packageTrailBytes: [opening, ...checkpoints].reduce((a, x) => a + x.trail.length, 0),
      longestTrailOnlyReplayMsPerEvent: +(longestMs / n).toFixed(2),
      uniqueRecordBytes: encoded.reduce((a, x) => a + x.length, 0) };
  }

  const timed = (count, fn) => { fn(); const start = performance.now(); for (let i = 0; i < count; i++) fn(i); return (performance.now() - start) / count; };
  const exact = segmentRecords(2, 14656).encoded;
  const components = {
    poseidon2HashMs: +timed(500, i => poseidon2Hash([1n, 2n, BigInt(i ?? 0), 4n])).toFixed(3),
    noteTreeFourLeafAppendMs: +(() => { const tree = new NoteTree(); return timed(50, () => tree.appendAll([fieldOf(), fieldOf(), fieldOf(), fieldOf()])); })().toFixed(2),
    spentSetTwoInsertMs: +(() => { const set = new RadixSpentSet(); return timed(500, () => { set.insert(fieldToBytes(fieldOf())); set.insert(fieldToBytes(fieldOf())); }); })().toFixed(3),
    noteTreeCloneMsPer1000Leaves: +(() => { const tree = new NoteTree(); for (let i = 0; i < 250; i++) tree.appendAll([fieldOf(), fieldOf(), fieldOf(), fieldOf()]); return timed(20, () => tree.clone()); })().toFixed(3),
    ...await (async () => {
      // The same permutation in Barretenberg's wasm, called synchronously, for comparison only.
      const bb = await BarretenbergSync.new(), be = v => fieldToBytes(v), value = bytes => BigInt("0x" + hex(bytes));
      const input = [1n, 2n, 3n, 4n];
      assert.deepEqual(bb.poseidon2Permutation({ inputs: input.map(be) }).outputs.map(value), [...poseidon2Permutation(input)]);
      return { poseidon2PermutationMs: +timed(500, i => poseidon2Permutation([BigInt(i ?? 0), 2n, 3n, 4n])).toFixed(3),
        barretenbergWasmPermutationMs: +timed(5000, i => bb.poseidon2Permutation({ inputs: [be(BigInt(i ?? 0)), be(2n), be(3n), be(4n)] })).toFixed(3) };
    })(),
    recordBytesAt14656ByteProof: { issue: exact[0].length, spend: exact[1].length },
  };
  const cases = [];
  // Real-size proofs exceed the 1 MiB local trail budget beyond about 64 events;
  // larger cases carry 32-byte stand-ins, which only the SHA256 hashing sees.
  for (const [n, every, proofBytes] of [[60, 10, 14656], [60, 60, 14656], [256, 256, 32], [256, 16, 32], [1024, 1024, 32], [1024, 64, 32]]) {
    const row = await measure(n, every, proofBytes); cases.push(row); console.log(JSON.stringify(row));
  }
  const conformance = JSON.parse(readFileSync(join(root, "docs/pool-v3-conformance-verification.json"), "utf8"));
  const verifyMs = Object.fromEntries(["issue", "spend", "burn", "demand", "settle", "request"].map(kind => {
    const values = conformance.metrics.filter(m => m.kind === kind).map(m => m.verifyMs);
    return [kind, { min: +Math.min(...values).toFixed(1), max: +Math.max(...values).toFixed(1), samples: values.length }];
  }));
  const report = { schema: 1, purpose: "recovery map A13 / probe P3: local replay time, memory and evidence bytes", specification: V3_SPECIFICATION,
    node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? null,
    sourceHashEncoding: "SHA-256 of UTF-8 source with CRLF normalized to LF",
    // The executed dist modules with their src sources, and the compiled model files.
    sources: sourceHashes(sourceClosure(["scripts/pool/v3/replay-cost.mjs", ...models])),
    verifier: "counting stub returning true; proofs are random bytes of the stated length",
    verifyMsFromConformanceReport: verifyMs, components, cases, maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    limits: ["one synthetic single-backing segment of spends with empty-root anchors; no imports, scopes, publications or demands",
      "real proof verification is not run here; its cost is the conformance report's single-thread desktop measurement",
      "one desktop machine, one run per case; timings include garbage collection and are not device budgets",
      "32-byte proof stand-ins beyond 60 events keep trails inside the 1 MiB local budget"] };
  if (args[0] === "--out") writeFileSync(resolve(root, args[1]), JSON.stringify(report, null, 2) + "\n");
  else console.log(JSON.stringify({ components, verifyMs }, null, 2));
} finally {
  rmSync(build, { recursive: true, force: true });
}
