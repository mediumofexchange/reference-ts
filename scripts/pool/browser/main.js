// Synthetic feasibility probe. Every proof is verified against the pinned key;
// proof settings, assets and public input order are checked before reporting success.
const status = document.querySelector('#status'), result = document.querySelector('#result');
const run = document.querySelector('#run'), download = document.querySelector('#download');
let report;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');
const from64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const bytesAt = async (name, expected) => {
  const response = await fetch(`/benchmark-assets/${name}`, { cache: 'no-store' });
  assert(response.ok, `fetch ${name}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expected) {
    assert(bytes.length === expected.bytes, `${name} size mismatch`);
    assert(await sha(bytes) === expected.sha256, `${name} hash mismatch`);
  }
  return bytes;
};
const publicInputs = input => [...input.domain, ...input.segment, input.scope,
  ...input.anchors, ...input.nullifiers, ...input.outputs].map(v => BigInt(v).toString());
const show = () => { result.textContent = JSON.stringify(report, null, 2); };
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'pool-browser-benchmark.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
run.onclick = async () => {
  run.disabled = true; download.disabled = true;
  let api, timer;
  const start = performance.now();
  report = { construction: 'moe/pool/v2', synthetic: true, outcome: 'running',
    device: document.querySelector('#device').value || 'unspecified', userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemoryGiB: navigator.deviceMemory ?? null,
    crossOriginIsolated, threads: 1, verifierTarget: 'noir-recursive',
    samplePlan: 'Three vectors, three proofs per vector; raw samples, no discarded warmup.',
    checkedCircuitsInBrowser: ['spend'],
    startedAt: new Date().toISOString(), hiddenDuringRun: document.hidden, stagesMs: {}, metrics: [],
    memory: { sampledWindowJsHeapPeakBytes: null, wholeBrowserPeakBytes: null,
      limitation: 'Window JS heap excludes worker/WASM allocations; no whole-browser peak measurement.' },
    limitations: ['Synthetic circuit witnesses; no wallet, restoration, resync, publication or finality measurement.',
      'Asset fetches bypass HTTP cache; module/WASM/OS caches may be warm. This is not a cold-device measurement.',
      'Parameter hashes match recorded local files; setup authenticity is not established.'] };
  const visibility = () => { if (document.hidden) report.hiddenDuringRun = true; };
  document.addEventListener('visibilitychange', visibility);
  const sample = () => {
    const used = performance.memory?.usedJSHeapSize;
    if (used !== undefined) report.memory.sampledWindowJsHeapPeakBytes = Math.max(report.memory.sampledWindowJsHeapPeakBytes ?? 0, used);
  };
  timer = setInterval(sample, 100);
  try {
    status.textContent = 'Loading pinned tools and synthetic inputs…'; show();
    assert(crossOriginIsolated, 'This benchmark requires a cross-origin-isolated browser page.');
    const manifest = JSON.parse(new TextDecoder().decode(await bytesAt('manifest.json')));
    assert(manifest.construction === report.construction && manifest.pins.verifierTarget === report.verifierTarget, 'benchmark construction or verifier target mismatch');
    report.pins = manifest.pins; report.parameters = manifest.parameters; report.assets = manifest.assets;
    const [{ Noir }, { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend }, programBytes, vectorBytes] = await Promise.all([
      import('@noir-lang/noir_js'), import('@aztec/bb.js'),
      bytesAt('spend.json', manifest.assets['spend.json']), bytesAt('vectors.json', manifest.assets['vectors.json']),
    ]);
    const program = JSON.parse(new TextDecoder().decode(programBytes));
    const vectors = JSON.parse(new TextDecoder().decode(vectorBytes));
    assert(await sha(from64(program.bytecode)) === manifest.pins.circuits.spend.bytecode, 'circuit bytecode identity mismatch');
    report.stagesMs.toolsAndInputs = performance.now() - start;
    let before = performance.now();
    status.textContent = 'Initializing one WASM worker…';
    api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, skipSrsInit: true });
    report.stagesMs.worker = performance.now() - before;
    before = performance.now();
    status.textContent = 'Loading and checking the recorded parameters…';
    const [g1, g2, grumpkin] = await Promise.all(['bn254_g1.dat', 'bn254_g2.dat', 'grumpkin_g1_v2.flat.dat']
      .map(name => bytesAt(name, manifest.parameters[name])));
    report.stagesMs.parameterFetchAndHash = performance.now() - before;
    before = performance.now();
    await api.srsInitSrs({ pointsBuf: g1, numPoints: g1.length / 64, g2Point: g2 });
    await api.srsInitGrumpkinSrs({ pointsBuf: grumpkin, numPoints: grumpkin.length / 64 });
    report.stagesMs.parameterInit = performance.now() - before;
    const backend = new UltraHonkBackend(program.bytecode, api), noir = new Noir(program);
    const verifier = new UltraHonkVerifierBackend(api), options = { verifierTarget: 'noir-recursive' };
    before = performance.now();
    const vk = await backend.getVerificationKey(options);
    assert(await sha(vk) === manifest.pins.circuits.spend.vk, 'verification key identity mismatch');
    report.stagesMs.verificationKey = performance.now() - before;
    for (const vector of vectors) for (let iteration = 1; iteration <= 3; iteration++) {
      status.textContent = `${vector.label}: ${iteration}/3`;
      before = performance.now();
      const { witness } = await noir.execute(vector.input);
      const executionMs = performance.now() - before;
      before = performance.now();
      const proof = await backend.generateProof(witness, options);
      const proveMs = performance.now() - before;
      assert(proof.proof.length > 0 && proof.proof.length <= 131072 && proof.proof.length % 32 === 0, 'proof bounds');
      assert(JSON.stringify(proof.publicInputs.map(v => BigInt(v).toString())) === JSON.stringify(publicInputs(vector.input)), 'public inputs changed');
      before = performance.now();
      assert(await verifier.verifyProof({ ...proof, verificationKey: vk }, options), 'proof verification failed');
      report.metrics.push({ label: vector.label, iteration, executionMs, proveMs, verifyMs: performance.now() - before, proofBytes: proof.proof.length });
      sample(); show();
    }
    report.outcome = 'passed';
    status.textContent = 'Complete: all nine proofs verified against the pinned key.';
  } catch (error) {
    report.outcome = 'failed'; report.error = error instanceof Error ? error.message : String(error);
    status.textContent = `Failed: ${report.error}`;
  } finally {
    clearInterval(timer); sample(); document.removeEventListener('visibilitychange', visibility);
    if (api) { try { await api.destroy(); } catch (error) { report.cleanupError = String(error); } }
    report.totalMs = performance.now() - start;
    report.windowResourceDecodedBytes = performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.decodedBodySize, 0);
    report.resourceCaveat = 'Window resource entries only; excludes resources fetched inside workers. Not total network or process memory.';
    show(); run.disabled = false; download.disabled = false;
  }
};
