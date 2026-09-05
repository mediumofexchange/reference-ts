// Research admission and independent public-history replay. No note openings.
import assert from 'node:assert/strict';
import { ByteWriter } from '../../dist/bytes.js';
import { verifySignatureStrict } from '../../dist/keys.js';
import { decodeBacking, verifyBackingSignature } from '../../dist/backing.js';
import { field, parseField, NoteTree, sha, canonical, PROFILE } from './proofs.mjs';

const U128 = 1n << 128n, U64 = 1n << 64n;
const raw = hex => Buffer.from(hex.replace(/^0x/, ''), 'hex');
export function configIdentity(config) {
  // Fixed framed bytes, including trusted compiler/VK identities and obligors.
  const w = new ByteWriter(); w.context(new TextEncoder().encode(PROFILE + '/config'));
  for (const limb of config.pool) w.key32(raw(field(limb)), 'pool limb');
  for (const kind of ['issue', 'spend', 'burn']) {
    w.key32(raw(config.circuits[kind].bytecode), 'circuit');
    w.key32(raw(config.circuits[kind].verificationKey), 'verification key');
  }
  const assets = Object.keys(config.assets).sort(); w.u32(assets.length);
  for (const asset of assets) {
    w.key32(raw(asset), 'asset'); w.lengthPrefixed(raw(config.assets[asset].terms));
    w.fixed(raw(config.assets[asset].signature), 64, 'backing signature');
  }
  return { profile: PROFILE, configHash: sha(w.finish()) };
}
export function statementBytes(config, command) {
  const w = new ByteWriter(); w.context(new TextEncoder().encode(PROFILE + '/statement'));
  w.key32(raw(configIdentity(config).configHash), 'configuration');
  w.u8({ issue: 1, spend: 2, burn: 3 }[command.kind]);
  w.u32(command.publicInputs.length);
  for (const value of command.publicInputs) w.key32(raw(parseField(value)), 'public input');
  return w.finish();
}
function assetOf(a, b) {
  for (const limb of [a, b]) if (BigInt(limb) >= U128) throw new Error('asset limb exceeds u128');
  return BigInt(a).toString(16).padStart(32, '0') + BigInt(b).toString(16).padStart(32, '0');
}
export function parseStatement(config, command) {
  if (!command || Object.keys(command).sort().join(',') !==
      (command.kind === 'issue' ? 'issuerSignature,kind,proof,publicInputs' : 'kind,proof,publicInputs')) throw new Error('unknown envelope fields');
  const p = command.publicInputs;
  if (!Array.isArray(p) || p.length !== { issue: 6, spend: 6, burn: 8 }[command.kind]) throw new Error('public input shape');
  p.forEach(parseField);
  if (p[0] !== field(config.pool[0]) || p[1] !== field(config.pool[1])) throw new Error('wrong pool');
  if (BigInt(p[0]) >= U128 || BigInt(p[1]) >= U128) throw new Error('pool limb exceeds u128');
  if (command.kind === 'spend') return { anchor: p[2], nf: p[3], outputs: p.slice(4) };
  const asset = assetOf(p[2], p[3]), quantity = BigInt(p[4]);
  if (quantity <= 0n || quantity >= U64 || !Object.hasOwn(config.assets, asset)) throw new Error('invalid boundary asset/quantity');
  const bundle = config.assets[asset], backing = decodeBacking(raw(bundle.terms));
  if (backing.nameHex !== asset || !verifyBackingSignature(backing, raw(bundle.signature))) throw new Error('invalid backing identity');
  if (command.kind === 'issue') {
    if (typeof command.issuerSignature !== 'string' || !/^[0-9a-f]{128}$/.test(command.issuerSignature) ||
        !verifySignatureStrict(raw(command.issuerSignature), statementBytes(config, command), backing.obligor)) throw new Error('unauthorized issuance');
    return { asset, quantity, outputs: [p[5]] };
  }
  return { asset, quantity: -quantity, anchor: p[5], nf: p[6], outputs: [p[7]] };
}

export class PublicHistory {
  static async create(system, config) {
    assert.deepEqual(config.circuits, system.pins, 'configuration must pin locally compiled verification keys');
    const h = new PublicHistory(system, JSON.parse(canonical(config)));
    const seed = new ByteWriter(); seed.context(new TextEncoder().encode(PROFILE + '/history/genesis'));
    seed.key32(raw(configIdentity(h.config).configHash), 'configuration');
    h.historyHash = sha(seed.finish());
    h.tree = await NoteTree.create(system); h.anchors.add(h.tree.root()); return h;
  }
  constructor(system, config) { this.system = system; this.config = config; this.anchors = new Set(); this.spent = new Set(); this.supply = new Map(); this.count = 0n; }
  async apply(command, proofAlreadyVerified = false) {
    const s = parseStatement(this.config, command);
    if (!proofAlreadyVerified && !await this.system.verify(command)) throw new Error('proof refused');
    if (s.nf !== undefined && (!this.anchors.has(s.anchor) || BigInt(s.nf) === 0n || this.spent.has(s.nf))) throw new Error('unknown anchor or spent nullifier');
    if (new Set(s.outputs).size !== s.outputs.length || s.outputs.some(cm => BigInt(cm) === 0n || this.tree.leaves.includes(cm)) ||
        this.tree.leaves.length + s.outputs.length > 256) throw new Error('duplicate output or capacity');
    const total = s.asset === undefined ? undefined : (this.supply.get(s.asset) ?? 0n) + s.quantity;
    if (total !== undefined && total < 0n) throw new Error('negative outstanding');
    for (const cm of s.outputs) await this.tree.append(cm);
    if (s.nf !== undefined) this.spent.add(s.nf);
    if (s.asset !== undefined) this.supply.set(s.asset, total);
    this.anchors.add(this.tree.root()); this.count++;
    const statement = sha(statementBytes(this.config, command));
    const chain = new ByteWriter(); chain.context(new TextEncoder().encode(PROFILE + '/history'));
    chain.key32(raw(this.historyHash), 'previous history'); chain.key32(raw(statement), 'statement');
    chain.key32(raw(this.tree.root()), 'note root'); chain.u64(this.count);
    this.historyHash = sha(chain.finish());
    return { sequence: this.count.toString(), statement, root: this.tree.root(), historyHash: this.historyHash };
  }
}
export async function replay(system, config, events) {
  const history = await PublicHistory.create(system, config);
  for (const event of events) {
    const receipt = await history.apply(event.command);
    assert.deepEqual(receipt, event.response, 'stored response differs from independently verified history');
  }
  return history;
}

/** Async proofs run outside the transaction. CAS retries always rebuild state;
 * the SQLite journal rechecks the sequence under its exclusive writer lock. */
export async function submit(journal, system, config, id, externalCommand) {
  const command = JSON.parse(canonical(externalCommand));
  parseStatement(config, command);
  if (!await system.verify(command)) throw new Error('proof refused');
  for (let attempts = 0; attempts < 8; attempts++) {
    const snapshot = journal.snapshot();
    const state = await replay(system, config, snapshot.events);
    const existing = snapshot.events.find(e => e.id === id);
    if (existing) {
      if (canonical(existing.command) !== canonical(command)) throw new Error('command identifier conflict');
      return existing.response;
    }
    const response = await state.apply(command, true);
    if (journal.append(snapshot.sequence, id, command, response)) return response;
  }
  throw new Error('writer contention; retry the saved command');
}

/** Receiver checks its own requested opening; acceptance is persisted before
 * delivery by the receiving application's accept-once record. */
export async function checkReceived(system, config, events, expectedNote, secret) {
  assert.equal(await system.owner(secret), expectedNote.owner, 'receiver does not control requested note');
  const cm = await system.commitment(config.pool, expectedNote);
  const history = await replay(system, config, events);
  if (!history.tree.leaves.includes(cm) || BigInt(expectedNote.value) <= 0n) throw new Error('expected payment is absent');
  const nf = await system.nullifier(config.pool, cm, secret);
  if (history.spent.has(nf)) throw new Error('received note has already been spent');
  return { commitment: cm, root: history.tree.root(), events: events.length };
}
