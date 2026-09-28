// C4.6–7 seed scan over an already verified replay state: the wallet's own
// positive notes of one backing that the state has not spent. It trusts the
// state it is given; completeness, finality, force effects and locks belong to
// the caller's independent frontier read. No output is fetched or asked about.
import { compareBytes } from "../../bytes.js";
import { fieldToBytes, identifierOf } from "../field.js";
import type { NoteTree } from "../note-tree.js";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "../notes.js";
import { createCapsuleScanner, deriveSettlementOwnerSecret } from "./capsules.js";
import { settlementAuthorization } from "./records.js";
import { requireReplay } from "./refusals.js";
import type { ReplayedState } from "./state.js";
import type { SpendableNote } from "./witness.js";

/** A restored note, where it sits and whether its tree is the replayed segment's own. */
export interface OwnedNote extends SpendableNote {
  readonly leaf: bigint;
  readonly tree: NoteTree;
  readonly local: boolean;
}

/** Try every output once: capsule outputs by AEAD trial, lit settlements by
 * the C4.7 owner derivation. Zero and already spent notes are not holdings. */
export function ownedNotes(seed: Uint8Array, domain: Uint8Array, backing: Uint8Array,
  state: Pick<ReplayedState, "scanOutputs" | "outputPositions" | "spent" | "tree">): OwnedNote[] {
  const scanner = createCapsuleScanner(seed, domain), found: OwnedNote[] = [];
  for (const output of state.scanOutputs) {
    let note: SpendableNote;
    if (output.settlement === undefined) {
      if (output.capsule === undefined) continue;
      const recovered = scanner.tryRecover(output.cm, output.capsule);
      if (recovered === null) continue;
      note = { opening: recovered.opening, secret: recovered.secret, cm: recovered.cm, nf: recovered.nf };
    } else {
      const record = output.settlement, p = record.publicInputs, { acceptance } = settlementAuthorization(record);
      const secret = deriveSettlementOwnerSecret(seed, domain, acceptance.demand, acceptance.deadline).value;
      if (ownerOf(secret) !== p[8]) continue;
      const opening: NoteOpening = { backing: identifierOf(p[5]!, p[6]!), value: p[7]!, owner: p[8]!, rho: p[9]! };
      requireReplay(commitmentOf(domain, opening) === output.cm, "OUTPUT");
      note = { opening, secret, cm: output.cm, nf: nullifierOf(domain, output.cm, secret) };
    }
    // Shared history can hold the same seed's notes of other scoped backings.
    if (compareBytes(note.opening.backing, backing) !== 0 || note.opening.value === 0n) continue;
    if (state.spent.has(fieldToBytes(note.nf))) continue;
    const location = state.outputPositions.get(note.cm);
    requireReplay(location !== undefined, "OUTPUT");
    found.push(Object.freeze({ ...note, leaf: location.leaf, tree: location.tree, local: location.tree === state.tree }));
  }
  return found;
}
