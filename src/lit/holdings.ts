// Lit-v1 §8's holding scan over an already verified replay state (slice 14 M14g): a wallet's notes are the outputs whose
// owner is one of its keys, `ownerSecret`'s for a backing and an index below that backing's window, or a settlement's
// output to `acceptSecret`'s key over that settlement's own demand and acceptance deadline. Openings are public, so the
// scan reads an output's opening (`ScanOutput.lit`) and tries no decryption. It runs inside the replay as the pool's does
// (pool/v3/holdings.ts): the predicate marks the wallet's outputs and the replay keeps each mark with no path, so a read
// costs what is new (pool-v3 §14). It trusts the state it is given; completeness, finality, force and locks are the caller's.
//
// Owner indices are per backing (§8). Each backing the wallet holds has a window, a power of two of at least 512 above
// `h + 256`, where `h` is the highest index §8's restoration rule reaches (keys from 0 until 256 consecutive ones appear
// in no output); every window is named in the predicate's identity, so kept state is reused only under the same windows.
// A read whose `h` reaches past a window reads again under the larger one: every index the rule reaches is then below it.
import { hkdfSync } from "node:crypto";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { ByteReader, ByteWriter, compareBytes, copyBytes } from "../bytes.js";
import { utf8Encoder } from "../contexts.js";
import { KeptStateMismatch } from "../pool/v3/replay-store.js";
import type { KeyedNote, KeyedOwner, Keyring } from "../pool/v3/construction.js";
import type { ScanOutput, StateHandle, WitnessMark, WitnessPredicate } from "../pool/v3/state.js";
import { noteCommitment, noteNullifier, noteTag, spendRho, type Opening, type Output } from "./notes.js";
import { acceptSecret, OWNER_LOOK_AHEAD, ownerRoot, ownerSecretAt, publicKeyOf } from "./wallet-keys.js";

const keyOf = (bytes: Uint8Array): bigint => BigInt(`0x${hex(bytes)}`);
const bytesOf = (key: bigint): Uint8Array => Uint8Array.from(Buffer.from(key.toString(16).padStart(64, "0"), "hex"));
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** The smallest window. */
export const MIN_WINDOW = 512n;
/** The window of a backing whose reached index is `h` (−1 for none): the smallest power of two, at least `MIN_WINDOW`,
 * above `h + 256`. */
export function windowFor(h: bigint): bigint {
  let window = MIN_WINDOW;
  while (window <= h + OWNER_LOOK_AHEAD) window *= 2n;
  return window;
}
/** §8's `h` over a backing's found indices: the highest one its restoration rule reaches from index 0 (−1 for none). */
export function reached(indices: Iterable<bigint>): bigint {
  let h = -1n;
  for (const index of [...new Set(indices)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (index > h + OWNER_LOOK_AHEAD) break;
    h = index;
  }
  return h;
}

/** One wallet's owner keys by backing and index, derived once per handle and extended as windows grow. Only public keys
 * are kept; a secret is derived again when a note is spent. */
export class OwnerKeys implements Keyring {
  readonly #root: Uint8Array;
  readonly #owners = new Map<string, { readonly backing: Uint8Array; readonly index: bigint }>();
  readonly #counts = new Map<string, bigint>();
  #closed = false;
  constructor(seed: Uint8Array, domain: Uint8Array) { this.#root = ownerRoot(seed, domain); }
  /** Derive `backing`'s keys below `window`. */
  extend(backing: Uint8Array, window: bigint): void {
    const name = hex(backing);
    for (let i = this.#counts.get(name) ?? 0n; i < window; i++) {
      this.#owners.set(hex(this.key(backing, i)), { backing: Uint8Array.from(backing), index: i });
      this.#counts.set(name, i + 1n);
    }
  }
  /** The backing and index whose key is `owner`, among those derived. */
  find(owner: Uint8Array): { readonly backing: Uint8Array; readonly index: bigint } | undefined { return this.#owners.get(hex(owner)); }
  /** `ownerSecret` for `backing` and `index`: the caller zeroes it after use. */
  secret(backing: Uint8Array, index: bigint): Uint8Array {
    if (this.#closed) throw new TypeError("the owner keyring is closed");
    return ownerSecretAt(this.#root, backing, index);
  }
  /** `ownerSecret`'s key for `backing` and `index`. */
  key(backing: Uint8Array, index: bigint): Uint8Array {
    const secret = this.secret(backing, index);
    try { return publicKeyOf(secret); } finally { secret.fill(0); }
  }
  close(): void { this.#closed = true; this.#root.fill(0); }
}

/** How a note is the wallet's (§8), and a wallet's lit note, as the one wallet reads them (pool/v3/construction.ts). */
export type LitOwner = KeyedOwner;
export type LitNote = KeyedNote;

/** A mark: the opening; how it is the wallet's (0: a key's backing and index; 1: an acceptance's demand and deadline);
 * and the tag. A local layout of the kept file, read only under the predicate that wrote it, and checked when read. */
const MARK_BYTES = 32 + 8 + 32 + 32 + 1 + 32 + 8 + 32;
function encodeMark(opening: Opening, owner: LitOwner, tag: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.key32(opening.backing, "backing"); w.u64(opening.value); w.key32(opening.owner, "owner"); w.key32(opening.rho, "rho");
  if (owner.acceptance === undefined) { w.u8(0); w.key32(owner.backing, "key backing"); w.u64(owner.index); }
  else { w.u8(1); w.key32(owner.acceptance.demand, "demand"); w.u64(owner.acceptance.deadline); }
  w.key32(tag, "tag");
  return w.finish();
}
function decodeMark(note: Uint8Array): { readonly opening: Opening; readonly owner: LitOwner; readonly tag: bigint } {
  try {
    if (note.length !== MARK_BYTES) throw new RangeError("length");
    const r = new ByteReader(note);
    const opening: Opening = Object.freeze({ backing: r.raw(32), value: r.u64(), owner: r.raw(32), rho: r.raw(32) });
    const source = r.u8(), name = r.raw(32), number = r.u64();
    if (opening.value === 0n || source > 1) throw new RangeError("mark");
    const owner: LitOwner = source === 0 ? { backing: name, index: number } : { acceptance: { demand: name, deadline: number } };
    const tag = keyOf(r.raw(32));
    r.expectEnd();
    return { opening, owner, tag };
  } catch { throw new KeptStateMismatch("a witnessed output's mark"); }
}

/** A local name only: it labels the kept replay state of one seed, configuration and set of windows. */
const SCAN_INFO = utf8Encoder.encode("moe/wallet/lit/v1/kept-scan");

/** The replay's witness predicate for this wallet's keys: an output to an owner key of a backing in `windows` with an
 * index below that backing's window, or a settlement's to the acceptance key its own demand and deadline derive. It never
 * throws, so a wallet's reading cannot change a checkpoint's verdict. Its identity is derived one way from the seed, the
 * domain and every backing's window. */
export function litWitness(seed: Uint8Array, domain: Uint8Array, windows: ReadonlyMap<string, bigint>, keys: OwnerKeys): WitnessPredicate {
  const own = copyBytes(seed), ownDomain = copyBytes(domain), info = new ByteWriter();
  info.context(SCAN_INFO);
  for (const [name, window] of [...windows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const backing = Uint8Array.from(Buffer.from(name, "hex"));
    info.key32(backing, "backing"); info.u64(window); keys.extend(backing, window);
  }
  const identity = new Uint8Array(hkdfSync("sha256", own, ownDomain, info.finish(), 32));
  return Object.assign((output: ScanOutput): WitnessMark | undefined => {
    try {
      const lit = output.lit;
      if (lit === undefined) return undefined;
      let owner: LitOwner | undefined;
      if (lit.acceptance !== undefined) {
        const secret = acceptSecret(own, ownDomain, lit.acceptance.demand, lit.acceptance.deadline);
        try { if (same(publicKeyOf(secret), lit.owner)) owner = { acceptance: lit.acceptance }; } finally { secret.fill(0); }
      }
      if (owner === undefined) {
        const found = keys.find(lit.owner), window = found === undefined ? undefined : windows.get(hex(found.backing));
        if (found === undefined || window === undefined || found.index >= window) return undefined;
        owner = found;
      }
      const nf = noteNullifier(bytesOf(output.cm)), opening = { backing: lit.backing, value: lit.value, owner: lit.owner, rho: lit.rho };
      return { nf: keyOf(nf), note: encodeMark(opening, owner, noteTag(nf)) };
    } catch { return undefined; }
  }, { identity });
}

/** The marks of `state` read back, each checked against its commitment, nullifier and tag, and its owner against the
 * seed's keys (the key of its backing and index, among those the keyring derived, or its acceptance's key), so no
 * field of a kept mark is trusted: a mark its output and seed do not give is kept state to discard (§14). `spent`
 * includes the spent ones. */
function* marked(seed: Uint8Array, domain: Uint8Array, state: StateHandle, keys: OwnerKeys, spent: boolean): Generator<LitNote> {
  const rows = spent ? state.store.witnessed(state.ns, state.position) : state.store.unspentWitnessed(state.ns, state.position);
  for (const stored of rows) {
    const { opening, owner, tag } = decodeMark(stored.mark.note), cm = stored.cm;
    const nf = noteNullifier(bytesOf(cm));
    let keyed: boolean;
    if (owner.acceptance === undefined) {
      const found = keys.find(opening.owner);
      keyed = found !== undefined && found.index === owner.index && same(found.backing, owner.backing);
    } else {
      const secret = acceptSecret(seed, domain, owner.acceptance.demand, owner.acceptance.deadline);
      try { keyed = same(publicKeyOf(secret), opening.owner); } finally { secret.fill(0); }
    }
    if (!keyed || keyOf(noteCommitment(domain, opening)) !== cm || keyOf(nf) !== stored.mark.nf || keyOf(noteTag(nf)) !== tag) {
      throw new KeptStateMismatch("a witnessed output's mark is not what its output and seed give");
    }
    yield Object.freeze({ opening, cm, nf: stored.mark.nf, tag, owner, ns: stored.ns, position: stored.position, local: stored.ns === state.ns });
  }
}

/** This wallet's unspent notes of `backing` in a state replayed with its `litWitness`. Shared history can hold the same
 * wallet's notes of other scoped backings. */
export function litNotes(seed: Uint8Array, domain: Uint8Array, backing: Uint8Array, state: StateHandle, keys: OwnerKeys, spent = false): LitNote[] {
  return [...marked(seed, domain, state, keys, spent)].filter(note => same(note.opening.backing, backing));
}

/** Per backing (hex) whose keys the read found in outputs of that backing, spent ones included: §8's `h` (the highest
 * index its restoration rule finds), the highest index found at all, beyond a 256-index gap too, and `h` over the
 * outputs whose commitment `excluded` does not hold (a restored wallet's own since its restoration, Next 4 (bc)). An
 * output of another backing to a backing's key is the wallet's note but moves no index (§8). */
export function foundIndices(seed: Uint8Array, domain: Uint8Array, state: StateHandle, keys: OwnerKeys, excluded?: ReadonlySet<bigint>):
  Map<string, { readonly reached: bigint; readonly top: bigint; readonly reachedExcluding: bigint }> {
  const indices = new Map<string, { readonly all: bigint[]; readonly kept: bigint[] }>();
  for (const note of marked(seed, domain, state, keys, true)) {
    if (note.owner.index === undefined || !same(note.opening.backing, note.owner.backing)) continue;
    const name = hex(note.owner.backing), found = indices.get(name) ?? { all: [], kept: [] };
    indices.set(name, found);
    found.all.push(note.owner.index);
    if (excluded?.has(note.cm) !== true) found.kept.push(note.owner.index);
  }
  return new Map([...indices].map(([name, { all, kept }]) =>
    [name, { reached: reached(all), top: all.reduce((a, b) => (a > b ? a : b)), reachedExcluding: reached(kept) }]));
}

/** Whether the statement that created the note consumed notes, all of them the wallet's own (§8: no request is credited
 * with such an output): the nullifiers that statement inserted, read from the replay's own rows, each spending an output
 * the wallet marked. An issue consumes none. */
export function ownFunded(state: StateHandle, note: LitNote): boolean {
  const consumed = state.store.consumedAt(note.ns, note.position);
  return consumed.length > 0 && consumed.every(nf => state.store.marked(state.ns, state.position, nf));
}

/** Whether a statement that consumed notes of this wallet and that `saved` does not name (a statement this wallet did not
 * save: its lost instance's, or one a seed restoration's earlier life made), created the exact output `output` (slice 13
 * M13f, Next 4 (aw)). A spend's output derives from the nullifiers it consumes in input order and its position (§2), and
 * every spend consumes one or two notes into at most four outputs, so each such statement gives at most eight candidates:
 * the cost follows this wallet's own spends, never the record's outputs. */
export function paidByOwn(seed: Uint8Array, domain: Uint8Array, state: StateHandle, keys: OwnerKeys, output: Output,
  saved: (statement: Uint8Array) => boolean): boolean {
  const checked = new Set<string>();
  for (const note of marked(seed, domain, state, keys, true)) {
    for (const spend of state.store.tagSpends(state.ns, state.position, note.tag)) {
      const place = `${spend.ns}:${spend.position}`;
      if (checked.has(place)) continue;
      checked.add(place);
      if (saved(spend.identity)) continue;
      const nfs = state.store.consumedAt(spend.ns, spend.position).map(bytesOf);
      for (const order of nfs.length === 2 ? [nfs, [nfs[1]!, nfs[0]!]] : [nfs]) {
        for (let j = 0; j < 4; j++) {
          if (state.hasOutput(keyOf(noteCommitment(domain, { ...output, rho: spendRho(order, j) })))) return true;
        }
      }
    }
  }
  return false;
}

/** The note's spend secret (the caller zeroes it), checked against its owner: a mark whose key this seed does not
 * derive is kept state to discard. */
export function noteSecret(seed: Uint8Array, domain: Uint8Array, keys: OwnerKeys, note: LitNote): Uint8Array {
  const secret = note.owner.index !== undefined ? keys.secret(note.owner.backing, note.owner.index) :
    acceptSecret(seed, domain, note.owner.acceptance.demand, note.owner.acceptance.deadline);
  if (!same(publicKeyOf(secret), note.opening.owner)) { secret.fill(0); throw new KeptStateMismatch("a witnessed output's owner is not this seed's"); }
  return secret;
}
