// Slice 18 diagnostic, disposable: does the host hash (Barretenberg's WebAssembly poseidon2Hash, slice 15) hold memory
// per call? Hashes N four-element inputs on the run's build and prints the process's memory every N/10 calls.
// Usage: node hash-memory.mjs [N=1000000]
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WT = join(dirname(fileURLToPath(import.meta.url)), "..", "wt", "dp6");
const { poseidon2Hash } = await import(pathToFileURL(join(WT, "dist", "pool", "poseidon2.js")).href);
const n = Number(process.argv[2] ?? 1_000_000), mb = v => Math.round(v / 1048576);
const show = i => { const m = process.memoryUsage(); console.log(JSON.stringify({ calls: i, rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external), arrayBuffersMb: mb(m.arrayBuffers) })); };
show(0);
let x = 1n;
for (let i = 1; i <= n; i++) {
  x = poseidon2Hash([7n, BigInt(i), x, 3n]);
  if (i % (n / 10) === 0) show(i);
}
