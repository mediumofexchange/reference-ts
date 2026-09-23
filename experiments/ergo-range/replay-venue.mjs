// Reader-selected candidate Ergo evidence adapter, outside the source-neutral
// package. Headers are a reader trust input: authentication remains unproven.
import { EvidenceRefusal } from "../../scripts/pool/delivery/evidence-reader.mjs";
import { decodeTransaction } from "./decoder.mjs";

// Local experiment budgets, not Ergo consensus or decoder memory limits.
export const RAW_EVIDENCE_LIMITS = Object.freeze({ maxBytes: 8_388_608n, maxBlocks: 256n, maxTransactions: 1024n });
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const brandOf = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const lengthOf = Object.getOwnPropertyDescriptor(typed, "length").get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const values = Uint8Array.prototype.values;
const bytes = value => brandOf.call(value) === "Uint8Array";
const u64 = value => typeof value === "bigint" && value >= 0n && value < (1n << 64n);

/** Bind reader-chosen profile, headers and answer budget. Only block bytes
 * are supplier evidence; supplied ids, outputs, clocks and answers are unused.
 * Raw evidence is bounded and owned before any transaction enters wasm.
 * A decoder refusal withholds its whole block, never proves absence there. */
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
  const { anchor, depth, scripts } = profile;
  const ownedProfile = { anchor: own(anchor), depth, scripts: Object.fromEntries([1, 2, 3, 4].map(kind => [kind, own(scripts[kind])])) };
  const ownedHeaders = [];
  for (let i = 0; i < headerCount; i++) {
    const header = headers[i];
    if (header === null || typeof header !== "object") throw new EvidenceRefusal("unresolved-evidence");
    const { id, parentId, height, version, transactionsRoot } = header;
    ownedHeaders.push({ id: own(id), parentId: own(parentId), height, version, transactionsRoot: own(transactionsRoot) });
  }
  // Charge each intrinsic view before copying, and finish owning all input
  // before decoding. Total allocated source bytes cannot exceed the budget.
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
    const raw = [];
    for (let j = 0; j < length; j++) {
      const transaction = transactions[j];
      if (!bytes(transaction)) { valid = false; continue; }
      raw.push(own(transaction));
    }
    if (valid) ownedBlocks.push({ headerId: ownedId, transactions: raw });
  }
  const decodedBlocks = [];
  for (const block of ownedBlocks) {
    const transactions = block.transactions.map(decodeTransaction);
    if (transactions.every(transaction => transaction !== undefined)) decodedBlocks.push({ headerId: block.headerId, transactions });
  }
  // Root failures and unavailable sections are resolved only by the model.
  const verifier = codec.ergoRangeVerifier(ownedProfile, { headers: ownedHeaders, blocks: decodedBlocks });
  if (verifier === undefined) return undefined;
  return Object.freeze({ evidenceKind: "candidate-ergo-profile-synthetic-headers",
    range: request => verifier.range(request, answerLimits),
    witnessedIndex: () => verifier.witnessedIndex(), lag: () => verifier.lag() });
}
