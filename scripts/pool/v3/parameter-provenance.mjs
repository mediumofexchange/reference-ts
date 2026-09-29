// Probe for adoption slice 8 M1 (pool-v3 §4, proving parameters). Not runtime;
// retired once its report is recorded. It compares the cached BN254 parameters
// with Aztec Ignition's transcript00 (range-fetched), checks with a random
// linear combination that the G1 points are powers of the x in [x]_2 (--pairing,
// minutes), proves and verifies issue with only caller-loaded BN254 points,
// and, with --noir <node_modules>, reproduces the six identities under another
// Noir compiler. Run after `node scripts/pool/prepare-crs.mjs` and a build.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bn254 } from '@noble/curves/bn254';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';
import { fixtures } from '../fixtures.mjs';
import { deliveryHash } from '../../../dist/pool/v3/records.js';
import { loadCandidateManifest, RELATION_KINDS } from './candidate.mjs';
import { sourceClosure, sourceHashes } from './provenance.mjs';

const here = import.meta.dirname, root = path.resolve(here, '../../..');
const crs = path.join(root, 'scratch/private-payment-crs'), work = path.join(root, 'scratch/parameter-provenance');
const TRANSCRIPT = 'https://aztec-ignition.s3-eu-west-2.amazonaws.com/MAIN%20IGNITION/monomial/transcript00.dat';
const TRANSCRIPT_BYTES = 322560412, HEADER = 28, POINTS = 1 << 19;
const argv = process.argv.slice(2), pairing = argv.includes('--pairing');
const noirDir = argv.includes('--noir') ? path.resolve(argv[argv.indexOf('--noir') + 1]) : undefined;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const options = Object.freeze({ verifierTarget: 'noir-recursive' });
const manifest = loadCandidateManifest(), checks = [], report = {};
mkdirSync(work, { recursive: true });

async function range(first, last, file) {
  const target = path.join(work, file);
  if (existsSync(target) && readFileSync(target).length === last - first + 1) return readFileSync(target);
  const response = await fetch(TRANSCRIPT, { headers: { Range: `bytes=${first}-${last}` }, cache: 'no-store' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes ${first}-${last}/${TRANSCRIPT_BYTES}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, last - first + 1);
  writeFileSync(target, bytes);
  return bytes;
}

// 1. Byte equality with Ignition. A transcript field element is four u64 limbs,
// least significant first, each big-endian; bb's files are 32-byte big-endian.
const g1 = readFileSync(path.join(crs, 'bn254_g1.dat')), g2 = readFileSync(path.join(crs, 'bn254_g2.dat'));
assert.equal(g1.length, POINTS * 64); assert.equal(g2.length, 128);
const head = await range(0, HEADER + POINTS * 64 - 1, 'transcript00-head.bin');
const header = [...Array(7)].map((_, i) => head.readUInt32BE(4 * i));
// transcript, transcripts, total G1, total G2, G1 here, G2 here, start
assert.deepEqual(header, [0, 1, 5040001, 2, 5040001, 2, 0]);
const g2At = HEADER + 64 * header[4];
const tail = await range(g2At, g2At + 128 - 1, 'transcript00-g2.bin');
const element = (buffer, at) => Buffer.concat([3, 2, 1, 0].map(i => buffer.subarray(at + 8 * i, at + 8 * i + 8)));
for (let i = 0; i < POINTS * 2; i++) {
  if (!element(head, HEADER + 32 * i).equals(g1.subarray(32 * i, 32 * i + 32))) assert.fail(`G1 coordinate ${i} differs from transcript00`);
}
assert(Buffer.concat([0, 1, 2, 3].map(j => element(tail, 32 * j))).equals(g2), 'G2 differs from transcript00');
checks.push(`bn254_g1.dat equals transcript00's first ${POINTS} G1 points and bn254_g2.dat its first G2 point`);
report.parameters = { 'bn254_g1.dat': sha(g1), 'bn254_g2.dat': sha(g2), transcript: TRANSCRIPT, transcriptBytes: TRANSCRIPT_BYTES,
  transcriptHeader: header, transcriptRangesSha256: { head: sha(head), g2: sha(tail) } };

// 2. [x]_2 is a valid G2 point, and the G1 points are powers of its x:
// e(sum r_i P_{i+1}, [1]_2) == e(sum r_i P_i, [x]_2) for random 128-bit r_i.
const big = bytes => BigInt('0x' + bytes.toString('hex'));
const Fp2 = bn254.fields.Fp2;
const x2 = bn254.G2.ProjectivePoint.fromAffine({
  x: Fp2.fromBigTuple([big(g2.subarray(0, 32)), big(g2.subarray(32, 64))]),
  y: Fp2.fromBigTuple([big(g2.subarray(64, 96)), big(g2.subarray(96, 128))]),
});
x2.assertValidity();
checks.push('[x]_2 is on the twist and in the G2 subgroup');
if (pairing) {
  const started = performance.now();
  const points = [];
  for (let i = 0; i < POINTS; i++) {
    const point = bn254.G1.ProjectivePoint.fromAffine({ x: big(g1.subarray(64 * i, 64 * i + 32)), y: big(g1.subarray(64 * i + 32, 64 * i + 64)) });
    point.assertValidity();
    points.push(point);
  }
  const r = [...Array(POINTS - 1)].map(() => big(randomBytes(16)) + 1n);
  const lower = bn254.G1.ProjectivePoint.msm(points.slice(0, -1), r), upper = bn254.G1.ProjectivePoint.msm(points.slice(1), r);
  assert(bn254.fields.Fp12.eql(bn254.pairing(upper, bn254.G2.ProjectivePoint.BASE), bn254.pairing(lower, x2)), 'G1 points are not powers of x');
  checks.push(`all ${POINTS} G1 points are on the curve and, by a random 128-bit linear combination, consecutive powers of the x in [x]_2`);
  report.pairingSeconds = Math.round((performance.now() - started) / 1000);
}

// 3. Only BN254 parameters, loaded by the caller: prove and verify issue; a
// verifier instance with G2 and one G1 point; a G2 byte changed.
const start = async (points, g2Point = g2) => {
  const api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, skipSrsInit: true });
  try { await api.srsInitSrs({ pointsBuf: new Uint8Array(g1.subarray(0, points * 64)), numPoints: points, g2Point: new Uint8Array(g2Point) }); }
  catch (error) { await api.destroy(); throw error; }
  return api;
};
const build = path.join(work, 'build');
execFileSync(process.execPath, [path.join(here, 'compile.mjs'), build], { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 300000 });
const program = JSON.parse(readFileSync(path.join(build, 'issue.json'), 'utf8'));
const api = await start(POINTS);
try {
  const f = await fixtures(api), v = structuredClone(f.issue);
  const bytes32 = values => Buffer.concat(values.map(x => Buffer.from(BigInt(x).toString(16).padStart(32, '0'), 'hex')));
  const digest = deliveryHash(bytes32(v.domain), [BigInt(v.cm)], [Uint8Array.from({ length: 89 }, (_, j) => j === 0 ? 1 : j & 255)]);
  v.delivery = [digest.subarray(0, 16), digest.subarray(16)].map(b => BigInt('0x' + Buffer.from(b).toString('hex')).toString());
  const backend = new UltraHonkBackend(program.bytecode, api);
  const vk = await backend.getVerificationKey(options);
  assert.equal(sha(vk), manifest.circuits.issue.vk);
  const proof = await backend.generateProof((await new Noir(program).execute(v)).witness, options);
  assert.equal(await backend.verifyProof(proof, options), true);
  checks.push('issue proves and verifies with the BN254 points and G2 the caller loaded, no Grumpkin parameters, and derives the manifest key');
  const small = await start(1);
  try {
    assert.equal(await new UltraHonkVerifierBackend(small).verifyProof({ ...proof, verificationKey: vk }, options), true);
    const altered = { ...proof, publicInputs: [...proof.publicInputs] };
    altered.publicInputs[5] = '0x' + (BigInt(altered.publicInputs[5]) + 1n).toString(16).padStart(64, '0');
    assert.equal(await new UltraHonkVerifierBackend(small).verifyProof({ ...altered, verificationKey: vk }, options), false);
  } finally { await small.destroy(); }
  checks.push('a verifier instance holding G2 and the single G1 point [1]_1 verifies the proof and refuses it under a changed public input');
  const changed = Buffer.from(g2); changed[127] ^= 1;
  await assert.rejects(start(1, changed), /g2_point bytes do not match the canonical Aztec \[x\]_2 SHA-256/);
  checks.push('the pinned backend refuses a G2 point differing in one byte when it loads parameters');
} finally { await api.destroy(); }

// 4. Another compiler reproduces every identity from the same sources.
if (noirDir) {
  const require = createRequire(path.join(noirDir, 'probe.cjs'));
  const noirPackage = JSON.parse(readFileSync(path.join(noirDir, '@noir-lang/noir_wasm/package.json'), 'utf8'));
  const { compile_program, createFileManager } = await import(pathToFileURL(require.resolve('@noir-lang/noir_wasm')).href);
  const helper = path.join(root, 'src/pool/circuits/vendor/poseidon2.nr'), sources = path.join(here, 'circuits');
  const native = {};
  for (const key of ['join', 'resolve', 'normalize', 'dirname']) { native[key] = path[key]; path[key] = (...a) => native[key](...a).replaceAll('\\', '/'); }
  const reproduced = {}, keyApi = await start(POINTS);
  try {
    for (const [, name] of RELATION_KINDS) {
      const project = path.join(work, 'alternate', name);
      mkdirSync(path.join(project, 'src'), { recursive: true });
      writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "moe_pool_successor_candidate_${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
      copyFileSync(path.join(sources, `${name}.nr`), path.join(project, 'src/main.nr'));
      copyFileSync(path.join(sources, 'notes.nr'), path.join(project, 'src/notes.nr'));
      copyFileSync(helper, path.join(project, 'src/poseidon2.nr'));
      const manager = createFileManager(project), readDirectory = manager.readdir.bind(manager);
      manager.readdir = async (...a) => (await readDirectory(...a)).map(entry => entry.replaceAll('\\', '/'));
      const { program: alternate, warnings } = await compile_program(manager, undefined, () => {}, () => {});
      assert.equal(warnings.length, 0);
      const vk = await new UltraHonkBackend(alternate.bytecode, keyApi).getVerificationKey(options);
      reproduced[name] = { bytecode: sha(Buffer.from(alternate.bytecode, 'base64')), vk: sha(vk) };
      assert.deepEqual(reproduced[name], manifest.circuits[name], `${name} under ${alternate.noir_version}`);
      report.alternateCompiler = alternate.noir_version;
    }
  } finally {
    await keyApi.destroy();
    for (const key of Object.keys(native)) path[key] = native[key];
  }
  assert.equal(noirPackage.version, report.alternateCompiler.split('+')[0]);
  checks.push(`noir_wasm ${noirPackage.version} compiles all six relations to the manifest's bytecode identities, and bb.js derives the manifest's keys from them`);
}
rmSync(build, { recursive: true, force: true });
rmSync(path.join(work, 'alternate'), { recursive: true, force: true });

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const files = sourceClosure(['scripts/pool/v3/parameter-provenance.mjs', 'scripts/pool/v3/compile.mjs', 'scripts/pool/v3/candidate-manifest.json',
  ...RELATION_KINDS.map(([, name]) => `scripts/pool/v3/circuits/${name}.nr`), 'scripts/pool/v3/circuits/notes.nr', 'src/pool/circuits/vendor/poseidon2.nr', 'package-lock.json']);
const output = { probe: 'pool-v3 §4 proving parameters and compiler reproduction (adoption slice 8 M1)', referenceBase: git(['rev-parse', 'HEAD']),
  referenceTreeClean: git(['status', '--porcelain', '--untracked-files=no']) === '',
  environment: { node: process.version, platform: process.platform, arch: process.arch, toolchain: manifest.toolchain, verifierTarget: options.verifierTarget, threads: 1 },
  ...report, checks, sources: sourceHashes(files),
  limits: ['Byte equality with one published transcript copy; the ceremony\'s own contribution chain is not re-verified',
    'The pairing check is probabilistic (random 128-bit coefficients) and covers the 2^19 points bb.js loads, not the whole transcript',
    'Soundness still assumes one honest Ignition participant; no check can establish that']};
const target = path.join(root, 'docs/pool-v3-parameter-provenance.json');
writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
console.log(`PASS: ${checks.length} checks; ${target}`);
