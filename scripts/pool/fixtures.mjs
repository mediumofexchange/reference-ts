// Test-only witnesses and host hashing; no admission or wallet API lives here.
import assert from 'node:assert/strict';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const U64_MAX = (1n << 64n) - 1n;
export function field(value) {
  const n = BigInt(value);
  assert(n >= 0n && n < FIELD);
  return '0x' + n.toString(16).padStart(64, '0');
}

export async function fixtures(api) {
  const pool = ['17', '29'], a = ['31', '43'], b = ['47', '59'], foreign = ['61', '71'];
  const hash = async values => {
    const { hash } = await api.poseidon2Hash({ inputs: values.map(v => Buffer.from(field(v).slice(2), 'hex')) });
    return field('0x' + Buffer.from(hash).toString('hex'));
  };
  const cm = (note, identity = pool) => hash([1002, ...identity, ...note.backing, note.value, note.owner, note.rho]);
  const nf = async (note, secret, identity = pool) => hash([1003, ...identity, await cm(note, identity), secret]);
  let nonce = 100n;
  async function note(backing, value) {
    const secret = field(++nonce), rho = field(++nonce);
    const opening = { backing: [...backing], value: String(value), owner: await hash([1001, secret]), rho };
    return { opening, secret };
  }
  const zeros = [field(0)];
  for (let h = 0n; h < 32n; h++) zeros.push(await hash([1004, h, zeros[Number(h)], zeros[Number(h)]]));
  // Sparse fixture supports positions above 2^31 without JS bitwise truncation.
  async function tree(entries) {
    const nodes = new Map();
    const at = (h, i) => nodes.get(`${h}:${i}`) ?? zeros[Number(h)];
    for (const [position, leaf] of entries) {
      assert(position >= 0n && position < (1n << 32n));
      let index = position;
      nodes.set(`0:${index}`, leaf);
      for (let h = 0n; h < 32n; h++) {
        const left = index & ~1n;
        const parent = await hash([1004, h, at(h, left), at(h, left + 1n)]);
        index >>= 1n;
        nodes.set(`${h + 1n}:${index}`, parent);
      }
    }
    return { root: at(32n, 0n), path(position) {
      const siblings = [], right = [];
      for (let h = 0n; h < 32n; h++) {
        siblings.push(at(h, position ^ 1n)); right.push((position & 1n) === 1n); position >>= 1n;
      }
      return { siblings, right };
    } };
  }
  async function spend(first, second, out1, out2, positions = [0n, 1n]) {
    const inputs = [first, second];
    const leaves = await Promise.all(inputs.flatMap((n, i) => BigInt(n.opening.value) > 0n
      ? [cm(n.opening).then(commitment => [positions[i], commitment])] : []));
    const t = await tree(leaves), paths = positions.map(p => t.path(p));
    return { pool: [...pool], anchor: t.root,
      nullifiers: await Promise.all(inputs.map(n => nf(n.opening, n.secret))),
      outputs: await Promise.all([cm(out1.opening), cm(out2.opening)]),
      inputs: inputs.map(n => n.opening), secrets: inputs.map(n => n.secret),
      siblings: paths.map(p => p.siblings), right: paths.map(p => p.right),
      output_notes: [out1.opening, out2.opening] };
  }
  async function refresh(v) {
    v.nullifiers = await Promise.all(v.inputs.map((n, i) => nf(n, v.secrets[i], v.pool)));
    if (v.output_notes) v.outputs = await Promise.all(v.output_notes.map(n => cm(n, v.pool)));
    if (v.change) v.cm_change = await cm(v.change, v.pool);
    return v;
  }
  const first = await note(a, 100n), second = await note(a, 80n), other = await note(b, 80n);
  const padding = await note(a, 0n), out40 = await note(a, 40n), out60 = await note(a, 60n);
  const padded = await spend(first, padding, out40, out60);
  const same = await spend(first, second, await note(a, 110n), await note(a, 70n));
  const cross = await spend(first, other, await note(b, 80n), await note(a, 100n));
  const change = await note(a, 30n);
  const burn = { pool: [...pool], backing: [...a], quantity: '70', anchor: padded.anchor,
    nullifiers: padded.nullifiers, cm_change: await cm(change.opening),
    inputs: padded.inputs, secrets: padded.secrets, siblings: padded.siblings, right: padded.right, change: change.opening };
  const issue = { pool: [...pool], backing: [...a], quantity: first.opening.value,
    cm: await cm(first.opening), owner: first.opening.owner, rho: first.opening.rho };
  return { pool, a, b, foreign, hash, cm, nf, note, tree, spend, refresh, first, padding, padded, same, cross, burn, issue };
}
