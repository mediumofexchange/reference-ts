// Succession (§C2): who serves a backing, once the key E names no longer does.
//
// "**A replacement is itself a witnessed object.** It is signed by whoever
// **E**'s rule names, the backer by default, states the role, the successor and
// the effective index, and is published always at the successor venue and at the
// old one while it serves. Each replacement names its predecessor, so the chain
// from the original terms is walkable. Its effective index is no earlier than
// the index at which it is itself witnessed, and it takes effect only from the
// first index at which it has published its own commitment over a spent set it
// serves in full. Until then the predecessor's last commitment governs, no new
// co-signatures issue, and accrual against the incumbent continues... From the
// effective index the old attester's co-signatures stop counting, which is why a
// wallet verifies the chain rather than the key it remembers."
//
// **E's operator is the genesis value, not a mutable field.** It sits inside the
// name and invariant 1 forbids an edit, so a replacement does not change it — it
// supersedes it, on a record anyone can walk. That is what makes "the chain from
// the original terms is walkable" the literal mechanism rather than a metaphor,
// and it is why the venue and the operator can "move only under its replacement
// rule" while both stay inside the hash.
//
// The chain is **hash-linked**: each replacement names its predecessor by the
// hash of that predecessor's own canonical message, and the first link names the
// backing itself. A fork cannot be spliced in unseen, and walking backwards from
// any link reaches the original terms or nothing.
//
// Canonical message, signed by the key E's replacement clause names:
//
//   context "moe/replacement/v1"
//     || 32-byte backing name
//     || u8 role (0x01 operator)
//     || 32-byte successor
//     || 32-byte predecessor (the backing name at the first link)
//     || u64 effective index
//
// **One role is defined, and the field is still written.** Only the operator can
// be replaced here; the venue is the clock every deadline is read against, and
// moving it is a second clock, which is the conflation slice 5 removed. Writing
// the role anyway is what stops a replacement of the operator being read later
// as a replacement of something else.
//
// Everything below is a verifier: the bytes come from whoever publishes them.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Backing } from "./backing.js";
import { ByteReader, ByteWriter, compareBytes, copyBytes } from "./bytes.js";
import { REPLACEMENT_CONTEXT } from "./contexts.js";
import { verifySignatureStrict } from "./keys.js";
import { answering, type Venue } from "./venue.js";

/** The only role this slice can replace. */
export const ROLE_OPERATOR = 0x01;

export interface Replacement {
  /** Which role is being replaced. Only ROLE_OPERATOR is served here. */
  readonly role: number;
  /** The key taking over. */
  readonly successor: Uint8Array;
  /** The previous link: that replacement's own hash, or the backing name. */
  readonly predecessor: Uint8Array;
  /** The witnessed index from which the successor may take over. */
  readonly effective: bigint;
  /** The signature of the key E's replacement clause names. */
  readonly signature: Uint8Array;
}

/** A replacement together with the venue's own word on when it was witnessed. */
export interface WitnessedReplacement {
  readonly replacement: Replacement;
  readonly at: bigint;
}

/** The bytes the replacement rule's key signs. Throws on a malformed field. */
export function replacementMessage(backingName: Uint8Array, replacement: Replacement): Uint8Array {
  const w = new ByteWriter();
  w.context(REPLACEMENT_CONTEXT);
  w.key32(backingName, "backing name");
  w.u8(replacement.role);
  w.key32(replacement.successor, "successor key");
  w.key32(replacement.predecessor, "predecessor");
  w.u64(replacement.effective);
  return w.finish();
}

/** A replacement's identity, and the value its successor names as predecessor. */
export function replacementHash(backingName: Uint8Array, replacement: Replacement): Uint8Array {
  return sha256(replacementMessage(backingName, replacement));
}

/**
 * A replacement as a **record**, for a venue that stores bytes: the backing it
 * replaces the operator of, the signed fields, then the signature.
 *
 * **The backing name is in the record**, as it is in an operation's, so a record
 * stands alone. A chain finds a box and has to know what it is without being
 * told; a record that needed its filing to say which backing it belongs to would
 * be one more thing an implementation could get wrong. It costs 32 bytes and it
 * is already inside the signature, so it cannot disagree with itself.
 */
export function encodeReplacement(
  backingName: Uint8Array,
  replacement: Replacement,
): Uint8Array {
  const w = new ByteWriter();
  w.key32(backingName, "backing name");
  w.u8(replacement.role);
  w.key32(replacement.successor, "successor key");
  w.key32(replacement.predecessor, "predecessor");
  w.u64(replacement.effective);
  w.fixed(replacement.signature, 64, "signature");
  return w.finish();
}

/**
 * Strict inverse of encodeReplacement, handing back the backing it names.
 * Throws EncodingError on anything else.
 */
export function decodeReplacement(bytes: Uint8Array): {
  readonly backingName: Uint8Array;
  readonly replacement: Replacement;
} {
  const r = new ByteReader(bytes);
  const backingName = r.raw(32);
  const role = r.u8();
  const successor = r.raw(32);
  const predecessor = r.raw(32);
  const effective = r.u64();
  const signature = r.raw(64);
  r.expectEnd();
  return { backingName, replacement: { role, successor, predecessor, effective, signature } };
}

/**
 * Whether this is a well-formed replacement of this backing's operator, signed
 * by the key E's replacement clause names.
 *
 * A backing whose E declares no replacement clause cannot be replaced at all
 * (§C2b: "Whether a sequencer can be replaced at all is answered in E"), so
 * every replacement of it answers false however well it is signed.
 */
export function isSignedReplacement(backing: Backing, replacement: Replacement): boolean {
  try {
    const rule = backing.evidence.replacementRule;
    if (rule === undefined) return false;
    if (replacement.role !== ROLE_OPERATOR) return false;
    const message = replacementMessage(backing.name, replacement);
    return verifySignatureStrict(replacement.signature, message, rule);
  } catch {
    return false;
  }
}

/** One link of a walked chain: who takes over, and the index they take over at. */
export interface Succession {
  readonly operator: Uint8Array;
  /** The index from which this operator is in force. */
  readonly from: bigint;
  /**
   * What the next link must name as its predecessor: the backing itself at
   * genesis, and otherwise the hash of the replacement that made this link.
   */
  readonly link: Uint8Array;
}

/**
 * The chain of operators this backing has had, in force order, starting with the
 * key E names.
 *
 * Walked forward from the backing itself, taking at each step the **earliest
 * USABLE** replacement that names the current link as its predecessor: the
 * earliest whose successor qualified — committed at or after its witnessing,
 * no later than the index at which the next distinct candidate at the link was
 * witnessed, and with a force index no earlier than the incumbent's (a replay
 * of a candidate's bytes is the same candidate at its first witnessing, so a
 * stranger manufactures no boundary with the rule-holder's own signature).
 * Earliest still wins
 * where it qualified (§C2, witnessing pins order: the one the rule-holder
 * published first is the one it chose first), but a successor that never
 * qualifies no longer ends the chain: its window closes the moment the
 * rule-holder names another, and the walk passes over it — so naming a dead
 * successor is recoverable, and re-naming the incumbent is the rule-holder's
 * revocation of a successor it regrets (the 2026-08-22 audit, question 2).
 * The chain extends and no past read ever moves; what still ends the walk
 * with the incumbent governing is the one candidate whose window is open —
 * the last, uncommitted — and a malformed record (the cycle guard).
 *
 * A link takes force at the LATER of two indices, which is §C2's own two-stage
 * rule: the effective index it declares, and the first index at which the
 * successor published a commitment of its own. "Until then the predecessor's
 * last commitment governs."
 *
 * What is not checked, and cannot be from the venue alone: that the successor's
 * commitment is "over a spent set it serves in full". A commitment is a root, so
 * whether it carries this backing is unreadable without the served state — §C2
 * now says so, on invariant 23's standing rule that anything checked against a
 * commitment has to be served. committedLogFor answers exactly that question, but
 * only of a state it is handed, and this walk has none, so the bound stays the
 * bound.
 *
 * What IS checked is that the commitment came at or after the handover was
 * witnessed, so it is at least one the successor could have made for this
 * backing. Slice 13 found that bound necessary and §C2 now carries it: "without
 * that bound a successor already operating something else answers with a
 * commitment made before anyone named it."
 */
export function successionOf(backing: Backing, venue: Venue): Succession[] {
  const chain: Succession[] = [
    { operator: copyBytes(backing.evidence.operator), from: 0n, link: copyBytes(backing.name) },
  ];
  // The fallback is the chain as far as it got, which at minimum is the key E
  // names — and `answering` is what stops a venue's refusal being mistaken for
  // that, since the genesis chain is a real answer about who serves.
  return answering(() => {
    if (backing.evidence.replacementRule === undefined) return chain;
    const witnessed = venue
      .replacementsFor(backing.name)
      .filter((w) => isSignedReplacement(backing, w.replacement))
      // A replacement cannot take force before it was witnessed (§C2), and one
      // declaring an earlier index is refused rather than corrected: the
      // rule-holder does not get to backdate a handover.
      .filter((w) => w.replacement.effective >= w.at);

    const seen = new Set<string>([bytesToHex(backing.name)]);
    let link = backing.name;
    for (;;) {
      // **The earliest USABLE candidate at this link** — a dead successor does
      // not end the chain (the 2026-08-22 audit, question 2; Bob's decision:
      // usable is "a link that committed before the next candidate at the same
      // predecessor was witnessed"). The old walk took the earliest candidate
      // outright and stopped wherever its successor never committed, so a
      // second replacement at the same link was unreachable forever and the
      // rule-holder could not recover from naming a dead successor
      // (audit-B-3).
      //
      // A candidate's window is [its witnessing, the NEXT candidate's
      // witnessing) — the next in the venue's own order, a sibling at the very
      // same index included, so a same-index sibling leaves a ONE-INDEX
      // window (the review round's first draft gave same-index candidates a
      // shared window, and a later naming then unlocked one RETROACTIVELY,
      // moving force at a past index — the very instability this rule exists
      // to forbid). And the window closes only against a commitment STRICTLY
      // AFTER its boundary's index: a qualification standing at the boundary's
      // own index stands, since the boundary is judged against the record
      // strictly before its index and must not kill what stood beside it —
      // the tie goes against the party with the motive to close (slice 8's
      // direction; the review round showed the other tie erasing a successor
      // that had already taken over and served, orphaning its receipts). A
      // candidate is passed over where it is conclusively decided:
      //   - it names the incumbent — not a handover, and never one ("the old
      //     attester's co-signatures stop counting" must never mean its own);
      //     as the next candidate it still bounds earlier windows, which is
      //     the rule-holder's one way to revoke a successor it regrets;
      //   - its first commitment (at or after its own witnessing — one made
      //     before anyone named it cannot be the one §C2 asks for) landed
      //     strictly after the next candidate's index, or never: the next
      //     replacement was made against a record in which this successor had
      //     not qualified;
      //   - or its force index would precede the incumbent's (a rule-holder's
      //     effective-index mistake): force is fixed once the commitment is,
      //     so this too is decided, and a later candidate with an effective at
      //     or past the incumbent's force can still recover the link.
      // The last candidate uncommitted is merely undecided, and ends the walk
      // with the incumbent governing: every window before it is closed, and
      // its own is still open.
      //
      // Once the next candidate is witnessed, whether this one qualified is
      // fixed forever — and a candidate becomes usable only at its own
      // commitment, never before any index a reader has already read — so
      // the walk is stable: the chain extends, and no past read ever moves.
      //
      // Candidates are the DISTINCT replacements at this link, each at its
      // FIRST witnessing: a replacement is one act of the rule-holder, and
      // anyone may republish its bytes — dated by the replay, a stranger
      // could manufacture a boundary and kill an honest successor's window
      // with the rule-holder's own signature (found reviewing this slice).
      const candidates: WitnessedReplacement[] = [];
      {
        const distinct = new Set<string>();
        for (const w of witnessed
          .filter((w) => compareBytes(w.replacement.predecessor, link) === 0)
          .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
          const hash = bytesToHex(replacementHash(backing.name, w.replacement));
          if (distinct.has(hash)) continue;
          distinct.add(hash);
          candidates.push(w);
        }
      }
      const incumbent = chain[chain.length - 1] as Succession;
      let chosen: { successor: Uint8Array; hash: Uint8Array; from: bigint } | undefined;
      for (let i = 0; i < candidates.length && chosen === undefined; i++) {
        const candidate = candidates[i] as WitnessedReplacement;
        const successor = candidate.replacement.successor;
        if (compareBytes(successor, incumbent.operator) === 0) continue;
        const boundary = candidates[i + 1]?.at;
        const committed = venue.firstCommitmentFor(successor, candidate.at);
        if (committed === undefined || (boundary !== undefined && committed > boundary)) continue;
        const from = candidate.replacement.effective > committed ? candidate.replacement.effective : committed;
        // In force no earlier than the incumbent: a chain that went backwards
        // would have two operators in force at one index.
        if (from < incumbent.from) continue;
        chosen = { successor, hash: replacementHash(backing.name, candidate.replacement), from };
      }
      if (chosen === undefined) return chain;

      // A hash cycle cannot be built (invariant 5's reasoning), so this guards a
      // malformed record rather than a real cycle — and it guarantees the walk
      // terminates on any input at all, which a verifier needs.
      if (seen.has(bytesToHex(chosen.hash))) return chain;
      seen.add(bytesToHex(chosen.hash));

      chain.push({ operator: copyBytes(chosen.successor), from: chosen.from, link: copyBytes(chosen.hash) });
      link = chosen.hash;
    }
  }, chain);
}

/**
 * The operator in force at this index — the key a wallet must check against
 * rather than the one it remembers (§C2).
 */
export function operatorAt(backing: Backing, venue: Venue, index: bigint): Uint8Array {
  return operatorIn(successionOf(backing, venue), index);
}

/**
 * The same question asked of a chain already walked.
 *
 * Walking it verifies a signature per published replacement, and anyone may
 * publish one for free — so a caller reading the chain at many indices walks it
 * once and asks here, rather than paying that per index. The recovery walk does
 * exactly that: it reads the operator at every operation published against the
 * backing, and both counts are the adversary's to grow.
 */
export function operatorIn(chain: readonly Succession[], index: bigint): Uint8Array {
  let inForce = chain[0] as Succession;
  for (const link of chain) if (link.from <= index) inForce = link;
  return copyBytes(inForce.operator);
}

/**
 * Every key that has served this backing, in force order.
 *
 * Membership rather than time, because the acts a receipt attests to carry no
 * index: a receipt names an operation and a position, never when it was signed.
 * So a retired operator's co-signature over an operation its own log really held
 * stays evidence of what it accepted while it served. What stops it counting for
 * anything current is that the state of record is the operator in force now, and
 * a receipt is read against that log (receiptStatus).
 */
export function operatorsOf(backing: Backing, venue: Venue): Uint8Array[] {
  return successionOf(backing, venue).map((link) => copyBytes(link.operator));
}

/**
 * Whether this key is A successor named at the chain's tip, and not yet in
 * force — live or already passed over: several candidates can be named at one
 * link, and one whose window has closed still reads true here. That is a
 * permission to prepare, deliberately: force is the chain's alone, so a
 * passed-over candidate that registers, takes over and commits has co-signed
 * noise and is refused at every door (`inForce`), harming nobody.
 *
 * §C2's two-stage handover has a gap between the two stages that somebody has to
 * live in: "it takes effect only from the first index at which it has published
 * its own commitment", and a successor cannot publish a commitment over a state
 * it was never allowed to take on. So a named successor may serve — take over
 * the predecessor's committed state and commit it — while "no new co-signatures
 * issue" until it is in force.
 */
export function isNamedSuccessor(backing: Backing, venue: Venue, key: Uint8Array): boolean {
  return answering(() => {
    if (backing.evidence.replacementRule === undefined) return false;
    const chain = successionOf(backing, venue);
    const tip = chain[chain.length - 1] as Succession;
    if (compareBytes(tip.operator, key) === 0) return false;
    return venue
      .replacementsFor(backing.name)
      .some(
        (w) =>
          isSignedReplacement(backing, w.replacement) &&
          w.replacement.effective >= w.at &&
          compareBytes(w.replacement.predecessor, tip.link) === 0 &&
          compareBytes(w.replacement.successor, key) === 0,
      );
  }, false);
}

/** Whether this key is one of the operators this backing has had. */
export function isAnOperator(backing: Backing, venue: Venue, key: Uint8Array): boolean {
  return answering(() => {
    return operatorsOf(backing, venue).some((operator) => compareBytes(operator, key) === 0);
  }, false);
}
