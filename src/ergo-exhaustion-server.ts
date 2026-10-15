// A supplier's side of succinct-read §4 (`moe/succinct/v1`): the subject map over blocks handed to it in order, folds
// sealed at the ends it chooses, paths and entries at the latest fold, and transactions with inclusion paths. It is
// trusted by no reader (§4.7), which recomputes every value, so it keeps no evidence of its own beyond what it serves.
//
// A fold proof comes from `prove`: a prover pool's (`ExhaustionPool`), or a test set's hash (`testExhaustionSet`),
// which attests nothing. The server computes the map natively and hands `prove` the inputs a fold would carry with the
// period itself: where it begins, its blocks and the map's updates over them. A period whose proof fails is proved
// again before the next, so the folds always continue one another.
import { copyBytes, EncodingError } from "./bytes.js";
import {
  sectionInclusionPath, SubjectMap, type ExhaustionSupplier, type Fold, type FoldInputs, type IncludedTransaction, type KeyAnswer, type MapUpdate,
} from "./ergo-exhaustion.js";
import type { ErgoTransactionView } from "./ergo-profile.js";

/** A block as the server is handed it, after its caller authenticated the section against the header and the header
 * against its parent; a prover of the period needs the header's bytes. */
export interface ServedBlock {
  readonly id: Uint8Array; readonly transactionsRoot: Uint8Array; readonly section: readonly ErgoTransactionView[]; readonly header?: Uint8Array;
}
/** A period as `prove` is handed it: where it begins, its blocks, the map's updates over them and the fold it continues. */
export interface ServerPeriod {
  readonly begin: { readonly id: Uint8Array; readonly height: bigint; readonly root: bigint };
  readonly blocks: readonly ServedBlock[];
  readonly updates: readonly MapUpdate[];
  readonly previous: Fold | undefined;
}

export interface ExhaustionServerOptions {
  /** The set's start header (§6). */
  readonly start: { readonly id: Uint8Array; readonly height: bigint };
  /** The next fold's key hash, every fold's `foldKeyHash` (§4.3). */
  readonly foldKeyHash: bigint;
  /** A fold proof over these inputs and `period`: the first fold's where `first`, else a next fold's over the previous. */
  prove(first: boolean, inputs: FoldInputs, period: ServerPeriod): Promise<Uint8Array> | Uint8Array;
  readonly name?: string;
  /** The block at a height, where the caller keeps blocks itself (a view's rows): the server then keeps none. */
  block?(height: bigint): ServedBlock | undefined;
}

/** A block read once into owned bytes, or a refusal before anything is appended: a 32-byte id and root, a section of
 * transactions each with unsigned bytes and a witness id, and optionally the header's bytes. */
function ownBlock(block: ServedBlock): ServedBlock {
  const bytes = (v: unknown, width?: number): v is Uint8Array => v instanceof Uint8Array && (width === undefined || v.length === width);
  if (block === null || typeof block !== "object") throw new EncodingError("invalid exhaustion block");
  const { id, transactionsRoot, section, header } = block;
  if (!bytes(id, 32) || !bytes(transactionsRoot, 32) || !Array.isArray(section) || (header !== undefined && !bytes(header))) {
    throw new EncodingError("invalid exhaustion block");
  }
  const owned = section.map(t => {
    if (t === null || typeof t !== "object" || !bytes(t.unsigned) || !bytes(t.witnessId)) throw new EncodingError("invalid exhaustion block");
    return Object.freeze({ unsigned: copyBytes(t.unsigned), witnessId: copyBytes(t.witnessId) });
  });
  return Object.freeze({ id: copyBytes(id), transactionsRoot: copyBytes(transactionsRoot), section: Object.freeze(owned),
    ...(header === undefined ? {} : { header: copyBytes(header) }) });
}

/** The map from the set's start, extended a period at a time; it answers keys at its latest fold only. Two maps are
 * kept: one at the latest fold, which answers keys while the next period proves (hours, with a pool), and one at the
 * last block appended, from which periods are cut. Calls to `extend` run one after another. */
export class ExhaustionServer implements ExhaustionSupplier {
  readonly name: string;
  readonly #options: ExhaustionServerOptions;
  /** The map at the last block appended. */
  readonly #ahead: SubjectMap;
  /** The map at the latest fold's end (the start before any). */
  readonly #served: SubjectMap;
  /** Each block above the start, by height: its root and section, for transactions with their inclusion paths. */
  readonly #blocks = new Map<bigint, ServedBlock>();
  #fold: Fold | undefined;
  /** A period appended to the map whose proof has not been made yet. */
  #pending: { readonly inputs: FoldInputs; readonly period: ServerPeriod } | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ExhaustionServerOptions) {
    this.#options = options;
    this.name = options.name ?? "exhaustion server";
    this.#ahead = new SubjectMap(options.start.id, options.start.height);
    this.#served = new SubjectMap(options.start.id, options.start.height);
  }

  /** The latest fold, if any. */
  get latest(): Fold | undefined { return this.#fold; }
  /** The height the map is at: the start's, or the last block appended. */
  get height(): bigint { return this.#ahead.end.height; }

  /** A period appended whose fold is not proved yet (its proof failed), which the next `extend` proves first. */
  get pending(): FoldInputs | undefined { return this.#pending?.inputs; }

  /** Append `blocks`, the next after the map's end in order, and seal a fold at the last: a period. A pending period is
   * proved first; with no blocks, only it is. Every block is checked before any is appended. */
  extend(blocks: readonly ServedBlock[]): Promise<Fold> {
    // Read and checked now, not when the call's turn comes (hours later behind a pool).
    let owned: readonly ServedBlock[];
    try {
      if (!Array.isArray(blocks)) throw new EncodingError("invalid exhaustion period");
      owned = blocks.map(ownBlock);
    } catch (error) { return Promise.reject(error); }
    const run = this.#queue.then(() => this.#extend(owned));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #extend(owned: readonly ServedBlock[]): Promise<Fold> {
    if (this.#pending !== undefined) await this.#seal();
    if (owned.length === 0) {
      if (this.#fold !== undefined) return this.#fold;
      throw new EncodingError("a period holds at least one block");
    }
    if (this.#ahead.end.height + BigInt(owned.length) >= 1n << 32n) throw new EncodingError("exhaustion height out of range");
    const begin = { ...this.#ahead.end, root: this.#ahead.root }, updates: MapUpdate[] = [];
    for (const own of owned) {
      updates.push(...this.#ahead.appendBlock(own.id, own.section.map(t => t.unsigned)));
      if (this.#options.block === undefined) this.#blocks.set(this.#ahead.end.height, own);
    }
    const end = this.#ahead.end, start = this.#options.start;
    const inputs: FoldInputs = Object.freeze({ startId: copyBytes(start.id), startHeight: start.height, endId: end.id, endHeight: end.height,
      mapRoot: this.#ahead.root, foldKeyHash: this.#options.foldKeyHash });
    this.#pending = { inputs, period: Object.freeze({ begin, blocks: Object.freeze(owned), updates: Object.freeze(updates), previous: this.#fold }) };
    return this.#seal();
  }

  /** Prove the pending period's fold, then bring the served map to its end; on failure it stays pending. */
  async #seal(): Promise<Fold> {
    const { inputs, period } = this.#pending!, first = period.previous === undefined;
    // `prove` is handed copies: what it does to them cannot reach the served map or the transactions served.
    const handed: ServerPeriod = { begin: { ...period.begin, id: copyBytes(period.begin.id) }, blocks: period.blocks.map(ownBlock),
      updates: period.updates.map(u => ({ entry: { ...u.entry, subject: copyBytes(u.entry.subject) }, before: { ...u.before, siblings: [...u.before.siblings] } })),
      previous: period.previous === undefined ? undefined : { ...period.previous,
        inputs: { ...period.previous.inputs, startId: copyBytes(period.previous.inputs.startId), endId: copyBytes(period.previous.inputs.endId) },
        proof: copyBytes(period.previous.proof) } };
    const proof = copyBytes(await this.#options.prove(first, inputs, handed));
    for (const block of period.blocks) this.#served.appendBlock(block.id, block.section.map(t => t.unsigned));
    this.#fold = Object.freeze({ first, inputs, proof });
    this.#pending = undefined;
    return this.#fold;
  }

  async fold(maxHeight: bigint): Promise<Fold | undefined> {
    const fold = this.#fold;
    return fold !== undefined && fold.inputs.endHeight <= maxHeight ? fold : undefined;
  }

  async key(endHeight: bigint, key: bigint, from: bigint): Promise<KeyAnswer | undefined> {
    // The served map moves only when a fold is sealed, so it stands at the latest fold's end.
    if (this.#fold === undefined || this.#fold.inputs.endHeight !== endHeight || this.#served.end.height !== endHeight) return undefined;
    return { path: this.#served.path(key), entries: this.#served.entries(key, from) };
  }

  async transaction(height: bigint, position: bigint): Promise<IncludedTransaction | undefined> {
    if (height > this.#ahead.end.height) return undefined;
    const block = this.#options.block?.(height) ?? this.#blocks.get(height), j = Number(position);
    const unsigned = block?.section[j]?.unsigned;
    if (block === undefined || unsigned === undefined) return undefined;
    const steps = sectionInclusionPath(block.section, block.transactionsRoot, j);
    return steps === undefined ? undefined : { unsigned: copyBytes(unsigned), steps };
  }
}
