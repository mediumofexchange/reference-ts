// What a compiled Noir program constrains, read from its own bytecode, and which
// constraint a refused witness fails. Test tooling for the circuit checks.
//
// noir_js encodes inputs through the ABI, which refuses an out-of-range integer
// or a non-boolean before the circuit runs; a prover building its own witness
// skips that encoder, so only the ACIR's constraints bind. `inputRanges` reads
// the bytecode and requires every integer or boolean input to carry a RANGE
// opcode of its declared width. `bypass` retypes the same program's ABI inputs
// as fields (the bytecode is unchanged), so a hostile witness reaches the
// constraints, and `refusal` names the one it fails: the input whose range
// check failed, or the source assertion at the failing opcode.
//
// `withoutInputRanges` is the mutation control: the same program with those
// input RANGE opcodes removed, under which a hostile witness that otherwise
// satisfies the relation solves. It is a test artifact, never proven with.
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { pack, unpack } from 'msgpackr';

/** The ABI inputs flattened in witness order: path, declared width (0 for a field) and visibility. */
export function inputsOf(abi) {
  const leaves = [];
  const walk = (path, type, visible) => {
    if (type.kind === 'array') for (let i = 0; i < type.length; i++) walk(`${path}[${i}]`, type.type, visible);
    else if (type.kind === 'struct') for (const field of type.fields) walk(`${path}.${field.name}`, field.type, visible);
    else if (type.kind === 'integer') { assert.equal(type.sign, 'unsigned'); leaves.push({ path, bits: type.width, visible }); }
    else if (type.kind === 'boolean') leaves.push({ path, bits: 1, visible });
    else { assert.equal(type.kind, 'field', path); leaves.push({ path, bits: 0, visible }); }
  };
  for (const parameter of abi.parameters) walk(parameter.name, parameter.type, parameter.visibility === 'public');
  return leaves;
}

const FORMAT = 3; // the ACIR serialization's leading byte: msgpack

function unpacked(program) {
  const raw = gunzipSync(Buffer.from(program.bytecode, 'base64'));
  assert.equal(raw[0], FORMAT, 'ACIR serialization format (msgpack)');
  const decoded = unpack(raw.subarray(1));
  assert.equal(decoded[0].length, 1, 'one ACIR function');
  return decoded;
}

// Decoded once per bytecode: `refusal` reads the same program for every hostile witness.
const cache = new Map();
function decode(program) {
  let found = cache.get(program.bytecode);
  if (found === undefined) {
    const [, opcodes, privateParameters, publicParameters] = unpacked(program)[0][0];
    const debug = JSON.parse(inflateRawSync(Buffer.from(program.debug_symbols, 'base64')).toString('utf8')).debug_infos;
    found = { opcodes, privateParameters, publicParameters, debug };
    cache.set(program.bytecode, found);
  }
  return found;
}

function rangeOf(opcode) {
  const range = opcode?.BlackBoxFuncCall?.RANGE;
  if (range === undefined) return undefined;
  const [input, bits] = range;
  return typeof input?.Witness === 'number' ? { witness: input.Witness, bits } : undefined;
}

/**
 * Require the ABI inputs to be witnesses 0..n−1 in flattened order, the public ones
 * exactly the `pub` parameters', and every integer or boolean input to carry a RANGE
 * opcode of its width. Returns how many inputs are range-checked.
 */
export function inputRanges(program) {
  const leaves = inputsOf(program.abi), { opcodes, privateParameters, publicParameters } = decode(program);
  const witnesses = visible => leaves.flatMap((leaf, witness) => leaf.visible === visible ? [witness] : []);
  const sorted = list => [...list].sort((a, b) => a - b);
  assert.deepEqual(sorted(publicParameters), witnesses(true), 'public inputs are their ABI witnesses');
  assert.deepEqual(sorted(privateParameters), witnesses(false), 'private inputs are their ABI witnesses');
  const ranged = new Map();
  for (const opcode of opcodes) {
    const range = rangeOf(opcode);
    if (range !== undefined && range.witness < leaves.length) {
      ranged.set(range.witness, Math.min(range.bits, ranged.get(range.witness) ?? Infinity));
    }
  }
  let count = 0;
  leaves.forEach((leaf, witness) => {
    if (leaf.bits === 0) return;
    assert.equal(ranged.get(witness), leaf.bits, `${leaf.path} is range-checked to ${leaf.bits} bits in ACIR`);
    count++;
  });
  return count;
}

/** The same bytecode with every integer and boolean input typed as a field, so the ABI encoder passes any value. */
export function bypass(program) {
  const widen = type => type.kind === 'array' ? { ...type, type: widen(type.type) }
    : type.kind === 'struct' ? { ...type, fields: type.fields.map(f => ({ ...f, type: widen(f.type) })) }
      : type.kind === 'integer' || type.kind === 'boolean' ? { kind: 'field' } : type;
  const copy = structuredClone(program);
  copy.abi.parameters = copy.abi.parameters.map(p => ({ ...p, type: widen(p.type) }));
  assert.equal(copy.bytecode, program.bytecode);
  return copy;
}

/** `bypass`'s program with every RANGE opcode on an ABI input removed. */
export function withoutInputRanges(program) {
  const inputs = inputsOf(program.abi).length, decoded = unpacked(program), fn = decoded[0][0];
  const before = fn[1].length;
  fn[1] = fn[1].filter(opcode => !(rangeOf(opcode)?.witness < inputs));
  assert(fn[1].length < before, 'input RANGE opcodes removed');
  return { ...bypass(program), bytecode: gzipSync(Buffer.concat([Buffer.from([FORMAT]), pack(decoded)])).toString('base64') };
}

/** A witness for `bypass`'s ABI: booleans as 0 and 1. */
export function asFields(input) {
  if (typeof input === 'boolean') return input ? '1' : '0';
  if (Array.isArray(input)) return input.map(asFields);
  if (typeof input === 'object' && input !== null) return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, asFields(v)]));
  return input;
}

/**
 * The constraint an execution error names: `range <input path>` for an input's RANGE
 * opcode, otherwise `<file> <source text>` of the innermost location of the failing
 * opcode. Spans are byte offsets into the UTF-8 source. Anything but a failed
 * constraint (an ABI error, an oracle) is rethrown.
 */
export function refusal(program, error) {
  const cause = error?.cause ?? error;
  const stack = cause?.callStack;
  if (!Array.isArray(stack) || !/Cannot satisfy constraint/.test(String(cause?.message ?? cause))) throw error;
  assert.equal(stack.length, 1, 'an ACIR opcode location');
  const at = stack[0];
  assert.match(at, /^\d+$/, 'an ACIR opcode, not Brillig');
  const { opcodes, debug: infos } = decode(program);
  const range = rangeOf(opcodes[Number(at)]);
  const leaves = inputsOf(program.abi);
  if (range !== undefined && range.witness < leaves.length) return `range ${leaves[range.witness].path}`;
  const debug = infos[cause.acirFunctionId ?? 0];
  const id = debug.acir_locations[at];
  assert.notEqual(id, undefined, `opcode ${at} has a source location`);
  const node = debug.location_tree.locations[id];
  assert.notEqual(node.parent, null, `opcode ${at} has a source location`);
  const { file, span } = node.value, { path, source } = program.file_map[file];
  const text = Buffer.from(source, 'utf8').subarray(span.start, span.end).toString('utf8').replace(/\s+/g, ' ');
  return `${path.split(/[\\/]/).pop()} ${text}`;
}
