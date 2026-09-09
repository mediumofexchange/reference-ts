// Compile the six successor-candidate relations in one evidence build.
// Run in its own process because Noir uses POSIX source identifiers.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';

if (!process.argv[2]) throw new Error('Pass an output directory');
const source = fileURLToPath(new URL('./circuits/', import.meta.url));
const output = path.resolve(process.argv[2]);
const helper = fileURLToPath(new URL('../../../src/pool/circuits/vendor/poseidon2.nr', import.meta.url));
const kinds = ['issue', 'spend', 'burn', 'demand', 'settle', 'request'];
mkdirSync(output, { recursive: true });

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const sourceHashes = {};
for (const name of [...kinds, 'notes', 'poseidon2']) {
  const bytes = readFileSync(name === 'poseidon2' ? helper : path.join(source, `${name}.nr`));
  sourceHashes[name] = sha256(bytes);
}
writeFileSync(path.join(output, 'source-hashes.json'), `${JSON.stringify(sourceHashes, null, 2)}\n`);

// Generalized Windows shim used by the existing candidate compiler: every
// path operation and directory entry visible to Noir uses forward slashes.
for (const key of ['join', 'resolve', 'normalize', 'dirname']) {
  const native = path[key];
  path[key] = (...args) => native(...args).replaceAll('\\', '/');
}

for (const kind of kinds) {
  const project = path.join(output, 'projects', kind);
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "moe_pool_successor_candidate_${kind}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  copyFileSync(path.join(source, `${kind}.nr`), path.join(project, 'src/main.nr'));
  copyFileSync(path.join(source, 'notes.nr'), path.join(project, 'src/notes.nr'));
  copyFileSync(helper, path.join(project, 'src/poseidon2.nr'));

  const manager = createFileManager(project);
  const readDirectory = manager.readdir.bind(manager);
  manager.readdir = async (...args) => (await readDirectory(...args)).map(entry => entry.replaceAll('\\', '/'));
  const { program, warnings } = await compile_program(manager, undefined, () => {}, () => {});
  if (warnings.length) {
    throw new Error(`${kind} compiler warnings require review: ${JSON.stringify(warnings)}`);
  }
  writeFileSync(path.join(output, `${kind}.json`), JSON.stringify(program));
  console.log(`Compiled ${kind} with ${program.noir_version}`);
}
