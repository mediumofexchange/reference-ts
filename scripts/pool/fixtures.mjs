// Test-only witnesses and host hashing; no admission or wallet API lives here.
// Every hash below is the backend's own Poseidon2, so a fixture that proves
// binds the circuits to the backend's sponge independently of `poseidon2.ts`.
import assert from 'node:assert/strict';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const U64_MAX = (1n << 64n) - 1n;
export function field(value) {
  const n = BigInt(value);
  assert(n >= 0n && n < FIELD);
  return '0x' + n.toString(16).padStart(64, '0');
}

export async function fixtures(api) {
  const domain = ['17', '29'], segment = ['19', '23'];
  // Two scoped backings with their links, sorted as a scope is (pool-v2 §5), and one outside the scope.
  const a = ['31', '43'], b = ['47', '59'], foreign = ['61', '71'];
  const linkA = ['101', '103'], linkB = ['107', '109'];
  const hash = async values => {
    const { hash } = await api.poseidon2Hash({ inputs: values.map(v => Buffer.from(field(v).slice(2), 'hex')) });
    return field('0x' + Buffer.from(hash).toString('hex'));
  };
  const cm = (note, identity = domain) => hash([1002, ...identity, ...note.backing, note.value, note.owner, note.rho]);
  const nf = async (note, secret, identity = domain) => hash([1003, ...identity, await cm(note, identity), secret]);
  let nonce = 100n;
  async function note(backing, value) {
    const secret = field(++nonce), rho = field(++nonce);
    const opening = { backing: [...backing], value: String(value), owner: await hash([1001, secret]), rho };
    return { opening, secret };
  }
  // Sparse Merkle fixtures over the backend's hash: the note tree (depth 32,
  // tag 1004) and the scope tree (depth 16, tag 1006), positions as bigints
  // so that positions above 2^31 survive JS bitwise truncation.
  async function merkle(depth, tag, entries) {
    const zeros = [field(0)];
    for (let h = 0n; h < BigInt(depth); h++) zeros.push(await hash([tag, h, zeros[Number(h)], zeros[Number(h)]]));
    const nodes = new Map();
    const at = (h, i) => nodes.get(`${h}:${i}`) ?? zeros[Number(h)];
    for (const [position, leaf] of entries) {
      assert(position >= 0n && position < (1n << BigInt(depth)));
      let index = position;
      nodes.set(`0:${index}`, leaf);
      for (let h = 0n; h < BigInt(depth); h++) {
        const left = index & ~1n;
        const parent = await hash([tag, h, at(h, left), at(h, left + 1n)]);
        index >>= 1n;
        nodes.set(`${h + 1n}:${index}`, parent);
      }
    }
    return { root: at(BigInt(depth), 0n), path(position) {
      const siblings = [], right = [];
      for (let h = 0n; h < BigInt(depth); h++) {
        siblings.push(at(h, position ^ 1n)); right.push((position & 1n) === 1n); position >>= 1n;
      }
      return { siblings, right };
    } };
  }
  const tree = entries => merkle(32, 1004, entries);
  const scopeLeaf = (backing, link) => hash([1005, ...backing, ...link]);
  const scope = await merkle(16, 1006, [[0n, await scopeLeaf(a, linkA)], [1n, await scopeLeaf(b, linkB)]]);
  const scopeOf = backing => {
    const index = backing.join() === a.join() ? 0n : backing.join() === b.join() ? 1n : undefined;
    if (index === undefined) return { link: [...linkA], path: scope.path(0n) }; // a foreign backing borrows a's path: the circuit must refuse
    return { link: index === 0n ? [...linkA] : [...linkB], path: scope.path(index) };
  };
  /** A spend of `first` and `second` (each at its own position, optionally in its own tree) to `out1`, `out2`. */
  async function spend(first, second, out1, out2, positions = [0n, 1n], separateTrees = false) {
    const inputs = [first, second];
    const leaves = await Promise.all(inputs.flatMap((n, i) => BigInt(n.opening.value) > 0n
      ? [cm(n.opening).then(commitment => [positions[i], commitment])] : []));
    let anchors, paths;
    if (separateTrees) {
      const trees = await Promise.all(leaves.map(entry => tree([entry])));
      anchors = trees.map(t => t.root); paths = trees.map((t, i) => t.path(positions[i]));
    } else {
      const t = await tree(leaves);
      anchors = [t.root, t.root]; paths = positions.map(p => t.path(p));
    }
    const scopes = inputs.map(n => scopeOf(n.opening.backing));
    return { domain: [...domain], segment: [...segment], scope: scope.root, anchors,
      nullifiers: await Promise.all(inputs.map(n => nf(n.opening, n.secret))),
      outputs: await Promise.all([cm(out1.opening), cm(out2.opening)]),
      inputs: inputs.map(n => n.opening), secrets: inputs.map(n => n.secret),
      siblings: paths.map(p => p.siblings), right: paths.map(p => p.right),
      links: scopes.map(s => s.link), scope_siblings: scopes.map(s => s.path.siblings), scope_right: scopes.map(s => s.path.right),
      output_notes: [out1.opening, out2.opening] };
  }
  async function refresh(v) {
    v.nullifiers = await Promise.all(v.inputs.map((n, i) => nf(n, v.secrets[i], v.domain)));
    if (v.output_notes) v.outputs = await Promise.all(v.output_notes.map(n => cm(n, v.domain)));
    if (v.change) v.cm_change = await cm(v.change, v.domain);
    return v;
  }
  const first = await note(a, 100n), second = await note(a, 80n), other = await note(b, 80n);
  const padding = await note(a, 0n), out40 = await note(a, 40n), out60 = await note(a, 60n);
  const padded = await spend(first, padding, out40, out60);
  const same = await spend(first, second, await note(a, 110n), await note(a, 70n));
  const cross = await spend(first, other, await note(b, 80n), await note(a, 100n));
  const twoAnchors = await spend(first, other, await note(b, 80n), await note(a, 100n), [0n, 0n], true);
  const change = await note(a, 30n);
  const burn = { domain: [...domain], segment: [...segment], scope: scope.root, backing: [...a], quantity: '70',
    anchors: [...padded.anchors], nullifiers: padded.nullifiers, cm_change: await cm(change.opening),
    inputs: padded.inputs, secrets: padded.secrets, siblings: padded.siblings, right: padded.right, change: change.opening,
    link: [...linkA], scope_siblings: scope.path(0n).siblings, scope_right: scope.path(0n).right };
  const issue = { domain: [...domain], segment: [...segment], scope: scope.root, backing: [...a], quantity: first.opening.value,
    cm: await cm(first.opening), owner: first.opening.owner, rho: first.opening.rho,
    link: [...linkA], scope_siblings: scope.path(0n).siblings, scope_right: scope.path(0n).right };
  return { domain, segment, a, b, foreign, linkA, linkB, scope, hash, cm, nf, note, tree, spend, refresh,
    first, padding, padded, same, cross, twoAnchors, burn, issue };
}
