// The checks' proving-parameter cache: the package's fetch-and-check
// (src/pool/parameter-files.ts) into scratch/private-payment-crs/. Run after
// `npm run build`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareParameters, readParameters } from '../../dist/pool/parameter-files.js';

export { readParameters };

/** The reference's parameter directory. */
export const PARAMETER_DIRECTORY = fileURLToPath(new URL('../../scratch/private-payment-crs/', import.meta.url));

export const prepareCrs = directory => prepareParameters(directory, { log: console.log });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareCrs(PARAMETER_DIRECTORY);
}
