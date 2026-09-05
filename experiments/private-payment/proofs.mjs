import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, BackendType, UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec/bb.js';

export const PROFILE = 'moe-private-payment-research/v1';
export const OPTIONS = Object.freeze({ verifierTarget: 'noir-recursive' }); // ZK enabled
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(value);
export function field(value) {
  const n = BigInt(value);
  if (n < 0n || n >= FIELD) throw new Error('noncanonical field');
  return '0x' + n.toString(16).padStart(64, '0');
}
export function randomField() {
  for (;;) { const n = BigInt('0x' + randomBytes(32).toString('hex')); if (n > 0n && n < FIELD) return field(n); }
}
export function limbs(hex) {
  assert.match(hex, /^[0-9a-f]{64}$/);
  return [BigInt('0x' + hex.slice(0, 32)).toString(), BigInt('0x' + hex.slice(32)).toString()];
}
export function parseField(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value) || field(value) !== value) throw new Error('invalid field encoding');
  return value;
}
export class ProofSystem {
  static async open(artifacts, crsPath) {
    const start = performance.now();
    const api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1, crsPath });
    const system = new ProofSystem(api);
    try {
      for (const kind of ['issue', 'spend', 'burn']) {
        const program = JSON.parse(readFileSync(join(artifacts, kind + '.json'), 'utf8'));
        const backend = new UltraHonkBackend(program.bytecode, api);
        const vk = await backend.getVerificationKey(OPTIONS);
        system.circuits.set(kind, { program, noir: new Noir(program), backend, vk });
        system.pins[kind] = { bytecode: sha(Buffer.from(program.bytecode, 'base64')), verificationKey: sha(vk) };
      }
      system.setupMs = performance.now() - start;
      return system;
    } catch (error) { await api.destroy(); throw error; }
  }
  constructor(api) { this.api = api; this.circuits = new Map(); this.pins = {}; this.metrics = []; this.verifier = new UltraHonkVerifierBackend(api); }
  async hash(values) {
    const { hash } = await this.api.poseidon2Hash({ inputs: values.map(v => Buffer.from(field(v).slice(2), 'hex')) });
    return field('0x' + Buffer.from(hash).toString('hex'));
  }
  async owner(secret) { assert.notEqual(BigInt(secret), 0n); return this.hash([1001, secret]); }
  async commitment(pool, note) { return this.hash([1002, ...pool, ...note.asset, note.value, note.owner, note.rho]); }
  async nullifier(pool, cm, secret) { return this.hash([1003, ...pool, cm, secret]); }
  async execute(kind, input) { return this.circuits.get(kind).noir.execute(input); }
  async prove(kind, input) {
    const start = performance.now();
    const { witness } = await this.execute(kind, input);
    const executionMs = performance.now() - start, beforeProof = performance.now();
    const proof = await this.circuits.get(kind).backend.generateProof(witness, OPTIONS);
    this.metrics.push({ kind, executionMs, proveMs: performance.now() - beforeProof, proofBytes: proof.proof.length });
    return { kind, publicInputs: proof.publicInputs.map(field), proof: Buffer.from(proof.proof).toString('base64') };
  }
  async verify(command) {
    try {
      const circuit = this.circuits.get(command.kind);
      const counts = { issue: 6, spend: 6, burn: 8 };
      if (!circuit || !Array.isArray(command.publicInputs) || command.publicInputs.length !== counts[command.kind]) return false;
      command.publicInputs.forEach(parseField);
      if (typeof command.proof !== 'string' || command.proof.length > 131072) return false;
      const bytes = Buffer.from(command.proof, 'base64');
      if (!bytes.length || bytes.length % 32 !== 0 || bytes.toString('base64') !== command.proof) return false;
      return await this.verifier.verifyProof({ proof: bytes, publicInputs: command.publicInputs,
        verificationKey: circuit.vk }, OPTIONS);
    } catch { return false; }
  }
  async close() { await this.api.destroy(); }
}

/** Fixed depth sparse tree. Every leaf must originate in a verified transition. */
export class NoteTree {
  static async create(system, commitments = []) {
    const tree = new NoteTree(system);
    tree.zeros = [field(0)];
    for (let level = 0; level < 8; level++) tree.zeros.push(await system.hash([1004, level, tree.zeros[level], tree.zeros[level]]));
    for (const cm of commitments) await tree.append(cm);
    return tree;
  }
  constructor(system) { this.system = system; this.leaves = []; this.nodes = new Map(); }
  node(level, index) { return this.nodes.get(`${level}:${index}`) ?? this.zeros[level]; }
  root() { return this.node(8, 0); }
  async append(cm) {
    if (this.leaves.length >= 256 || this.leaves.includes(cm) || BigInt(cm) === 0n) throw new Error('duplicate or invalid output/capacity');
    let index = this.leaves.length; this.leaves.push(cm); this.nodes.set(`0:${index}`, cm);
    for (let level = 0; level < 8; level++) {
      const left = index & ~1;
      const node = await this.system.hash([1004, level, this.node(level, left), this.node(level, left + 1)]);
      index >>= 1; this.nodes.set(`${level + 1}:${index}`, node);
    }
  }
  path(cm) {
    let index = this.leaves.indexOf(cm);
    if (index < 0) throw new Error('unknown note');
    const siblings = [], right = [];
    for (let level = 0; level < 8; level++) { right.push((index & 1) === 1); siblings.push(this.node(level, index ^ 1)); index >>= 1; }
    return { siblings, right };
  }
}
