import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking, signBacking, type Backing } from "../src/backing.js";
import { compareBytes } from "../src/bytes.js";
import { directoryRoot, signCommitment } from "../src/commitment.js";
import { fieldToHex, limbsOf } from "../src/pool/field.js";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "../src/pool/notes.js";
import { Segment, type Checkpoint, type ImportEvidence, type StatementVerifier } from "../src/pool/segment.js";
import {
  BURN,
  configurationHash,
  ISSUE,
  segmentAuthority,
  SPEND,
  statementBytes,
  type OpeningCheckpoint,
  type PoolConfiguration,
  type SegmentAuthority,
  type SegmentEntry,
  type SegmentHeader,
  type Statement,
  type StatementKind,
} from "../src/pool/statement.js";
import { KEYS, pub, SECRETS } from "./support.js";

// Fixtures for the claim-layer tests. The configuration's circuit identities
// are placeholders: these tests exercise admission, import and replay over
// the frames, and the circuit relation itself is exercised with real proofs
// by `npm run check:pool`, which drives the same Segment class through
// `scripts/pool/admission.mjs`.

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

export const CONFIG: PoolConfiguration = Object.freeze({
  issue: { bytecode: fill(0x11), vk: fill(0x12) },
  spend: { bytecode: fill(0x13), vk: fill(0x14) },
  burn: { bytecode: fill(0x15), vk: fill(0x16) },
  helper: fill(0x17),
});
/** configHash: the construction domain. */
export const DOMAIN = configurationHash(CONFIG);
/** The one venue every scoped backing declares in these tests (C2.10.2). */
export const VENUE = fill(0x33);
/** A second operator, for replacement cases. */
export const OPERATOR_Q = SECRETS.carol;

/** A backing whose E names the construction, the domain and an original operator. */
export function makePoolBacking(
  secret: Uint8Array,
  thing = "EUR",
  configuration: Uint8Array = DOMAIN,
  operator: Uint8Array = KEYS.operator,
): Backing {
  return makeBacking({
    obligor: pub(secret),
    payout: { thing, quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: { setting: "pool", operator, construction: "moe/pool/v2", configuration },
  });
}

export function signedPoolBacking(secret: Uint8Array, thing = "EUR"): { backing: Backing; signature: Uint8Array } {
  const backing = makePoolBacking(secret, thing);
  return { backing, signature: signBacking(secret, backing) };
}

/** A header over `entries`, sorted by backing as the frame requires; a missing link is the genesis link, the backing's name. */
export function headerOf(
  entries: readonly { backing: Uint8Array; link?: Uint8Array; opening?: OpeningCheckpoint }[],
  operator: Uint8Array = KEYS.operator,
  sequence = 1n,
  venue: Uint8Array = VENUE,
): SegmentHeader {
  const sorted: SegmentEntry[] = entries
    .map((e) => ({ backing: e.backing, link: e.link ?? e.backing, ...(e.opening === undefined ? {} : { opening: e.opening }) }))
    .sort((a, b) => compareBytes(a.backing, b.backing));
  return { domain: DOMAIN, venue, operator, sequence, entries: sorted };
}

/** A genesis header: every backing opens the empty book (C2.7.3). */
export function genesisHeader(backings: readonly Backing[], operator: Uint8Array = KEYS.operator, sequence = 1n): SegmentHeader {
  return headerOf(backings.map((b) => ({ backing: b.name })), operator, sequence);
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
export function proofFor(kind: StatementKind, publicInputs: readonly bigint[], domain: Uint8Array = DOMAIN): Uint8Array {
  return sha256(statementBytes(domain, kind, publicInputs));
}

/** A wallet's view of one note: its opening, its secret, and what the circuits derive from them. */
export interface WalletNote {
  readonly opening: NoteOpening;
  readonly secret: bigint;
  readonly cm: bigint;
  readonly nf: bigint;
}

export function walletNote(backing: Uint8Array, value: bigint, seed: bigint, domain: Uint8Array = DOMAIN): WalletNote {
  const secret = seed * 2n + 1n;
  const opening: NoteOpening = { backing, value, owner: ownerOf(secret), rho: seed * 2n + 2n };
  const cm = commitmentOf(domain, opening);
  return { opening, secret, cm, nf: nullifierOf(domain, cm, secret) };
}

const head = (authority: SegmentAuthority): bigint[] => [...limbsOf(authority.domain), ...limbsOf(authority.segment), authority.scopeRoot];

export function issueStatement(
  authority: SegmentAuthority,
  backing: Uint8Array,
  quantity: bigint,
  cm: bigint,
  obligorSecret: Uint8Array,
): Statement {
  const publicInputs = [...head(authority), ...limbsOf(backing), quantity, cm];
  return {
    kind: ISSUE,
    publicInputs,
    proof: proofFor(ISSUE, publicInputs, authority.domain),
    obligorSignature: ed25519.sign(statementBytes(authority.domain, ISSUE, publicInputs), obligorSecret),
  };
}

export function spendStatement(
  authority: SegmentAuthority,
  anchors: readonly [bigint, bigint],
  nullifiers: readonly [bigint, bigint],
  outputs: readonly [bigint, bigint],
): Statement {
  const publicInputs = [...head(authority), ...anchors, ...nullifiers, ...outputs];
  return { kind: SPEND, publicInputs, proof: proofFor(SPEND, publicInputs, authority.domain) };
}

export function burnStatement(
  authority: SegmentAuthority,
  backing: Uint8Array,
  quantity: bigint,
  anchors: readonly [bigint, bigint],
  nullifiers: readonly [bigint, bigint],
  change: bigint,
): Statement {
  const publicInputs = [...head(authority), ...limbsOf(backing), quantity, ...anchors, ...nullifiers, change];
  return { kind: BURN, publicInputs, proof: proofFor(BURN, publicInputs, authority.domain) };
}

/** Open a segment over `header`, registering the signed backings, with a fresh oracle unless one is given. */
export function openSegment(
  header: SegmentHeader,
  signed: readonly { backing: Backing; signature: Uint8Array }[],
  imports: readonly ReturnType<Segment["prefix"]>[] = [],
  oracle = new Oracle(),
): { segment: Segment; authority: SegmentAuthority; oracle: Oracle } {
  const segment = new Segment(CONFIG, header, imports, oracle);
  for (const { backing, signature } of signed) segment.register(backing, signature);
  return { segment, authority: segmentAuthority(header), oracle };
}

/** The operator commits the segment at its current length: the checkpoint a later opening names. */
export function checkpointOf(segment: Segment, operatorSecret: Uint8Array, sequence: bigint): { checkpoint: Checkpoint; opening: OpeningCheckpoint; length: bigint } {
  const directory = segment.directory();
  const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
  return {
    checkpoint: { commitment, directory },
    opening: { operator: commitment.operator, sequence, root: commitment.root },
    length: segment.length,
  };
}

/** Evidence for replay: the checkpoint with the trail it checkpointed and the length. */
export function evidenceOf(segment: Segment, point: ReturnType<typeof checkpointOf>): ImportEvidence {
  return { checkpoint: point.checkpoint, trail: segment.trail(), length: point.length };
}

export { segmentAuthority };
