// Fixed controls only. The external node-controls.ps1 supervisor must run this.
import { Worker } from 'node:worker_threads';
const mode = process.argv[2];
if (mode === 'cpu-rate') {
  // Saturate more than the one-core-equivalent allowance on this four-core host.
  for (let i = 0; i < 4; i++) new Worker('while (true) {}', { eval: true });
} else {
  await import('./contained-worker.mjs');
}
