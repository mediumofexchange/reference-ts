// Probe (slice 15 (ay)): Barretenberg's sync Poseidon2 against the JS host hash: equality, per-call cost, init, memory.
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const r0 = rss();
const { poseidon2Hash } = await import("../../dist/pool/poseidon2.js");
const { FIELD_MODULUS } = await import("../../dist/pool/field.js");
const r1 = rss();
let t = performance.now();
const { BarretenbergSync, BackendType } = await import("@aztec/bb.js");
const bb = await BarretenbergSync.new({ backend: BackendType.Wasm, threads: 1 });
const initMs = performance.now() - t, r2 = rss();
const be = v => { const out = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; };
const fromBe = b => b.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
const bbHash = inputs => fromBe(bb.poseidon2Hash({ inputs: inputs.map(be) }).hash);
const rnd = () => fromBe(randomBytes(32)) % FIELD_MODULUS;
let mismatches = 0;
for (let n = 1; n <= 8; n++) for (let k = 0; k < 200; k++) { const xs = Array.from({ length: n }, rnd); if (poseidon2Hash(xs) !== bbHash(xs)) mismatches++; }
const edge = [[0n], [FIELD_MODULUS - 1n], [0n, 0n, 0n], [0n, 0n, 0n, 0n], []];
for (const xs of edge) { try { if (poseidon2Hash(xs) !== bbHash(xs)) mismatches++; } catch (e) { console.log("edge", xs.length, String(e.message ?? e).slice(0, 80)); } }
const N = 2000, four = Array.from({ length: N }, () => [1n, 7n, rnd(), rnd()]);
t = performance.now(); for (const xs of four) poseidon2Hash(xs); const jsMs = (performance.now() - t) / N;
t = performance.now(); for (const xs of four) bbHash(xs); const bbMs = (performance.now() - t) / N;
console.log(JSON.stringify({ cpu: (await import("node:os")).cpus()[0].model, mismatches, jsMsPerHash: +jsMs.toFixed(4), bbMsPerHash: +bbMs.toFixed(4), initMs: Math.round(initMs), rssBase: r0, rssAfterDist: r1, rssAfterBb: r2, rssEnd: rss() }));
bb.destroy?.();
