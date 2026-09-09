// Compile the pinned spend and a mechanically derived delivery-binding
// candidate in an isolated process: Noir source identifiers must use POSIX
// paths on Windows. Generated sources and programs stay in ignored scratch.
import path, { join, resolve } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';

if (!process.argv[2]) throw new Error('pass the scratch output directory');
const root = resolve(import.meta.dirname, '../../../..');
const source = join(root, 'src/pool/circuits');
const output = resolve(process.argv[2]);
const baseline = readFileSync(join(source, 'spend.nr'), 'utf8');
const needle = '        anchors: pub [Field; 2], nullifiers: pub [Field; 2], outputs: pub [Field; 2],\n        inputs:';
const replacement = '        anchors: pub [Field; 2], nullifiers: pub [Field; 2], outputs: pub [Field; 2],\n        delivery: pub [u128; 2],\n        inputs:';
if (baseline.split(needle).length !== 2) throw new Error('pinned spend signature changed; review candidate derivation');
const candidate = baseline.replace(needle, replacement);
writeFileSync(join(output, 'generated-spend.nr'), candidate);

for (const key of ['join', 'resolve', 'normalize', 'dirname']) {
  const native = path[key];
  path[key] = (...args) => native(...args).replaceAll('\\', '/');
}
async function compile(name, main) {
  const project = path.join(output, 'build', name);
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "moe_pool_delivery_${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(project, 'src/main.nr'), main);
  copyFileSync(path.join(source, 'notes.nr'), path.join(project, 'src/notes.nr'));
  copyFileSync(path.join(source, 'vendor/poseidon2.nr'), path.join(project, 'src/poseidon2.nr'));
  const manager = createFileManager(project);
  const readDirectory = manager.readdir.bind(manager);
  manager.readdir = async (...args) => (await readDirectory(...args)).map(p => p.replaceAll('\\', '/'));
  const { program, warnings } = await compile_program(manager, undefined, () => {}, () => {});
  if (warnings.length) throw new Error('compiler warnings require review: ' + JSON.stringify(warnings));
  writeFileSync(path.join(output, 'build', name + '.json'), JSON.stringify(program));
  console.log(`Compiled ${name} with ${program.noir_version}`);
}
await compile('baseline', baseline);
await compile('candidate', candidate);
