// A phone-class proxy for a holder's costs (aggregation probe): each part runs the reference's own code on this host in
// one process of its own, bb.js as WebAssembly (the backend a phone runs; never the native bb binary), JavaScript parts
// single-threaded. A desktop core is not a phone core: the numbers are a proxy to scale, not phone measurements.
//
//   node scripts/pool/aggregation-probe/phone.mjs [--part <name>]... [--size small|full] [--threads 1,4] [--n <count>]
//
// Parts (default all): verify-root, prove-spend, digests, headers, capsules, replay. Prints one JSON line per part
// and merges results/phone.json under the size. `--threads` overrides the thread counts of the bb.js parts (small: 1,
// full: 1 and 4); `--n` overrides each part's main count (results kept under "<size>, n <count>"). Needs
// `npm run build` and `node scripts/pool/prepare-crs.mjs`. Run on an idle host for timings.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const here = import.meta.dirname, root = path.resolve(here, '../../..'), script = path.join(here, 'phone.mjs');
const dist = p => path.join(root, 'dist', p);
const PARTS = ['verify-root', 'prove-spend', 'digests', 'headers', 'capsules', 'replay'];
const SIZES = {
  small: { verifyN: 3, proveN: 1, threads: [1], digests: 100, headerReps: 2, headerChain: 20, capsules: 1000, replay: 20, replayReads: 2 },
  full: { verifyN: 20, proveN: 3, threads: [1, 4], digests: 10000, headerReps: 30, headerChain: 1000, capsules: 100000, replay: 1000, replayReads: 3 },
};
const ERGO_MAINNET_HEIGHT = 1_890_000, ERGO_V1_LAST = 417_791, EIP37 = 844_673, CAPSULE_TARGET = 4_000_000;

function cpu() {
  try { const m = readFileSync('/proc/cpuinfo', 'utf8').match(/^model name\s*:\s*(.+)$/m); if (m) return m[1].trim(); } catch { /* not Linux */ }
  return os.cpus()[0]?.model ?? 'unknown';
}
const host = () => `${cpu()}, ${os.cpus().length} logical CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GiB, Node ${process.version}, ${os.platform()}`;
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ms = x => Math.round(x * 1000) / 1000;
const stats = xs => ({ n: xs.length, medianMs: ms(median(xs)), minMs: ms(Math.min(...xs)), maxMs: ms(Math.max(...xs)) });
const peakRssMB = () => Math.round(process.resourceUsage().maxRSS / 1024);
const b = n => new Uint8Array(32).fill(n);
/** A 32-byte request identifier unique per (tag, n). */
const rid = (tag, n) => { const r = new Uint8Array(32); r[0] = tag; new DataView(r.buffer).setUint32(28, n); return r; };
const hex = x => Buffer.from(x).toString('hex');
const bbVersion = () => JSON.parse(readFileSync(path.join(root, 'node_modules/@aztec/bb.js/package.json'), 'utf8')).version;

function args(argv) {
  const out = { parts: [], size: 'small', threads: undefined, child: undefined, n: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--part') out.parts.push(v());
    else if (a === '--size') out.size = v();
    else if (a === '--threads') out.threads = v().split(',').map(Number);
    else if (a === '--child') out.child = v();
    else if (a === '--n') out.n = Number(v());
    else if (a === '--help' || a === '-h') { console.log(readFileSync(script, 'utf8').split('\n').slice(0, 10).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(out.size in SIZES)) throw new Error('--size is small or full');
  for (const p of out.parts) if (!PARTS.includes(p)) throw new Error(`unknown part ${p}; parts: ${PARTS.join(', ')}`);
  if (out.threads && out.threads.some(t => !Number.isSafeInteger(t) || t < 1 || t > 64)) throw new Error('--threads takes counts 1 to 64');
  if (out.n !== undefined && (!Number.isSafeInteger(out.n) || out.n < 1)) throw new Error('--n takes a positive count');
  if (out.parts.length === 0) out.parts = [...PARTS];
  return out;
}

async function params() {
  const { PARAMETER_DIRECTORY, readParameters } = await import(path.join(root, 'scripts/pool/prepare-crs.mjs'));
  return readParameters(PARAMETER_DIRECTORY);
}
/** The genuine pool-v3 spend proof the conformance build made (dump-proofs.mjs) and its public inputs. */
function genuineSpend() {
  return { proof: new Uint8Array(readFileSync(path.join(here, 'proofs/spend.proof'))),
    pi: JSON.parse(readFileSync(path.join(here, 'proofs/spend.json'), 'utf8')).publicInputs.map(BigInt) };
}

// 1. One UltraHonk noir-recursive verification in WebAssembly.
async function verifyRoot(size, threads) {
  const { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } = await import('@aztec/bb.js');
  const { startBackend, PROOF_OPTIONS } = await import(dist('pool/proof-verifier.js'));
  const { openV3Verifier } = await import(dist('pool/v3/verifier.js'));
  const { adoptedConfiguration } = await import(dist('pool/v3/configuration.js'));
  const { adoptedPrograms } = await import(dist('pool/v3/programs.js'));
  const { fieldToHex } = await import(dist('pool/field.js'));
  const N = SIZES[size].verifyN, parameters = await params(), { proof, pi } = genuineSpend(), out = { threads, backend: 'WasmWorker' };
  // The reference's path: a checked instance (startBackend: 2^15 G1 points and [x]_2), the six keys derived and pinned
  // against the configuration (openV3Verifier), verifications on the verifier's own one-point instance.
  let t = performance.now();
  const api = await startBackend(parameters, { threads });
  out.startBackendMs = ms(performance.now() - t);
  try {
    t = performance.now();
    const verifier = await openV3Verifier(api, { threads });
    out.openV3VerifierMs = ms(performance.now() - t);
    t = performance.now();
    const first = await verifier.verify(2, pi, proof);
    out.reference = { firstVerifyMs: ms(performance.now() - t), firstVerdict: first };
    const times = [];
    for (let i = 0; i < N; i++) { t = performance.now(); if (await verifier.verify(2, pi, proof) !== true) throw new Error('genuine spend refused'); times.push(performance.now() - t); }
    out.reference.verify = stats(times);
    out.reference.tamperedVerdict = await verifier.verify(2, pi.map((v, i) => i === 0 ? v + 1n : v), proof);
    await verifier.close();
    // The key as proof-verifier derives it, checked against the configuration's identity: a phone pins it.
    const vk = await new UltraHonkBackend(adoptedPrograms().spend.bytecode, api).getVerificationKey(PROOF_OPTIONS);
    if (createHash('sha256').update(vk).digest('hex') !== hex(adoptedConfiguration().circuits.spend.vk)) throw new Error('derived spend key is not the configuration\'s');
    out.keyBytes = vk.length;
    // A phone's path with the pinned key: a fresh instance holding [1]_1 and [x]_2 only (proof-verifier's load()),
    // then verifications on it.
    t = performance.now();
    const fresh = await Barretenberg.new({ backend: BackendType.WasmWorker, threads, skipSrsInit: true });
    await fresh.srsInitSrs({ pointsBuf: Uint8Array.from(parameters.g1.subarray(0, 64)), numPoints: 1, g2Point: Uint8Array.from(parameters.g2) });
    out.pinned = { instanceStartMs: ms(performance.now() - t) };
    try {
      const backend = new UltraHonkVerifierBackend(fresh), input = { proof, publicInputs: pi.map(fieldToHex), verificationKey: vk };
      t = performance.now();
      if (await backend.verifyProof(input, PROOF_OPTIONS) !== true) throw new Error('genuine spend refused (pinned path)');
      out.pinned.firstVerifyMs = ms(performance.now() - t);
      const times2 = [];
      for (let i = 0; i < N; i++) { t = performance.now(); if (await backend.verifyProof(input, PROOF_OPTIONS) !== true) throw new Error('refused'); times2.push(performance.now() - t); }
      out.pinned.verify = stats(times2);
    } finally { await fresh.destroy(); }
  } finally { await api.destroy(); }
  out.proofBytes = proof.length; out.publicInputs = pi.length;
  out.note = 'The proof is a genuine pool-v3 spend (scripts/pool/aggregation-probe/proofs/spend.proof). An aggregation root ' +
    'is an UltraHonk noir-recursive proof of the same 458 fields (14,656 bytes) verified the same way with 2 public inputs, ' +
    'so its verification costs the same. startBackend/openV3Verifier load 2^15 points and derive six keys, which a ' +
    'verify-only phone with pinned keys skips: its cost is pinned.instanceStartMs + one verification.';
  return out;
}

// 2. A spend proved on the holder's device through the reference's prover (openV3Prover over startBackend).
async function proveSpend(size, threads) {
  const { Noir } = await import('@noir-lang/noir_js');
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { startBackend } = await import(dist('pool/proof-verifier.js'));
  const { openV3Prover } = await import(dist('pool/v3/prover.js'));
  const { adoptedDomain } = await import(dist('pool/v3/configuration.js'));
  const { adoptedPrograms } = await import(dist('pool/v3/programs.js'));
  const { prepareExactOutput } = await import(dist('pool/v3/capsules.js'));
  const { encodeRootTerms, rootTermsName } = await import(dist('pool/v3/terms.js'));
  const { spendTask } = await import(dist('pool/v3/witness.js'));
  const { NoteTree } = await import(dist('pool/note-tree.js'));
  const { FixtureVenue } = await import(dist('record-venue.js'));
  const N = SIZES[size].proveN, out = { threads, backend: 'WasmWorker', proofs: N };
  // The spend scripts/pool/v3/journal-crash.mjs and store-check.mjs build: one funded input and a padding input under
  // the tree after the issue, four outputs each its recipient's exact request.
  const domain = adoptedDomain(), issuer = ed25519.getPublicKey(b(15)), operator = ed25519.getPublicKey(b(16));
  const venue = FixtureVenue.reference(b(12), 2n);
  const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id, interval: 20n,
    payout: { thing: 'phone probe units', quantumExponent: 0, perUnit: 1n } });
  const backing = rootTermsName(terms), context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
  const o = (seed, id, value) => prepareExactOutput(b(seed), domain, b(id), backing, value);
  const funded = o(21, 31, 10n), pad = o(21, 32, 0n), tree = new NoteTree(); tree.append(funded.cm);
  const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
  const task = spendTask(context, [input, { ...input, note: pad }], [o(22, 33, 7n), o(23, 34, 1n), o(21, 35, 2n), o(21, 36, 0n)]);
  let t = performance.now();
  const api = await startBackend(await params(), { threads });
  out.startBackendMs = ms(performance.now() - t);
  try {
    t = performance.now();
    const prover = await openV3Prover(api, { threads });
    out.openV3ProverMs = ms(performance.now() - t);
    try {
      const noir = new Noir(adoptedPrograms().spend), total = [], execute = [], verify = [];
      for (let i = 0; i < N; i++) {
        t = performance.now(); await noir.execute(task.witness); execute.push(performance.now() - t);
        t = performance.now(); const record = await prover.prove(task); total.push(performance.now() - t);
        t = performance.now(); if (await prover.verifier.verify(2, record.publicInputs, record.proof) !== true) throw new Error('proof refused'); verify.push(performance.now() - t);
        out.proofBytes = record.proof.length;
      }
      out.prove = stats(total);
      out.witnessExecute = stats(execute);
      out.verify = stats(verify);
      out.generateProofEstimateMs = ms(median(total) - median(execute) - median(verify));
    } finally { await prover.close(); }
  } finally { await api.destroy(); }
  out.peakRssMB = peakRssMB();
  out.note = 'prove = V3Prover.prove (noir_js witness execution, UltraHonk generateProof under noir-recursive, the prover\'s own ' +
    'verification); witnessExecute and verify are timed separately on the same task so generateProofEstimateMs = prove − both ' +
    '(medians). The first proof includes the instance\'s first-proof setup. peakRssMB is this process\'s maximum resident set, ' +
    'WASM workers included, after startBackend loaded 2^15 G1 points.';
  return out;
}

// 3. The phone's recomputation of leaf and node digests (host Poseidon2: bb.js's single-threaded WASM instance).
async function digests(size) {
  const { leafDigest, nodeDigest, genuine, KINDS, sha256 } = await import('./lib.mjs');
  const n = SIZES[size].digests, kinds = Object.keys(KINDS);
  const statements = kinds.map(k => { const g = genuine(k); return { kind: KINDS[k], pi: g.pi, proofHash: sha256(g.bytes), name: k }; });
  for (const s of statements) leafDigest(s.kind, s.pi, s.proofHash); // warm-up
  const perKind = {};
  for (const s of statements) {
    const reps = Math.max(10, Math.floor(n / statements.length)), t = performance.now();
    for (let i = 0; i < reps; i++) leafDigest(s.kind, s.pi, s.proofHash);
    perKind[s.name] = { publicInputs: s.pi.length, permutations: Math.ceil((s.pi.length + 2) / 2), perLeafMs: ms((performance.now() - t) / reps) };
  }
  const leaves = new Array(n);
  let t = performance.now();
  for (let i = 0; i < n; i++) { const s = statements[i % statements.length]; leaves[i] = leafDigest(s.kind, s.pi, s.proofHash); }
  const leafMs = performance.now() - t;
  // The node digests of a binary tree over the n leaves: n − 1 of them (an odd last node carried up).
  let level = leaves, nodes = 0;
  t = performance.now();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < level.length; i += 2) { next.push(nodeDigest(level[i], level[i + 1])); nodes++; }
    if (level.length % 2) next.push(level[level.length - 1]);
    level = next;
  }
  const nodeMs = performance.now() - t;
  return { statements: n, leafPerStatementMs: ms(leafMs / n), nodes, nodePerDigestMs: ms(nodeMs / nodes), totalPerStatementMs: ms((leafMs + nodeMs) / n),
    totalMs: ms(leafMs + nodeMs), perKind, root: '0x' + level[0].toString(16),
    note: 'lib.mjs leafDigest (kind, public inputs, proofHash halves through Poseidon2 permutations) and nodeDigest (one permutation), ' +
      'over the six relations\' genuine public inputs in turn; proofHash (SHA-256 of the proof) is supplied, not timed. Poseidon2 is ' +
      'the reference\'s host hash, bb.js BarretenbergSync as single-threaded WASM.' };
}

// 4. Ergo header checks (src/ergo-headers.ts, pure JavaScript: Blake2b and secp256k1 from @noble).
async function headers(size) {
  const H = await import(dist('ergo-headers.js'));
  const { blake2b } = await import('@noble/hashes/blake2b.js');
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { headerReps: reps, headerChain } = SIZES[size], out = {};
  const fixture = f => JSON.parse(readFileSync(path.join(root, 'test/fixtures', f), 'utf8')).headers.map(h => ({ ...h, bytes: Uint8Array.from(Buffer.from(h.bytes, 'hex')) }));
  const recalc = fixture('ergo-mainnet-recalculation.json'), early = fixture('ergo-mainnet-v1-headers.json');
  // (a) Parse, id and proof of work of real mainnet headers, by Autolykos version.
  const groups = {
    'v2, version 4, heights 1,872,384-1,873,409': recalc,
    'v2, version 2, heights 417,792-417,793': early.filter(h => h.version !== 1),
    'v1, version 1, heights 1-417,791': early.filter(h => h.version === 1),
  };
  out.realPow = {};
  for (const [name, hs] of Object.entries(groups)) {
    for (const h of hs) { const p = H.parseErgoHeader(h.bytes); if (!p || hex(p.id) !== h.id || !H.autolykosPowValid(p)) throw new Error(`fixture header ${h.height} does not check`); }
    const t = performance.now();
    for (let r = 0; r < reps; r++) for (const h of hs) H.autolykosPowValid(H.parseErgoHeader(h.bytes));
    const per = (performance.now() - t) / (reps * hs.length);
    out.realPow[name] = { headers: hs.length, heights: hs.map(h => h.height), perHeaderMs: ms(per), headersPerSecond: Math.round(1000 / per) };
  }
  // The EIP-37 recalculation, once an epoch of 128 headers, over the real boundary headers.
  const previous = recalc.slice(0, 9).map(h => H.parseErgoHeader(h.bytes));
  if (H.eip37Difficulty(previous) !== H.decodeCompactBits(H.parseErgoHeader(recalc[9].bytes).nBits)) throw new Error('recalculation fixture does not reproduce');
  let t = performance.now();
  for (let r = 0; r < reps * 10; r++) H.eip37Difficulty(previous);
  out.eip37RecalculationMs = ms((performance.now() - t) / (reps * 10));
  // (b) The store's full child-header check (parse, id, link, height, timestamp, required difficulty, proof of work)
  // over a synthetic chain at difficulty 4 above an anchor at an epoch boundary (as test/ergo-headers.test.ts builds it):
  // the v2 hit's cost does not depend on the difficulty, which only sets how many nonces mining tries.
  const vlq = n => { const o = []; do { let x = Number(n & 0x7fn); n >>= 7n; if (n > 0n) x |= 0x80; o.push(x); } while (n > 0n); return o; };
  const G = secp256k1.ProjectivePoint.BASE.toRawBytes(true), D4 = 0x0104_0000, MINUTE = 60_000n, T0 = 1_700_000_000_000n;
  const encode = f => {
    const nonce = new Uint8Array(8); new DataView(nonce.buffer).setBigUint64(0, f.nonce ?? 0n);
    return Uint8Array.from([4, ...f.parentId, ...b(1), ...b(2), ...new Uint8Array(33).fill(3), ...vlq(f.timestamp), ...b(4),
      (D4 >>> 24) & 0xff, (D4 >>> 16) & 0xff, (D4 >>> 8) & 0xff, D4 & 0xff, ...vlq(f.height), 0, 0, 0, 0, ...G, ...nonce]);
  };
  const anchorHeight = 128n * 6602n, context = [];
  let parentId = b(9);
  for (let i = 0; i <= H.ANCHOR_CONTEXT; i++) {
    const bytes = encode({ parentId, timestamp: T0 + BigInt(i) * 2n * MINUTE, height: anchorHeight - BigInt(H.ANCHOR_CONTEXT - i), nonce: BigInt(i) });
    context.push(bytes); parentId = blake2b(bytes, { dkLen: 32 });
  }
  const chain = [];
  let parent = H.parseErgoHeader(context.at(-1)), tries = 0;
  t = performance.now();
  for (let i = 0; i < headerChain; i++) {
    for (let nonce = 0n; ; nonce++) {
      tries++;
      const bytes = encode({ parentId: parent.id, timestamp: parent.timestamp + 2n * MINUTE, height: parent.height + 1n, nonce });
      const h = H.parseErgoHeader(bytes);
      if (H.autolykosPowValid(h)) { chain.push(bytes); parent = h; break; }
    }
  }
  out.syntheticMiningMs = ms(performance.now() - t);
  const store = H.ergoHeaderStore(blake2b(context.at(-1), { dkLen: 32 }), context);
  if (store === undefined) throw new Error('store not built');
  t = performance.now();
  for (const bytes of chain) { const r = store.add(bytes); if (r !== 'added') throw new Error(`store refused a synthetic header: ${r}`); }
  const storeMs = performance.now() - t, perStore = storeMs / chain.length;
  out.store = { headers: chain.length, epochBoundariesCrossed: Math.floor(chain.length / 128), perHeaderMs: ms(perStore), headersPerSecond: Math.round(1000 / perStore),
    miningTriesPerHeader: Math.round(tries / chain.length * 10) / 10 };
  const v1 = out.realPow['v1, version 1, heights 1-417,791'].perHeaderMs, v2 = Math.max(perStore, out.realPow['v2, version 4, heights 1,872,384-1,873,409'].perHeaderMs);
  const fromGenesisS = (ERGO_V1_LAST * v1 + (ERGO_MAINNET_HEIGHT - ERGO_V1_LAST) * v2) / 1000;
  const fromEip37S = (ERGO_MAINNET_HEIGHT - EIP37) * v2 / 1000;
  out.extrapolation = {
    label: 'EXTRAPOLATION, not a measurement: per-header times above multiplied by header counts, single-threaded, excluding download, storage and the anchor context',
    mainnetHeightUsed: ERGO_MAINNET_HEIGHT,
    fromGenesis: { headers: ERGO_MAINNET_HEIGHT, v1Headers: ERGO_V1_LAST, v1PerHeaderMs: v1, v2Headers: ERGO_MAINNET_HEIGHT - ERGO_V1_LAST, v2PerHeaderMs: ms(v2),
      seconds: Math.round(fromGenesisS), hours: Math.round(fromGenesisS / 36) / 100,
      limit: 'the reference store admits mainnet anchors only from EIP-37 activation (844,673); below it the difficulty rule is not implemented, so these heights are costed by proof of work alone' },
    fromEip37Anchor: { anchorHeight: EIP37, headers: ERGO_MAINNET_HEIGHT - EIP37, perHeaderMs: ms(v2), seconds: Math.round(fromEip37S), hours: Math.round(fromEip37S / 36) / 100 },
  };
  out.note = 'No contiguous real mainnet chain is kept in the repository: test/fixtures holds 10 real EIP-37 boundary headers ' +
    '(ergo-mainnet-recalculation.json) and 9 early headers (ergo-mainnet-v1-headers.json), timed for parse + id + proof of work; ' +
    'the store\'s full check is timed over a synthetic difficulty-4 chain. v2 extrapolation uses the larger of the store and real-header per-header times.';
  return out;
}

// 5. A restore's trial decryption of capsules (src/pool/v3/capsules.ts).
async function capsules(size) {
  const { createCapsuleScanner, prepareExactOutput } = await import(dist('pool/v3/capsules.js'));
  const { adoptedDomain } = await import(dist('pool/v3/configuration.js'));
  const n = SIZES[size].capsules, domain = adoptedDomain(), backing = b(9), seed = b(21);
  const poolSize = Math.min(n, 2000), ownCount = Math.max(1, Math.floor(n / 100));
  let t = performance.now();
  const foreign = Array.from({ length: poolSize }, (_, i) => prepareExactOutput(createHash('sha256').update(`foreign seed ${i}`).digest(), domain, rid(1, i), backing, BigInt(i + 1)));
  const prepareMs = (performance.now() - t) / poolSize;
  const own = Array.from({ length: ownCount }, (_, i) => prepareExactOutput(seed, domain, rid(2, i), backing, BigInt(i + 1)));
  // Mixed: one capsule in a hundred is the seed's own.
  const scanner = createCapsuleScanner(seed, domain);
  let matches = 0, ownAt = 0;
  t = performance.now();
  for (let i = 0; i < n; i++) {
    const c = i % 100 === 0 && ownAt < ownCount ? own[ownAt++] : foreign[i % poolSize];
    if (scanner.tryRecover(c.cm, c.capsule) !== null) matches++;
  }
  const mixedMs = performance.now() - t;
  if (matches !== ownAt) throw new Error(`scanner recovered ${matches}, expected ${ownAt}`);
  const foreignScanner = createCapsuleScanner(seed, domain);
  t = performance.now();
  for (let i = 0; i < n; i++) { const c = foreign[i % poolSize]; if (foreignScanner.tryRecover(c.cm, c.capsule) !== null) throw new Error('foreign capsule recovered'); }
  const foreignMs = performance.now() - t, perForeign = foreignMs / n;
  const ownScanner = createCapsuleScanner(seed, domain);
  t = performance.now();
  for (const c of own) if (ownScanner.tryRecover(c.cm, c.capsule) === null) throw new Error('own capsule not recovered');
  const perOwn = (performance.now() - t) / own.length;
  const target = CAPSULE_TARGET * perForeign / 1000;
  return {
    trials: n, distinctForeignCapsules: poolSize, ownCapsules: ownAt, matches,
    foreign: { perCapsuleMs: ms(perForeign), capsulesPerSecond: Math.round(1000 / perForeign) },
    mixedOnePercentOwn: { perCapsuleMs: ms(mixedMs / n), capsulesPerSecond: Math.round(n / mixedMs * 1000) },
    ownMatchPerCapsuleMs: ms(perOwn), senderPrepareExactOutputMs: ms(prepareMs),
    extrapolation: { label: 'EXTRAPOLATION, not a measurement: foreign per-capsule time × count, single-threaded, excluding fetching the capsules',
      capsules: CAPSULE_TARGET, seconds: Math.round(target), minutes: Math.round(target / 6) / 10 },
    note: 'createCapsuleScanner(seed, domain).tryRecover(cm, capsule): master keys derived once, then per capsule the recovery-key ' +
      'decryption attempt; a foreign capsule fails authentication, an own one is decrypted and its commitment recomputed. Foreign ' +
      'capsules are genuine (prepareExactOutput under 2,000 other seeds), cycled to the trial count.',
  };
}

// 6. Proof-free replay of a served package by a holder (readPackage with a verifier that accepts stand-in proofs).
async function replay(size) {
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const { NoteTree } = await import(dist('pool/note-tree.js'));
  const { prepareExactOutput } = await import(dist('pool/v3/capsules.js'));
  const { adoptedConfiguration, adoptedDomain, PROOF_BYTES } = await import(dist('pool/v3/configuration.js'));
  const { encodeRecord } = await import(dist('pool/v3/records.js'));
  const { V3OperatorJournal } = await import(dist('pool/v3/store.js'));
  const { readPackage } = await import(dist('pool/v3/package-reader.js'));
  const { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } = await import(dist('pool/v3/terms.js'));
  const { authorizeIssue, issueTask, spendTask } = await import(dist('pool/v3/witness.js'));
  const { FixtureVenue, LOCAL_REFERENCE } = await import(dist('record-venue.js'));
  const N = SIZES[size].replay, reads = SIZES[size].replayReads, out = { spends: N, statements: N + 1 };
  const domain = adoptedDomain(), issuerSecret = b(15), operatorSecret = b(16);
  const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
  const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag };
  // Stand-in proofs of the configuration's proof length whose first byte is the kind; the verifier accepts exactly those
  // (test/pool-v3-store.test.ts's verifier) and counts its calls.
  let verifierCalls = 0;
  const verifier = { identities: adoptedConfiguration().circuits, verify: (kind, _inputs, proof) => { verifierCalls++; return proof[0] === kind; } };
  const record = task => ({ domain, kind: task.kind, publicInputs: task.publicInputs, proof: new Uint8Array(PROOF_BYTES).fill(task.kind),
    authorization: new Uint8Array(), capsules: task.capsules });
  mkdirSync(path.join(root, 'scratch'), { recursive: true });
  const dir = mkdtempSync(path.join(realpathSync(path.join(root, 'scratch')), 'aggregation-probe-phone-'));
  try {
    const venue = FixtureVenue.reference(label, lag), journal = new V3OperatorJournal(path.join(dir, 'journal.db'), { secret: operatorSecret, venue, reference, verifier });
    try {
      const terms = encodeRootTerms({ obligor: issuer, payout: { thing: 'phone probe units', quantumExponent: 0, perUnit: 1n }, operator, configuration: domain, venue: venue.id, interval: 10n });
      const backing = rootTermsName(terms), context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
      await journal.open('genesis', { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) });
      await journal.publish();
      // One issue, then a chain of spends: each spends the last change and a fresh padding note into a payment, a fee,
      // change and a zero output, under the tree root after the previous statement.
      const o = (seed, tag, i, value) => prepareExactOutput(b(seed), domain, rid(tag, i), backing, value);
      const tree = new NoteTree();
      let current = o(21, 1, 0, BigInt(2 * N + 10)), position = 0n, t = performance.now(), prepareMs = 0;
      await journal.submit(encodeRecord(authorizeIssue(record(issueTask(context, current)), issuerSecret)));
      tree.append(current.cm);
      for (let i = 0; i < N; i++) {
        const p0 = performance.now();
        const input = { note: current, anchor: tree.root(), path: tree.path(position) }, pad = o(21, 2, i, 0n);
        const outputs = [o(22, 3, i, 1n), o(23, 4, i, 1n), o(21, 5, i, current.opening.value - 2n), o(21, 6, i, 0n)];
        const bytes = encodeRecord(record(spendTask(context, [input, { ...input, note: pad }], outputs)));
        prepareMs += performance.now() - p0;
        await journal.submit(bytes);
        // The issue's output is leaf 0; spend i's outputs are leaves 1 + 4i to 4 + 4i, its change the third.
        tree.appendAll(outputs.map(x => x.cm));
        current = outputs[2]; position = BigInt(1 + 4 * i + 2);
      }
      await journal.commit('c2'); await journal.publish();
      out.buildMs = ms(performance.now() - t); out.holderSidePrepareMs = ms(prepareMs);
      const served = await journal.package();
      out.packageBytes = served.package.length;
      const selection = { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: 'current-fixture' }, times = [];
      for (let r = 0; r < reads; r++) {
        verifierCalls = 0;
        t = performance.now();
        const result = await readPackage(served.package, selection, { verifier, venue, reference });
        times.push(performance.now() - t);
        if (result.state?.position !== BigInt(N + 1)) throw new Error(`replay reached position ${result.state?.position}, expected ${N + 1}`);
        out.verifierCallsPerRead = verifierCalls;
      }
      out.read = stats(times);
      out.perStatementMs = ms(median(times) / (N + 1));
    } finally { journal.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  out.note = 'readPackage (src/pool/v3/package-reader.ts) over the operator journal\'s served package: decode, evidence store ' +
    '(in memory), terms and checkpoint signatures, the fixture venue\'s records, each statement\'s state transition (spent set, note ' +
    'tree appends in host Poseidon2, delivery) and receipts. Proof verification is excluded: stand-in proofs of the configuration\'s ' +
    'length, judged by a stub (first byte = kind). Venue reads are in-memory fixture answers, no network. Per statement = read / ' +
    '(1 issue + N spends).';
  return out;
}

const RUN = { 'verify-root': verifyRoot, 'prove-spend': proveSpend, digests, headers, capsules, replay };
const THREADED = new Set(['verify-root', 'prove-spend']);
/** The count `--n` overrides in each part. */
const COUNT = { 'verify-root': 'verifyN', 'prove-spend': 'proveN', digests: 'digests', headers: 'headerChain', capsules: 'capsules', replay: 'replay' };

async function child(part, size, threads) {
  let result;
  try { result = { ok: true, ...await RUN[part](size, threads) }; }
  catch (error) { result = { ok: false, error: String(error?.stack ?? error).slice(0, 2000) }; }
  result.peakRssMB = result.peakRssMB ?? peakRssMB();
  process.stdout.write('\n' + JSON.stringify(result) + '\n');
  process.exit(0);
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.child !== undefined) {
    if (a.n !== undefined) SIZES[a.size][COUNT[a.child]] = a.n;
    return child(a.child, a.size, a.threads?.[0] ?? 1);
  }
  const key = a.n === undefined ? a.size : `${a.size}, n ${a.n}`;
  const resultsPath = path.join(here, 'results/phone.json');
  let all = {};
  try { if (existsSync(resultsPath)) all = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch { all = {}; }
  const meta = { host: host(), bbjs: bbVersion(), measuredAt: new Date().toISOString() };
  for (const part of a.parts) {
    const threadSet = THREADED.has(part) ? (a.threads ?? SIZES[a.size].threads) : [1];
    const runs = {};
    for (const threads of threadSet) {
      const started = performance.now();
      const r = spawnSync(process.execPath, [script, '--child', part, '--size', a.size, '--threads', String(threads), ...(a.n === undefined ? [] : ['--n', String(a.n)])],
        { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, timeout: a.size === 'full' ? 7_200_000 : 600_000, env: process.env });
      const line = (r.stdout ?? '').trim().split('\n').reverse().find(l => l.startsWith('{'));
      let parsed;
      try { parsed = line ? JSON.parse(line) : undefined; } catch { parsed = undefined; }
      runs[`threads${threads}`] = parsed ?? { ok: false, error: `child exited ${r.status ?? r.signal ?? r.error?.code} without a result`,
        stderr: (r.stderr ?? '').slice(-1500) };
      runs[`threads${threads}`].wallMs = Math.round(performance.now() - started);
      runs[`threads${threads}`].measuredAt = new Date().toISOString();
    }
    const entry = { ...meta, size: key, ...(THREADED.has(part) ? { runs } : { singleThreaded: true, ...runs.threads1 }) };
    console.log(JSON.stringify({ part, ...entry }));
    // Merge per part as it finishes, so a later failure keeps the earlier parts.
    let current = {};
    try { if (existsSync(resultsPath)) current = JSON.parse(readFileSync(resultsPath, 'utf8')); } catch { current = all; }
    // A bb.js part keeps the runs at thread counts this invocation did not run.
    const kept = current[key]?.[part];
    current[key] = { ...(current[key] ?? {}), [part]: THREADED.has(part) && kept?.runs ? { ...entry, runs: { ...kept.runs, ...runs } } : entry };
    mkdirSync(path.dirname(resultsPath), { recursive: true });
    writeFileSync(resultsPath, JSON.stringify(current, null, 1) + '\n');
    all = current;
  }
}

await main();
