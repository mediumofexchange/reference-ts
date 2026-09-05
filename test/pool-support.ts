import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { fieldToHex, limbsOf } from "../src/pool/field.js";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "../src/pool/notes.js";
import type { StatementVerifier } from "../src/pool/pool.js";
import {
  BURN,
  configurationHash,
  ISSUE,
  poolIdentity,
  SPEND,
  statementBytes,
  type PoolConfiguration,
  type Statement,
  type StatementKind,
} from "../src/pool/statement.js";
import { KEYS, pub } from "./support.js";

// Fixtures for the claim-layer tests. The configuration's circuit identities
// are placeholders: these tests exercise admission's state machine over the
// frames, and the circuit relation itself is exercised with real proofs by
// `npm run check:pool`, which drives the same Pool class through
// `scripts/pool/admission.mjs`.

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

export const CONFIG: PoolConfiguration = Object.freeze({
  pool: poolIdentity(KEYS.operator, 0n),
  operator: KEYS.operator,
  issue: { bytecode: fill(0x11), vk: fill(0x12) },
  spend: { bytecode: fill(0x13), vk: fill(0x14) },
  burn: { bytecode: fill(0x15), vk: fill(0x16) },
  helper: fill(0x17),
});
export const CONFIG_HASH = configurationHash(CONFIG);

/** A backing whose E names the pool's operator and configuration. */
export function makePoolBacking(
  secret: Uint8Array,
  thing = "EUR",
  configuration: Uint8Array = CONFIG_HASH,
  operator: Uint8Array = KEYS.operator,
): Backing {
  return makeBacking({
    obligor: pub(secret),
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: { setting: "pool", operator, construction: "moe/pool/v1", configuration },
  });
}

export function signedPoolBacking(secret: Uint8Array, thing = "EUR"): { backing: Backing; signature: Uint8Array } {
  const backing = makePoolBacking(secret, thing);
  return { backing, signature: signBacking(secret, backing) };
}

function keyOf(kind: StatementKind, publicInputs: readonly bigint[], proof: Uint8Array): string {
  return `${kind}:${publicInputs.map(fieldToHex).join(",")}:${bytesToHex(proof)}`;
}

/**
 * A verifier that accepts exactly the (kind, public inputs, proof) triples a
 * test has marked valid, and nothing else. It stands in for the proof system
 * so that each admission check can be exercised by a statement the verifier
 * would otherwise accept; a real proof binds its public inputs the same way,
 * which `check:pool` shows with Barretenberg.
 */
export class Oracle implements StatementVerifier {
  private readonly valid = new Set<string>();
  calls = 0;

  accept<S extends Statement>(statement: S): S {
    this.valid.add(keyOf(statement.kind, statement.publicInputs, statement.proof));
    return statement;
  }

  async verify(kind: StatementKind, publicInputs: readonly bigint[], proof: Uint8Array): Promise<boolean> {
    this.calls++;
    // Yield once, as a WASM verifier does, so admissions interleave here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return this.valid.has(keyOf(kind, publicInputs, proof));
  }
}

/** Distinct statements get distinct 32-byte "proofs", which a test can also corrupt. */
export function proofFor(kind: StatementKind, publicInputs: readonly bigint[], configHash: Uint8Array = CONFIG_HASH): Uint8Array {
  return sha256(statementBytes(configHash, kind, publicInputs));
}

/** A wallet's view of one note: its opening, its secret, and what the circuits derive from them. */
export interface WalletNote {
  readonly opening: NoteOpening;
  readonly secret: bigint;
  readonly cm: bigint;
  readonly nf: bigint;
}

export function walletNote(backing: Uint8Array, value: bigint, seed: bigint, pool: Uint8Array = CONFIG.pool): WalletNote {
  const secret = seed * 2n + 1n;
  const opening: NoteOpening = { backing, value, owner: ownerOf(secret), rho: seed * 2n + 2n };
  const cm = commitmentOf(pool, opening);
  return { opening, secret, cm, nf: nullifierOf(pool, cm, secret) };
}

export function issueStatement(
  backing: Uint8Array,
  quantity: bigint,
  cm: bigint,
  obligorSecret: Uint8Array,
  configHash: Uint8Array = CONFIG_HASH,
  pool: Uint8Array = CONFIG.pool,
): Statement {
  const publicInputs = [...limbsOf(pool), ...limbsOf(backing), quantity, cm];
  return {
    kind: ISSUE,
    publicInputs,
    proof: proofFor(ISSUE, publicInputs, configHash),
    obligorSignature: ed25519.sign(statementBytes(configHash, ISSUE, publicInputs), obligorSecret),
  };
}

export function spendStatement(
  anchor: bigint,
  nullifiers: readonly [bigint, bigint],
  outputs: readonly [bigint, bigint],
  pool: Uint8Array = CONFIG.pool,
): Statement {
  const publicInputs = [...limbsOf(pool), anchor, ...nullifiers, ...outputs];
  return { kind: SPEND, publicInputs, proof: proofFor(SPEND, publicInputs) };
}

export function burnStatement(
  backing: Uint8Array,
  quantity: bigint,
  anchor: bigint,
  nullifiers: readonly [bigint, bigint],
  change: bigint,
  pool: Uint8Array = CONFIG.pool,
): Statement {
  const publicInputs = [...limbsOf(pool), ...limbsOf(backing), quantity, anchor, ...nullifiers, change];
  return { kind: BURN, publicInputs, proof: proofFor(BURN, publicInputs) };
}
