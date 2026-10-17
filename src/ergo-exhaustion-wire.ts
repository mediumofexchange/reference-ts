// The exhaustion's objects as a supplier and a reader exchange them (succinct-read §4.7): any framing they agree serves,
// and these bytes carry no protocol meaning. Every value is recomputed or compared by §4's rules after decoding, so a
// decoder only bounds what it reads and refuses a frame that is not one (`EncodingError`, a supplier's failure).
import { ByteReader, ByteWriter, EncodingError } from "./bytes.js";
import { MAP_DEPTH, MAX_INCLUSION_STEPS, type Fold, type IncludedTransaction, type KeyAnswer, type MapEntry } from "./ergo-exhaustion.js";
import { bytesToField, fieldToBytes } from "./pool/field.js";

/** A fold proof's bytes at most: an UltraHonk proof is about 14 KiB; this leaves room for any backend's. */
export const MAX_FOLD_PROOF_BYTES = 1 << 20;
/** An unsigned transaction at most: a block's section is bounded far below it. */
export const MAX_TRANSACTION_BYTES = 4 << 20;
/** Entries one key answer holds at most: a key's readers pay for every output naming it (§4.6), and past this a reader
 * reads natively. */
export const MAX_KEY_ENTRIES = 1 << 20;
/** The largest key answer: a path and the most entries. */
export const MAX_KEY_ANSWER_BYTES = 8 + 32 * (1 + MAP_DEPTH) + 4 + 56 * MAX_KEY_ENTRIES;

export function encodeFold(fold: Fold): Uint8Array {
  const w = new ByteWriter(), { inputs } = fold;
  w.u8(fold.first ? 1 : 0);
  w.key32(inputs.startId, "start id"); w.u64(inputs.startHeight);
  w.key32(inputs.endId, "end id"); w.u64(inputs.endHeight);
  w.key32(fieldToBytes(inputs.mapRoot), "map root"); w.key32(fieldToBytes(inputs.foldKeyHash), "fold key hash");
  w.lengthPrefixed(fold.proof);
  return w.finish();
}
export function decodeFold(bytes: Uint8Array): Fold {
  const r = new ByteReader(bytes), flag = r.u8();
  if (flag > 1) throw new EncodingError("a fold is first or next");
  const startId = r.raw(32), startHeight = r.u64(), endId = r.raw(32), endHeight = r.u64();
  const mapRoot = bytesToField(r.raw(32)), foldKeyHash = bytesToField(r.raw(32)), proof = r.lengthPrefixed(MAX_FOLD_PROOF_BYTES);
  r.expectEnd();
  return { first: flag === 1, inputs: { startId, startHeight, endId, endHeight, mapRoot, foldKeyHash }, proof };
}

export function encodeKeyAnswer(answer: KeyAnswer): Uint8Array {
  const w = new ByteWriter();
  w.u64(answer.path.count); w.key32(fieldToBytes(answer.path.chain), "chain value");
  if (answer.path.siblings.length !== MAP_DEPTH) throw new EncodingError("a path has 32 siblings");
  for (const sibling of answer.path.siblings) w.key32(fieldToBytes(sibling), "sibling");
  if (answer.entries.length > MAX_KEY_ENTRIES) throw new EncodingError("too many entries for one answer");
  w.u32(answer.entries.length);
  for (const entry of answer.entries) {
    w.key32(entry.subject, "subject"); w.u64(entry.height); w.u64(entry.position); w.u64(entry.output);
  }
  return w.finish();
}
/** A key answer; with `from`, the entries asked after (§4.4 step 2), one whose entries are not exactly the path's count
 * less `from` is refused before any entry is decoded. */
export function decodeKeyAnswer(bytes: Uint8Array, from?: bigint): KeyAnswer {
  const r = new ByteReader(bytes), count = r.u64(), chain = bytesToField(r.raw(32)), siblings: bigint[] = [];
  for (let l = 0; l < MAP_DEPTH; l++) siblings.push(bytesToField(r.raw(32)));
  const n = r.u32();
  if (n > MAX_KEY_ENTRIES) throw new EncodingError("too many entries for one answer");
  if (from !== undefined && BigInt(n) !== count - from) throw new EncodingError("an answer's entries are not the path's count after the first asked");
  const entries: MapEntry[] = [];
  for (let i = 0; i < n; i++) entries.push({ subject: r.raw(32), height: r.u64(), position: r.u64(), output: r.u64() });
  r.expectEnd();
  return { path: { count, chain, siblings }, entries };
}

export function encodeIncluded(included: IncludedTransaction): Uint8Array {
  const w = new ByteWriter();
  w.lengthPrefixed(included.unsigned);
  if (included.steps.length > MAX_INCLUSION_STEPS) throw new EncodingError("too many inclusion steps");
  w.u8(included.steps.length);
  for (const step of included.steps) {
    if (step === null) w.u8(0);
    else { w.u8(1); w.key32(step, "sibling"); }
  }
  return w.finish();
}
export function decodeIncluded(bytes: Uint8Array): IncludedTransaction {
  const r = new ByteReader(bytes), unsigned = r.lengthPrefixed(MAX_TRANSACTION_BYTES), n = r.u8(), steps: (Uint8Array | null)[] = [];
  if (n > MAX_INCLUSION_STEPS) throw new EncodingError("too many inclusion steps");
  for (let i = 0; i < n; i++) {
    const flag = r.u8();
    if (flag === 0) steps.push(null);
    else if (flag === 1) steps.push(r.raw(32));
    else throw new EncodingError("a step is a sibling or a lone child");
  }
  r.expectEnd();
  return { unsigned, steps };
}
