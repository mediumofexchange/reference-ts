// Every domain-separation tag in the system, on one screen.
//
// A tag prefixes the bytes signed for one message type, so a signature made
// for one purpose can never verify for another. A collision here is a
// signature-forgery class, which is why the complete list lives in one file
// rather than beside each use: no tag may be a prefix of another, and that is
// checkable only by reading them together.
//
//   moe/backing-signature/v1   the obligor's signature over a backing's name
//   moe/issuance/v1            a backer authorising issuance
//   moe/transfer/v1            a holder moving units
//   moe/burn/v1                a holder destroying units
//   moe/receipt/v3             an operator co-signing an accepted operation
//                              (v3 makes the era the COMMITMENT — one more
//                              than the sequence its operator last signed —
//                              where v2 named the index that commitment was
//                              witnessed at: same width, different meaning,
//                              which is the collision a tag exists to prevent)
//   moe/commitment/v2          an operator committing to a named snapshot directory
//   moe/demand/v1              a holder presenting claims for payment
//   moe/acceptance/v1          a backer answering a demand
//   moe/release/v2             a holder settling an accepted demand
//   moe/withdrawal/v2          a holder ending an unanswered demand
//                              (v2 added the record's holder: a lock is keyed
//                              by (attempt, holder), so the message has to name
//                              which record it ends and not only its hash)
//   moe/lock/v2                a holder reserving units for an atomic attempt
//                              (v2 added the salt: a venue-naming lock's attempt
//                              id is the hash of the attempt's terms, and the
//                              salt is the one term not already in the message)
//   moe/attempt/v1             the terms an attempt id is the hash of
//   moe/commit/v1              a holder committing one attempt, at every sequencer
//   moe/replacement/v1         E's rule naming a successor operator
//   moe/revocation/v1          K withdrawing its own authority to issue
//
// The shielded pool's construction (pool-v2) hashes and signs under its own
// family, none a prefix of another or of the tags above:
//
//   moe/pool/v2/config         the configuration whose hash is the construction domain (§2)
//   moe/pool/v2/segment        a segment header, whose hash is the segment identity (§6)
//   moe/pool/v2/statement      what a statement asserts; K signs it for an issuance (§7)
//   moe/pool/v2/genesis        historyHash_0, from the segment identity (§9)
//   moe/pool/v2/history        historyHash_i (§9)
//   moe/pool/v2/receipt        the operator's acceptance evidence (§9)
//   moe/pool/v2/snapshot       a backing's snapshot digest in the directory (§9)
//   moe/pool/v2/spent/leaf     a spent-set leaf (§11)
//   moe/pool/v2/spent/node     a spent-set node (§11)
//
// Its candidate successor (pool-v3, pool-spent) has a family of its own:
//
//   moe/pool/v3/config         the candidate configuration (§11.1)
//   moe/pool/v3/statement      a statement (§5); a record opens with its bytes
//   moe/pool/v3/delivery       the delivery digest's preimage (pool-delivery C4.4)
//   moe/pool/v3/acceptance     a backer's acceptance of a demand (§6)
//   moe/pool/v3/release        a holder's release of an accepted demand (§6)
//   moe/pool/v3/withdrawal     a holder's withdrawal of an unanswered demand (§6)
//   moe/pool/v3/publication    a venue publication (§6)
//   moe/pool/v3/genesis        historyHash_0 (§7)
//   moe/pool/v3/history        historyHash_i (§7)
//   moe/pool/v3/evidence-seed  evidenceHash_0 (§7)
//   moe/pool/v3/evidence-link  evidenceHash_i (§7)
//   moe/pool/v3/snapshot       a backing's snapshot digest (§7)
//   moe/pool/v3/receipt        the operator's receipt (§7.2)
//   moe/pool/v3/segment        a segment header, whose hash is the segment identity (§8)
//   moe/pool/v3/fault-evidence a fault-evidence package (§9)
//   moe/pool/v3/trail          a served trail (§10)
//   moe/pool/v3/package        an evidence package (§12)
//   moe/pool/v3/range          a record-range answer (§13)
//   moe/pool/v3/spent/empty    the empty spent root (pool-spent C1.2.8)
//   moe/pool/v3/spent/leaf     a spent-root leaf
//   moe/pool/v3/spent/node     a spent-root node
//
// Two binary magics open hashed preimages too, and are held to the same rule:
// "MOEB" a backing's terms (its name is their hash) and "MOED" a directory
// (its root). The frozen transparent path keeps its own copy of "MOEB".

const encoder = new TextEncoder();
const tag = (s: string): Uint8Array => encoder.encode(s);

export const BACKING_SIGNATURE_CONTEXT = tag("moe/backing-signature/v1");
export const ISSUANCE_CONTEXT = tag("moe/issuance/v1");
export const TRANSFER_CONTEXT = tag("moe/transfer/v1");
export const BURN_CONTEXT = tag("moe/burn/v1");
export const RECEIPT_CONTEXT = tag("moe/receipt/v3");
export const COMMITMENT_CONTEXT = tag("moe/commitment/v2");
export const DEMAND_CONTEXT = tag("moe/demand/v1");
export const ACCEPTANCE_CONTEXT = tag("moe/acceptance/v1");
export const RELEASE_CONTEXT = tag("moe/release/v2");
export const WITHDRAWAL_CONTEXT = tag("moe/withdrawal/v2");
export const LOCK_CONTEXT = tag("moe/lock/v2");
export const ATTEMPT_CONTEXT = tag("moe/attempt/v1");
export const COMMIT_CONTEXT = tag("moe/commit/v1");
export const REPLACEMENT_CONTEXT = tag("moe/replacement/v1");
export const REVOCATION_CONTEXT = tag("moe/revocation/v1");
export const POOL_CONFIG_CONTEXT = tag("moe/pool/v2/config");
export const POOL_SEGMENT_CONTEXT = tag("moe/pool/v2/segment");
export const POOL_STATEMENT_CONTEXT = tag("moe/pool/v2/statement");
export const POOL_GENESIS_CONTEXT = tag("moe/pool/v2/genesis");
export const POOL_HISTORY_CONTEXT = tag("moe/pool/v2/history");
export const POOL_RECEIPT_CONTEXT = tag("moe/pool/v2/receipt");
export const POOL_SNAPSHOT_CONTEXT = tag("moe/pool/v2/snapshot");
export const POOL_SPENT_LEAF_CONTEXT = tag("moe/pool/v2/spent/leaf");
export const POOL_SPENT_NODE_CONTEXT = tag("moe/pool/v2/spent/node");
export const V3_CONFIG_CONTEXT = tag("moe/pool/v3/config");
export const V3_STATEMENT_CONTEXT = tag("moe/pool/v3/statement");
export const V3_DELIVERY_CONTEXT = tag("moe/pool/v3/delivery");
export const V3_ACCEPTANCE_CONTEXT = tag("moe/pool/v3/acceptance");
export const V3_RELEASE_CONTEXT = tag("moe/pool/v3/release");
export const V3_WITHDRAWAL_CONTEXT = tag("moe/pool/v3/withdrawal");
export const V3_PUBLICATION_CONTEXT = tag("moe/pool/v3/publication");
export const V3_GENESIS_CONTEXT = tag("moe/pool/v3/genesis");
export const V3_HISTORY_CONTEXT = tag("moe/pool/v3/history");
export const V3_EVIDENCE_SEED_CONTEXT = tag("moe/pool/v3/evidence-seed");
export const V3_EVIDENCE_LINK_CONTEXT = tag("moe/pool/v3/evidence-link");
export const V3_SNAPSHOT_CONTEXT = tag("moe/pool/v3/snapshot");
export const V3_RECEIPT_CONTEXT = tag("moe/pool/v3/receipt");
export const V3_SEGMENT_CONTEXT = tag("moe/pool/v3/segment");
export const V3_FAULT_EVIDENCE_CONTEXT = tag("moe/pool/v3/fault-evidence");
export const V3_TRAIL_CONTEXT = tag("moe/pool/v3/trail");
export const V3_PACKAGE_CONTEXT = tag("moe/pool/v3/package");
export const V3_RANGE_CONTEXT = tag("moe/pool/v3/range");
export const V3_SPENT_EMPTY_CONTEXT = tag("moe/pool/v3/spent/empty");
export const V3_SPENT_LEAF_CONTEXT = tag("moe/pool/v3/spent/leaf");
export const V3_SPENT_NODE_CONTEXT = tag("moe/pool/v3/spent/node");
export const TERMS_MAGIC = tag("MOEB");
export const DIRECTORY_MAGIC = tag("MOED");

/** Shared UTF-8 codecs. The decoder is strict and BOM-preserving so that
 *  decode(encode(s)) === s for every well-formed string. */
export const utf8Encoder = encoder;
export const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The property the whole scheme rests on: no tag is a prefix of another, so
 * writing a tag unframed as a message's first field can never let one message
 * type be read as another. Asserted at load rather than assumed, because a tag
 * added later is exactly when this would silently stop holding.
 */
const ALL_CONTEXTS = [
  BACKING_SIGNATURE_CONTEXT,
  ISSUANCE_CONTEXT,
  TRANSFER_CONTEXT,
  BURN_CONTEXT,
  RECEIPT_CONTEXT,
  COMMITMENT_CONTEXT,
  DEMAND_CONTEXT,
  ACCEPTANCE_CONTEXT,
  RELEASE_CONTEXT,
  WITHDRAWAL_CONTEXT,
  LOCK_CONTEXT,
  ATTEMPT_CONTEXT,
  COMMIT_CONTEXT,
  REPLACEMENT_CONTEXT,
  REVOCATION_CONTEXT,
  POOL_CONFIG_CONTEXT,
  POOL_SEGMENT_CONTEXT,
  POOL_STATEMENT_CONTEXT,
  POOL_GENESIS_CONTEXT,
  POOL_HISTORY_CONTEXT,
  POOL_RECEIPT_CONTEXT,
  POOL_SNAPSHOT_CONTEXT,
  POOL_SPENT_LEAF_CONTEXT,
  POOL_SPENT_NODE_CONTEXT,
  V3_CONFIG_CONTEXT,
  V3_STATEMENT_CONTEXT,
  V3_DELIVERY_CONTEXT,
  V3_ACCEPTANCE_CONTEXT,
  V3_RELEASE_CONTEXT,
  V3_WITHDRAWAL_CONTEXT,
  V3_PUBLICATION_CONTEXT,
  V3_GENESIS_CONTEXT,
  V3_HISTORY_CONTEXT,
  V3_EVIDENCE_SEED_CONTEXT,
  V3_EVIDENCE_LINK_CONTEXT,
  V3_SNAPSHOT_CONTEXT,
  V3_RECEIPT_CONTEXT,
  V3_SEGMENT_CONTEXT,
  V3_FAULT_EVIDENCE_CONTEXT,
  V3_TRAIL_CONTEXT,
  V3_PACKAGE_CONTEXT,
  V3_RANGE_CONTEXT,
  V3_SPENT_EMPTY_CONTEXT,
  V3_SPENT_LEAF_CONTEXT,
  V3_SPENT_NODE_CONTEXT,
  TERMS_MAGIC,
  DIRECTORY_MAGIC,
];

export function contextsArePrefixFree(tags: readonly Uint8Array[] = ALL_CONTEXTS): boolean {
  for (let i = 0; i < tags.length; i++) {
    for (let j = 0; j < tags.length; j++) {
      if (i === j) continue;
      const a = tags[i] as Uint8Array;
      const b = tags[j] as Uint8Array;
      if (a.length <= b.length && a.every((byte, k) => byte === b[k])) return false;
    }
  }
  return true;
}

if (!contextsArePrefixFree()) {
  throw new Error("domain-separation tags are not prefix-free");
}
