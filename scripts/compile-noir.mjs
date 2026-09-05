// Run only in an isolated compiler process: Noir uses POSIX source identifiers.
import path from 'node:path';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';

export async function compileCircuits({ source, helper, output, name }) {
  for (const key of ['join', 'resolve', 'normalize', 'dirname']) {
    const native = path[key];
    path[key] = (...args) => native(...args).replaceAll('\\', '/');
  }
  for (const kind of ['issue', 'spend', 'burn']) {
    const project = path.join(output, kind);
    mkdirSync(path.join(project, 'src'), { recursive: true });
    writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "${name(kind)}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
    copyFileSync(path.join(source, kind + '.nr'), path.join(project, 'src/main.nr'));
    copyFileSync(path.join(source, 'notes.nr'), path.join(project, 'src/notes.nr'));
    copyFileSync(helper, path.join(project, 'src/poseidon2.nr'));
    const fm = createFileManager(project);
    const readDirectory = fm.readdir.bind(fm);
    fm.readdir = async (...args) => (await readDirectory(...args)).map(p => p.replaceAll('\\', '/'));
    const { program, warnings } = await compile_program(fm, undefined, () => {}, () => {});
    if (warnings.length) throw new Error('compiler warnings require review: ' + JSON.stringify(warnings));
    writeFileSync(path.join(output, kind + '.json'), JSON.stringify(program));
    console.log('Compiled ' + kind + ' with ' + program.noir_version);
  }
}
