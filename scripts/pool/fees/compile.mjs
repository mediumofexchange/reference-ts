// Compile the pinned spend and mechanically derived delivery/variable-output
// candidates. Generated programs stay in ignored scratch.
import path, { join, resolve } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';

if (!process.argv[2]) throw new Error('pass the scratch output directory');
const root = resolve(import.meta.dirname, '../../..');
const source = join(root, 'src/pool/circuits');
const scratch = resolve(process.argv[2]);
const output = join(scratch, 'build');
mkdirSync(output, { recursive: true });
const baseline = readFileSync(join(source, 'spend.nr'), 'utf8');

function once(text, needle, replacement, label) {
  if (text.split(needle).length !== 2) throw new Error(`pinned spend ${label} changed; review derivation`);
  return text.replace(needle, replacement);
}

function candidate(outputCount, withDelivery) {
  let result = baseline;
  const publicCount = 9 + outputCount + (withDelivery ? 2 : 0);
  result = once(result,
    '// pool-v2 §7.2: exactly eleven public fields, in this order.',
    `// F4 candidate derived from pool-v2 §7.2: exactly ${publicCount} public fields, in this order.`,
    'public-count comment');
  if (withDelivery) {
    result = once(result,
      '        anchors: pub [Field; 2], nullifiers: pub [Field; 2], outputs: pub [Field; 2],\n        inputs:',
      `        anchors: pub [Field; 2], nullifiers: pub [Field; 2], outputs: pub [Field; ${outputCount}],\n        delivery: pub [u128; 2],\n        inputs:`, 'public signature');
  } else if (outputCount !== 2) {
    result = once(result, 'outputs: pub [Field; 2]', `outputs: pub [Field; ${outputCount}]`, 'output signature');
  }
  if (outputCount !== 2) {
    result = once(result, 'output_notes: [notes::Note; 2])', `output_notes: [notes::Note; ${outputCount}])`, 'output witness');
  }
  if (withDelivery) {
    result = once(result, '    let _ = segment;\n', '    let _ = segment;\n    let _ = delivery;\n', 'delivery binding');
  }
  if (outputCount !== 2) {
    const oldCombined = `    for i in 0..2 {
        // Each input against its own anchor; padding proves ownership, its
        // nullifier and its scope membership, and nothing about the tree.
        notes::authenticate(domain, inputs[i], secrets[i], siblings[i], right[i], anchors[i], nullifiers[i]);
        notes::scoped(scope, inputs[i].backing, links[i], scope_siblings[i], scope_right[i]);
        assert((inputs[i].value > 0) | (inputs[i].backing == inputs[1 - i].backing));
        // An output names an input's backing, so its scope membership is the input's.
        assert((output_notes[i].backing == inputs[0].backing) | (output_notes[i].backing == inputs[1].backing));
        assert(outputs[i] == notes::commitment(domain, output_notes[i]));
    }
`;
    const separated = `    for i in 0..2 {
        // Each input against its own anchor; padding proves ownership, its
        // nullifier and its scope membership, and nothing about the tree.
        notes::authenticate(domain, inputs[i], secrets[i], siblings[i], right[i], anchors[i], nullifiers[i]);
        notes::scoped(scope, inputs[i].backing, links[i], scope_siblings[i], scope_right[i]);
        assert((inputs[i].value > 0) | (inputs[i].backing == inputs[1 - i].backing));
    }
    for i in 0..${outputCount} {
        // Every output is ordinary: it names an input backing and binds its commitment.
        assert((output_notes[i].backing == inputs[0].backing) | (output_notes[i].backing == inputs[1].backing));
        assert(outputs[i] == notes::commitment(domain, output_notes[i]));
    }
`;
    result = once(result, oldCombined, separated, 'combined input/output loop');
    const pairs = [];
    for (let i = 0; i < outputCount; i += 1) {
      for (let j = i + 1; j < outputCount; j += 1) pairs.push(`    assert(outputs[${i}] != outputs[${j}]);`);
    }
    result = once(result, '    assert(outputs[0] != outputs[1]);', pairs.join('\n'), 'output distinctness');
    const oldConservation = `        for j in 0..2 {
            incoming += if inputs[j].backing == backing { inputs[j].value as u128 } else { 0 };
            outgoing += if output_notes[j].backing == backing { output_notes[j].value as u128 } else { 0 };
        }
`;
    const separatedConservation = `        for j in 0..2 {
            incoming += if inputs[j].backing == backing { inputs[j].value as u128 } else { 0 };
        }
        for j in 0..${outputCount} {
            outgoing += if output_notes[j].backing == backing { output_notes[j].value as u128 } else { 0 };
        }
`;
    result = once(result, oldConservation, separatedConservation, 'conservation loops');
  }
  return result;
}

for (const key of ['join', 'resolve', 'normalize', 'dirname']) {
  const native = path[key];
  path[key] = (...args) => native(...args).replaceAll('\\', '/');
}

async function compile(name, main) {
  const project = path.join(output, name);
  mkdirSync(path.join(project, 'src'), { recursive: true });
  writeFileSync(path.join(project, 'Nargo.toml'), `[package]\nname = "moe_pool_fee_${name.replaceAll('-', '_')}"\ntype = "bin"\nauthors = []\n[dependencies]\n`);
  writeFileSync(path.join(project, 'src/main.nr'), main);
  copyFileSync(path.join(source, 'notes.nr'), path.join(project, 'src/notes.nr'));
  copyFileSync(path.join(source, 'vendor/poseidon2.nr'), path.join(project, 'src/poseidon2.nr'));
  const manager = createFileManager(project);
  const readDirectory = manager.readdir.bind(manager);
  manager.readdir = async (...args) => (await readDirectory(...args)).map(p => p.replaceAll('\\', '/'));
  const { program, warnings } = await compile_program(manager, undefined, () => {}, () => {});
  if (warnings.length) throw new Error('compiler warnings require review: ' + JSON.stringify(warnings));
  writeFileSync(path.join(output, `${name}.json`), JSON.stringify(program));
  writeFileSync(join(scratch, `generated-${name}.nr`), main);
  console.log(`Compiled ${name} with ${program.noir_version}`);
}

await compile('v2-2x2', baseline);
await compile('f3-2x2', candidate(2, true));
await compile('f4-2x3', candidate(3, true));
await compile('f4-2x4', candidate(4, true));
