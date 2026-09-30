// C4.6–7 seed scan over an already verified replay state: the wallet's own
// positive notes of one backing that the state has not spent. It trusts the
// state it is given; completeness, finality, force effects and locks belong to
// the caller's independent frontier read. No output is fetched or asked about.
// The scan runs inside the replay: its predicate marks this seed's outputs, the
// replay keeps an incremental witness for each, and the notes are read back
// from those witnessed outputs with their paths.
import { hkdfSync } from "node:crypto";
import { compareBytes, copyBytes } from "../../bytes.js";
import { identifierOf } from "../field.js";
import type { NotePath } from "../note-tree.js";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "../notes.js";
import { createCapsuleScanner, deriveSettlementOwnerSecret } from "./capsules.js";
import { settlementAuthorization } from "./records.js";
import { requireReplay } from "./refusals.js";
import type { ScanOutput, StateHandle, WitnessPredicate } from "./state.js";
import type { SpendableNote } from "./witness.js";

/** A restored note, its leaf, its path to `anchor`, and whether its segment is the replayed one itself. */
export interface OwnedNote extends SpendableNote {
  readonly leaf: bigint;
  readonly anchor: bigint;
  readonly path: NotePath;
  readonly local: boolean;
}

/** This seed's reading of one output: capsule outputs by AEAD trial, lit
 * settlements by the C4.7 owner derivation; undefined for another's. */
export function seedScanner(seed: Uint8Array, domain: Uint8Array): (output: ScanOutput) => SpendableNote | undefined {
  const scanner = createCapsuleScanner(seed, domain);
  return output => {
    if (output.settlement === undefined) {
      if (output.capsule === undefined) return undefined;
      const recovered = scanner.tryRecover(output.cm, output.capsule);
      if (recovered === null) return undefined;
      return { opening: recovered.opening, secret: recovered.secret, cm: recovered.cm, nf: recovered.nf };
    }
    const record = output.settlement, p = record.publicInputs, { acceptance } = settlementAuthorization(record);
    const secret = deriveSettlementOwnerSecret(seed, domain, acceptance.demand, acceptance.deadline).value;
    if (ownerOf(secret) !== p[8]) return undefined;
    const opening: NoteOpening = { backing: identifierOf(p[5]!, p[6]!), value: p[7]!, owner: p[8]!, rho: p[9]! };
    requireReplay(commitmentOf(domain, opening) === output.cm, "OUTPUT");
    return { opening, secret, cm: output.cm, nf: nullifierOf(domain, output.cm, secret) };
  };
}

/** A local name only: it labels the kept replay state of one seed under one configuration and enters no protocol message. */
const WITNESS_INFO = new TextEncoder().encode("moe/wallet/v3/kept-witness");

/** The replay's witness predicate for this seed: every positive output it
 * owns. A zero note is never a holding and spends without membership
 * (pool-fees C1.2.3), so it needs no path and no witness is kept for it. It
 * never throws, so a seed's reading cannot change a checkpoint's verdict; an
 * output it cannot read (a settlement whose opening does not give its
 * commitment, which settle's proof rules out) is not witnessed or held.
 * The seed and domain fix which outputs it accepts, so it declares an identity
 * derived from them one way (pool-v3 §14 kept context): a kept replay file is
 * then reused only by the same seed, and holds nothing the seed is read from. */
export function seedWitness(seed: Uint8Array, domain: Uint8Array): WitnessPredicate {
  const scan = seedScanner(seed, domain);
  const identity = new Uint8Array(hkdfSync("sha256", copyBytes(seed), copyBytes(domain), WITNESS_INFO, 32));
  return Object.assign((output: ScanOutput): boolean => {
    try { const note = scan(output); return note !== undefined && note.opening.value > 0n; } catch { return false; }
  }, { identity });
}

/** This seed's unspent positive notes of `backing` in a state replayed with
 * `seedWitness(seed, domain)`. Zero and already spent notes are not holdings. */
export function ownedNotes(seed: Uint8Array, domain: Uint8Array, backing: Uint8Array, state: StateHandle): OwnedNote[] {
  const scan = seedScanner(seed, domain), found: OwnedNote[] = [];
  for (const stored of state.store.witnessedOutputs(state.ns, state.position)) {
    const note = scan(state.scanOutput(stored));
    if (note === undefined) continue;
    // Shared history can hold the same seed's notes of other scoped backings.
    if (compareBytes(note.opening.backing, backing) !== 0 || note.opening.value === 0n) continue;
    if (state.hasNullifier(note.nf)) continue;
    const placed = state.path(note.cm);
    requireReplay(placed !== undefined, "OUTPUT");
    found.push(Object.freeze({ ...note, leaf: placed.leaf, anchor: placed.anchor, path: placed.path, local: placed.local }));
  }
  return found;
}
