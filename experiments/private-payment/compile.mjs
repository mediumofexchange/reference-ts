// The shared compiler runs only in this isolated child process.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCircuits } from '../../scripts/compile-noir.mjs';

if (!process.argv[2]) throw new Error('Pass a scratch output directory');
const root = fileURLToPath(new URL('.', import.meta.url));
await compileCircuits({ source: resolve(root, 'circuits'), helper: resolve(root, 'vendor/poseidon2.nr'),
  output: resolve(process.argv[2]), name: kind => `moe_${kind}_research` });
