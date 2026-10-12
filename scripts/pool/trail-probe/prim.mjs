// Gates of one primitive circuit (nr/<name>.nr: SHA-256 compressions as words or bytes, Poseidon2 permutations).
// Usage: node prim.mjs <name> <main.nr file>; prints {name, gates, acir}
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
const root = path.resolve(import.meta.dirname, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const [name, file] = process.argv.slice(2);
const project = path.join(root, 'scratch/trail-probe/build', name);
mkdirSync(path.join(project, 'src'), { recursive: true });
writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
writeFileSync(path.join(project, 'src/main.nr'), readFileSync(file, 'utf8'));
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const gates = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' }));
console.log(JSON.stringify({ name, gates: gates.functions[0].circuit_size, acir: gates.functions[0].acir_opcodes }));
