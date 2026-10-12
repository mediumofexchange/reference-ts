// node compile.mjs <project dir>: compile with noir_wasm, write program.json, print bb's gate count.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
const root = path.resolve(import.meta.dirname, '../../..');
const bb = path.join(root, 'node_modules/@aztec/bb.js/build/amd64-linux/bb');
const project = path.resolve(process.argv[2]);
const t0 = performance.now();
const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
const g = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8' }));
console.log(JSON.stringify({ project: path.basename(project), compileS: +((performance.now() - t0) / 1000).toFixed(1), ...g.functions[0] }));
