// A supplier's side of succinct-read §4 (`moe/succinct/v1`): the subject map over blocks handed to it in order, folds
// sealed at the ends it chooses, paths and entries at the latest fold, and transactions with inclusion paths. It is
// trusted by no reader (§4.7), which recomputes every value, so it keeps no evidence of its own beyond what it serves.
//
// A fold proof comes from `prove`: a prover pool's for an adopted set, or a test set's hash (`testExhaustionSet`),
// which attests nothing. The server computes the map natively and hands `prove` the inputs a fold would carry.
import { copyBytes, EncodingError } from "./bytes.js";
import {
  sectionInclusionPath, SubjectMap, type ExhaustionSupplier, type Fold, type FoldInputs, type IncludedTransaction, type KeyAnswer,
} from "./ergo-exhaustion.js";
import type { ErgoTransactionView } from "./ergo-profile.js";

/** A block as the server is handed it, after its caller authenticated the section against the header and the header
 * against its parent. */
export interface ServedBlock { readonly id: Uint8Array; readonly transactionsRoot: Uint8Array; readonly section: readonly ErgoTransactionView[] }

export interface ExhaustionServerOptions {
  /** The set's start header (§6). */
  readonly start: { readonly id: Uint8Array; readonly height: bigint };
  /** The next fold's key hash, every fold's `foldKeyHash` (§4.3). */
  readonly foldKeyHash: bigint;
  /** A fold proof over these inputs: the first fold's where `first`, else a next fold's over the previous. */
  prove(first: boolean, inputs: FoldInputs): Promise<Uint8Array> | Uint8Array;
  readonly name?: string;
  /** The block at a height, where the caller keeps blocks itself (a view's rows): the server then keeps none. */
  block?(height: bigint): ServedBlock | undefined;
}

/** The map from the set's start, extended a period at a time; it answers keys at its latest fold only. */
export class ExhaustionServer implements ExhaustionSupplier {
  readonly name: string;
  readonly #options: ExhaustionServerOptions;
  readonly #map: SubjectMap;
  /** Each block above the start, by height: its root and section, for transactions with their inclusion paths. */
  readonly #blocks = new Map<bigint, ServedBlock>();
  #fold: Fold | undefined;

  constructor(options: ExhaustionServerOptions) {
    this.#options = options;
    this.name = options.name ?? "exhaustion server";
    this.#map = new SubjectMap(options.start.id, options.start.height);
  }

  /** The latest fold, if any. */
  get latest(): Fold | undefined { return this.#fold; }
  /** The height the map is at: the start's, or the last block appended. */
  get height(): bigint { return this.#map.end.height; }

  /** Append `blocks`, the next after the map's end in order, and seal a fold at the last: a period. */
  async extend(blocks: readonly ServedBlock[]): Promise<Fold> {
    if (blocks.length === 0) throw new EncodingError("a period holds at least one block");
    for (const block of blocks) {
      const owned = { id: copyBytes(block.id), transactionsRoot: copyBytes(block.transactionsRoot),
        section: block.section.map(t => ({ unsigned: copyBytes(t.unsigned), witnessId: copyBytes(t.witnessId) })) };
      this.#map.appendBlock(owned.id, owned.section.map(t => t.unsigned));
      if (this.#options.block === undefined) this.#blocks.set(this.#map.end.height, owned);
    }
    const end = this.#map.end, start = this.#options.start, first = this.#fold === undefined;
    const inputs: FoldInputs = { startId: copyBytes(start.id), startHeight: start.height, endId: end.id, endHeight: end.height,
      mapRoot: this.#map.root, foldKeyHash: this.#options.foldKeyHash };
    this.#fold = Object.freeze({ first, inputs: Object.freeze(inputs), proof: copyBytes(await this.#options.prove(first, inputs)) });
    return this.#fold;
  }

  async fold(maxHeight: bigint): Promise<Fold | undefined> {
    const fold = this.#fold;
    return fold !== undefined && fold.inputs.endHeight <= maxHeight ? fold : undefined;
  }

  async key(endHeight: bigint, key: bigint, from: bigint): Promise<KeyAnswer | undefined> {
    // The map moves only when a fold is sealed, so it stands at the latest fold's end.
    if (this.#fold === undefined || this.#fold.inputs.endHeight !== endHeight) return undefined;
    return { path: this.#map.path(key), entries: this.#map.entries(key, from) };
  }

  async transaction(height: bigint, position: bigint): Promise<IncludedTransaction | undefined> {
    if (height > this.#map.end.height) return undefined;
    const block = this.#options.block?.(height) ?? this.#blocks.get(height), j = Number(position);
    const unsigned = block?.section[j]?.unsigned;
    if (block === undefined || unsigned === undefined) return undefined;
    const steps = sectionInclusionPath(block.section, block.transactionsRoot, j);
    return steps === undefined ? undefined : { unsigned: copyBytes(unsigned), steps };
  }
}
