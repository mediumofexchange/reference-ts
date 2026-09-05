import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { compileCircuits } from '../compile-noir.mjs';

if (!process.argv[2]) throw new Error('Pass a scratch output directory');
const source = fileURLToPath(new URL('../../src/pool/circuits/', import.meta.url));
await compileCircuits({ source, helper: resolve(source, 'vendor/poseidon2.nr'),
  output: resolve(process.argv[2]), name: kind => `moe_pool_v1_${kind}` });
