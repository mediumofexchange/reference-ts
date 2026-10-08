// C4.6–7 seed scan over an already verified replay state: the wallet's own
// positive notes of one backing that the state has not spent. It trusts the
// state it is given; completeness, finality, force effects and locks belong to
// the caller's independent frontier read. No output is fetched or asked about.
// The scan runs inside the replay, once per output: its predicate marks this
// seed's outputs with their nullifiers and openings, the replay keeps an
// incremental witness for each, and the notes are read back from those marks
// with their paths. A read recovers an output again only to spend it, and
// hashes no nullifier's tag: the mark keeps it.
import { hkdfSync } from "node:crypto";
import { compareBytes, copyBytes } from "../../bytes.js";
import { bytesToField, fieldToBytes, identifierOf } from "../field.js";
import type { NotePath } from "../note-tree.js";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "../notes.js";
import { createCapsuleScanner, deriveSettlementOwnerSecret } from "./capsules.js";
import { settlementAuthorization } from "./records.js";
import { requireReplay } from "./refusals.js";
import { tagOf } from "./recovery.js";
import { KeptStateMismatch } from "./replay-store.js";
import type { OutputPath, ScanOutput, StateHandle, WitnessMark, WitnessPredicate } from "./state.js";
import type { NoteInput, SpendableNote } from "./witness.js";

/** A restored note, its nullifier's tag (C3.3, what a demand locks it by), its leaf, its path to `anchor`, and whether
 * its segment is the replayed one itself. Its spend secret, anchor and path are found when first read, so a read that
 * spends nothing scans no output again and folds no path. */
export interface OwnedNote extends SpendableNote {
  readonly tag: bigint;
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

/** A witnessed note's opening as its mark keeps it: backing, owner and rho, then the value as a big-endian u64, then
 * its nullifier's tag, hashed once when the output is marked rather than at every read. No spend secret is kept, so
 * the replay file stays without one (wallet-store.ts). The layout is the kept file's: a change to it changes
 * `SCHEMA_VERSION` in replay-store.ts, so no file of another layout is read. */
const NOTE_BYTES = 136;
function encodeNote(opening: NoteOpening, nf: bigint): Uint8Array {
  const out = new Uint8Array(NOTE_BYTES);
  out.set(opening.backing, 0); out.set(fieldToBytes(opening.owner), 32); out.set(fieldToBytes(opening.rho), 64);
  new DataView(out.buffer).setBigUint64(96, opening.value);
  out.set(fieldToBytes(tagOf(nf)), 104);
  return out;
}
/** A mark's opening and tag; one this predicate could not have written is kept state to discard (§14). The tag is
 * checked against the nullifier when the note is spent, with the rest of the mark. */
function decodeNote(note: Uint8Array): { readonly opening: NoteOpening; readonly tag: bigint } {
  try {
    if (note.length !== NOTE_BYTES) throw new RangeError("length");
    const opening = Object.freeze({ backing: note.slice(0, 32), owner: bytesToField(note.slice(32, 64)), rho: bytesToField(note.slice(64, 96)),
      value: new DataView(note.buffer, note.byteOffset).getBigUint64(96) });
    if (opening.value === 0n) throw new RangeError("value");
    return { opening, tag: bytesToField(note.slice(104, 136)) };
  } catch { throw new KeptStateMismatch("a witnessed output's mark"); }
}
const sameOpening = (a: NoteOpening, b: NoteOpening): boolean =>
  compareBytes(a.backing, b.backing) === 0 && a.value === b.value && a.owner === b.owner && a.rho === b.rho;

/** A local name only: it labels the kept replay state of one seed under one configuration and enters no protocol message. */
const WITNESS_INFO = new TextEncoder().encode("moe/wallet/v3/kept-witness");

/** The replay's witness predicate for this seed: every positive output it
 * owns, marked with its nullifier, opening and tag. A zero note is never a holding and spends without membership
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
  return Object.assign((output: ScanOutput): WitnessMark | undefined => {
    try {
      const note = scan(output);
      return note === undefined || note.opening.value === 0n ? undefined : { nf: note.nf, note: encodeNote(note.opening, note.nf) };
    } catch { return undefined; }
  }, { identity });
}

/** One note `ownedNotes` read: its fields, with its path and spend secret found when first read. The accessors are the
 * class's, so a read of many holdings keeps no closures of its own per note (slice 15, WORK.md Next 4 (az)). */
class ReadNote implements OwnedNote {
  readonly #state: StateHandle;
  readonly #scan: (output: ScanOutput) => SpendableNote | undefined;
  readonly #output: ScanOutput;
  #placed: OutputPath | undefined;
  #secret: bigint | undefined;
  constructor(readonly opening: NoteOpening, readonly cm: bigint, readonly nf: bigint, readonly tag: bigint, readonly leaf: bigint,
    readonly local: boolean, state: StateHandle, scan: (output: ScanOutput) => SpendableNote | undefined, output: ScanOutput,
    placed: OutputPath | undefined) {
    this.#state = state; this.#scan = scan; this.#output = output; this.#placed = placed;
    Object.freeze(this);
  }
  #place(): OutputPath { return this.#placed ??= placeOf(this.#state, this.cm); }
  get anchor(): bigint { return this.#place().anchor; }
  get path(): NotePath { return this.#place().path; }
  get secret(): bigint {
    if (this.#secret === undefined) {
      const note = this.#scan(this.#output);
      if (note === undefined || note.cm !== this.cm || note.nf !== this.nf || !sameOpening(note.opening, this.opening) || tagOf(this.nf) !== this.tag) {
        throw new KeptStateMismatch("a witnessed output's mark is not what its output recovers");
      }
      this.#secret = note.secret;
    }
    return this.#secret;
  }
}
const placeOf = (state: StateHandle, cm: bigint): OutputPath => { const placed = state.path(cm); requireReplay(placed !== undefined, "OUTPUT"); return placed; };

/** This seed's unspent positive notes of `backing` in a state replayed with
 * `seedWitness(seed, domain)`, read from the witnesses' marks: the state
 * leaves spent ones out. A note's spend secret is recovered from its output
 * when first read, and that recovery must give the kept nullifier, opening and
 * tag, or the kept state is discarded (KeptStateMismatch, §14).
 * Its path is read from `state` when first read, so a note is spent from the
 * state it was read in; one path per namespace is read here, so a kept witness
 * past the read position (§14) refuses this read rather than a later spend. */
export function ownedNotes(seed: Uint8Array, domain: Uint8Array, backing: Uint8Array, state: StateHandle): OwnedNote[] {
  const scan = seedScanner(seed, domain), found: OwnedNote[] = [], checked = new Set<number>();
  for (const stored of state.store.unspentWitnessed(state.ns, state.position)) {
    const { opening, tag } = decodeNote(stored.mark.note), nf = stored.mark.nf, cm = stored.cm;
    // Shared history can hold the same seed's notes of other scoped backings.
    if (compareBytes(opening.backing, backing) !== 0) continue;
    const placed = checked.has(stored.ns) ? undefined : placeOf(state, cm);
    checked.add(stored.ns);
    // The output as scanned, fixed now: the secret's recovery reads nothing of the state later.
    found.push(new ReadNote(opening, cm, nf, tag, stored.leaf, stored.ns === state.ns, state, scan, state.scanOutput(stored), placed));
  }
  return found;
}

/** A note completed to spend: its secret recovered (refusing a mark its output does not give) and its path read,
 * both from the read it came from. */
export function inputOf(note: OwnedNote): NoteInput {
  void note.secret;
  return { note, anchor: note.anchor, path: note.path };
}
