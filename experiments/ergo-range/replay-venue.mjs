// Reader-selected candidate Ergo evidence adapter, outside the source-neutral
// package. Headers are a reader trust input: authentication remains unproven.
import { EvidenceRefusal } from "../../scripts/pool/delivery/evidence-reader.mjs";

// Local experiment budgets, not Ergo consensus. The model hashes and frames each transaction once, in time linear in
// its length, so these also bound a read's work.
export const RAW_EVIDENCE_LIMITS = Object.freeze({ maxBytes: 8_388_608n, maxBlocks: 256n, maxTransactions: 1024n });
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const brandOf = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const lengthOf = Object.getOwnPropertyDescriptor(typed, "length").get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const values = Uint8Array.prototype.values;
const bytes = value => brandOf.call(value) === "Uint8Array";
const u64 = value => typeof value === "bigint" && value >= 0n && value < (1n << 64n);
// A supplied transaction is its 31-byte witness id followed by its unsigned bytes, the two things a block commits to.
const WITNESS_ID_BYTES = 31;

/** Bind reader-chosen profile, headers and answer budget. Only block bytes
 * are supplier evidence, each transaction as its witness id and unsigned
 * bytes; supplied ids, outputs, clocks and answers are unused. Raw evidence
 * is bounded and owned before the model reads any of it. A transaction the
 * profile's framer does not read carries no record and withholds nothing. */
export function ergoReplayVenue(profile, evidence, codec, rangeLimits, rawLimits = RAW_EVIDENCE_LIMITS) {
  const { maxBytes, maxBlocks, maxTransactions } = rawLimits;
  const { maxBytes: answerBytes, maxEntries } = rangeLimits;
  if (![maxBytes, maxBlocks, maxTransactions, answerBytes, maxEntries].every(u64)) throw new TypeError("invalid Ergo reader budget");
  const answerLimits = Object.freeze({ maxBytes: answerBytes, maxEntries });
  if (evidence === null || typeof evidence !== "object") throw new EvidenceRefusal("unresolved-evidence");
  const { headers, blocks } = evidence;
  if (!Array.isArray(headers) || !Array.isArray(blocks)) throw new EvidenceRefusal("unresolved-evidence");
  const headerCount = headers.length, blockCount = blocks.length;
  if (BigInt(headerCount) > maxBlocks || BigInt(blockCount) > maxBlocks) throw new codec.RangeLimitError("Ergo evidence block budget exceeded");
  let size = 0n, count = 0n;
  const own = value => {
    if (!bytes(value)) throw new EvidenceRefusal("unresolved-evidence");
    // Intrinsics ignore shadowed length/buffer properties. ArrayBuffer's
    // getter refuses actual shared storage; values validates detached and
    // out-of-bounds resizable views even when their apparent length is zero.
    let length;
    try { bufferLength.call(bufferOf.call(value)); values.call(value); length = lengthOf.call(value); }
    catch (error) { if (error instanceof TypeError) throw new EvidenceRefusal("unresolved-evidence"); throw error; }
    size += BigInt(length);
    if (size > maxBytes) throw new codec.RangeLimitError("Ergo raw evidence byte budget exceeded");
    // Copy now, before another supplier getter can resize, detach or mutate it.
    return new Uint8Array(value);
  };
  // Small reader-owned inputs are copied before reading supplier containers.
  const { reference, anchor, depth, scripts } = profile;
  // The reference context goes through as named, so the identity is the one the profile hashes (ownErgoProfile checks it).
  const ownedProfile = { ...(reference === undefined ? {} : { reference }), anchor: own(anchor), depth,
    scripts: Object.fromEntries([1, 2, 3, 4].map(kind => [kind, own(scripts[kind])])) };
  const ownedHeaders = [];
  for (let i = 0; i < headerCount; i++) {
    const header = headers[i];
    if (header === null || typeof header !== "object") throw new EvidenceRefusal("unresolved-evidence");
    const { id, parentId, height, version, transactionsRoot } = header;
    ownedHeaders.push({ id: own(id), parentId: own(parentId), height, version, transactionsRoot: own(transactionsRoot) });
  }
  // Charge each intrinsic view before copying, and finish owning all input
  // before the model reads it. Total allocated source bytes cannot exceed the budget.
  const ownedBlocks = [];
  for (let i = 0; i < blockCount; i++) {
    const block = blocks[i];
    if (block === null || typeof block !== "object") continue;
    const { headerId, transactions } = block;
    if (!Array.isArray(transactions)) continue;
    const length = transactions.length;
    count += BigInt(length);
    if (count > maxTransactions) throw new codec.RangeLimitError("Ergo evidence transaction budget exceeded");
    const ownedId = bytes(headerId) ? own(headerId) : undefined;
    let valid = ownedId !== undefined && ownedId.length === 32;
    const owned = [];
    for (let j = 0; j < length; j++) {
      const transaction = transactions[j];
      if (!bytes(transaction)) { valid = false; continue; }
      const copy = own(transaction);
      // Too short to carry a witness id and a transaction: the block is malformed and is passed over like any other.
      if (copy.length <= WITNESS_ID_BYTES) { valid = false; continue; }
      owned.push({ witnessId: copy.subarray(0, WITNESS_ID_BYTES), unsigned: copy.subarray(WITNESS_ID_BYTES) });
    }
    if (valid) ownedBlocks.push({ headerId: ownedId, transactions: owned });
  }
  // Root failures, unframed transactions and unavailable sections are resolved only by the model.
  const verifier = codec.ergoRangeVerifier(ownedProfile, { headers: ownedHeaders, blocks: ownedBlocks });
  if (verifier === undefined) return undefined;
  return Object.freeze({ evidenceKind: "candidate-ergo-profile-synthetic-headers",
    range: request => verifier.range(request, answerLimits),
    witnessedIndex: () => verifier.witnessedIndex(), lag: () => verifier.lag() });
}
