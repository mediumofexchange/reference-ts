// node compile.mjs <project dir>: compile with noir_wasm, write program.json, print bb's gate count.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
export const BUILD = path.resolve(import.meta.dirname, '../../../scratch/exhaustion-probe');
export const bb = path.resolve(import.meta.dirname, '../../../node_modules/@aztec/bb.js/build/amd64-linux/bb');
export async function compile(project) {
  const t0 = performance.now();
  const { program } = await compile_program(createFileManager(project), undefined, () => {}, () => {});
  writeFileSync(path.join(project, 'program.json'), JSON.stringify(program));
  const g = JSON.parse(execFileSync(bb, ['gates', '-b', path.join(project, 'program.json')], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  return { project: path.basename(project), compileS: +((performance.now() - t0) / 1000).toFixed(1), ...g.functions[0], program };
}
if (process.argv[1] === import.meta.filename) { const { program, ...r } = await compile(path.resolve(process.argv[2])); console.log(JSON.stringify(r)); }
