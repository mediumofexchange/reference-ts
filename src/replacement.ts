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
// Type-only: `commitment.ts` imports this module, and a value import here would
// close that into a runtime cycle. Erased at compile time, so it does not.
import type { Commitment } from "./commitment.js";
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
  /**
   * The successor's own signature, over the SAME message (§C2, 2026-08-29).
   * Naming somebody is not a power over them: signed by the rule-holder alone,
   * one published record made any commitment-publishing key the operator of
   * record of any backing, and its own next punctual commitment then proved a
   * fault against it. One message rather than two, so there is one record, one
   * domain tag and nothing that can fall out of step with itself.
   */
  readonly successorSignature: Uint8Array;
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
  w.fixed(replacement.successorSignature, 64, "successor signature");
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
  const successorSignature = r.raw(64);
  r.expectEnd();
  return {
    backingName,
    replacement: { role, successor, predecessor, effective, signature, successorSignature },
  };
}

/**
 * Whether this is a well-formed replacement of this backing's operator, signed
 * by the key E's replacement clause names.
 *
 * A backing whose E declares no replacement clause cannot be replaced at all
 * (§C2b: "Whether a sequencer can be replaced at all is answered in E"), so
 * every replacement of it answers false however well it is signed.
 *
 * **And the successor's own signature, over the same message.** Both halves or
 * it is not a replacement — a record carrying only the rule-holder's is not a
 * weaker replacement, it is a naming, and naming is not a power over the named.
 * The successor key is inside the message, so a consent obtained for one
 * handover cannot be lifted into another.
 */
export function isSignedReplacement(backing: Backing, replacement: Replacement): boolean {
  try {
    const rule = backing.evidence.replacementRule;
    if (rule === undefined) return false;
    if (replacement.role !== ROLE_OPERATOR) return false;
    const message = replacementMessage(backing.name, replacement);
    return (
      verifySignatureStrict(replacement.signature, message, rule) &&
      verifySignatureStrict(replacement.successorSignature, message, replacement.successor)
    );
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
 * key E names, and ending with the one in force NOW.
 *
 * Walked forward from the backing itself. **A link takes force at its declared
 * effective index** (§C2, 2026-08-29) — one index, from a signed field of a
 * witnessed object, and nothing else decides it.
 *
 * The rule it replaces gave force at the later of that index and the successor's
 * first commitment, which was §C2's own two-stage handover. That stage could not
 * be checked where force is read: whether a commitment carries this backing is
 * unreadable from a root, and this walk has no served state to check it against.
 * So what it actually asked was "has this key published ANY commitment" — and
 * then one fact, "the named key's commitment does not carry this backing's log",
 * both conferred force here and proved the fault in `isRewrittenHistory`. The act
 * granting the role was the act proving the violation. §C0a rule 2 decided it:
 * the qualification window, the usable-candidate walk, the same-index sibling
 * rule and the replay-manufactured-boundary guard were all fences around that
 * stage, and they retire with it. A successor that consents and then does not
 * serve is answered by the non-service grade like any other operator.
 *
 * **The walk stops at the last link whose effective index has arrived**, so the
 * chain's tip and the operator in force are one thing. Every predicate that reads
 * the tip and every predicate that reads force then agree by construction, which
 * they did not while a successor could sit at the tip un-forced.
 *
 * **Two replacements naming one predecessor** resolve by supersession before
 * force: a later one displaces an earlier only where it was witnessed strictly
 * before the earlier's effective index. One witnessed at or after that index
 * names a link the chain has already left, and is ignored — past force, the
 * successor is the incumbent, and replacing it is a replacement naming it. That
 * is what keeps a past reading from ever moving. Naming the incumbent is not a
 * handover and never becomes one, but it supersedes like any other candidate,
 * which is how a rule-holder revokes a successor it regrets.
 *
 * **Two witnessed at one index resolve to the lesser record hash** (§C2):
 * witnessing pins order, and where it pins nothing the rule lives in the
 * objects' own names, so every reader answers alike from the records and none
 * from the order they arrived.
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
    const now = venue.witnessedIndex();
    // Hashed once for the whole walk rather than once per link: the hash is the
    // record's identity for the dedup AND for the same-index tie below, and
    // anyone may publish a replacement for free, so the number of records is the
    // adversary's to grow.
    const witnessed = venue
      .replacementsFor(backing.name)
      .filter((w) => isSignedReplacement(backing, w.replacement))
      // A replacement cannot take force before it was witnessed (§C2), and one
      // declaring an earlier index is refused rather than corrected: the
      // rule-holder does not get to backdate a handover.
      .filter((w) => w.replacement.effective >= w.at)
      .map((w) => ({ ...w, hash: replacementHash(backing.name, w.replacement) }));

    const seen = new Set<string>([bytesToHex(backing.name)]);
    let link = backing.name;
    for (;;) {
      const incumbent = chain[chain.length - 1] as Succession;
      // The DISTINCT replacements at this link, each at its FIRST witnessing: a
      // replacement is one act of the rule-holder, and anyone may republish its
      // bytes, so dating a candidate by a replay would let a stranger move a
      // handover with the rule-holder's own signature.
      //
      // One whose effective index precedes the incumbent's force is void rather
      // than superseding: it can never take force (the chain would run
      // backwards, two operators in force at one index), so letting it revoke a
      // live candidate would hand the rule-holder's mistake more effect than its
      // intent.
      //
      // **Two witnessed at ONE index resolve to the lesser record hash** (§C2).
      // Witnessing pins order, and at one index it pins nothing, so the rule
      // has to live in the objects' own names — sorted on the index alone, two
      // honest readers holding the SAME two records disagreed permanently about
      // who was operator at a past index, which is the hazard `fault.ts`
      // forbids, reached through publication order rather than served state.
      // The hash is grindable — the rule-holder varies the successor key or the
      // effective index until its preferred record's name is lesser — and that
      // is priced rather than fought: the rule-holder signed BOTH records in
      // every reachable tie, so grinding buys it an outcome §C2 already gives
      // it for free by publishing one record alone. A tie between two DIFFERENT
      // rule-holders cannot be built while E's replacementRule is one key;
      // if that ever changes, this rule is the one to reopen. See DECISIONS.md.
      const candidates: typeof witnessed = [];
      {
        const distinct = new Set<string>();
        for (const w of witnessed
          .filter((w) => compareBytes(w.replacement.predecessor, link) === 0)
          .filter((w) => w.replacement.effective >= incumbent.from)
          .sort((a, b) =>
            a.at < b.at ? -1 : a.at > b.at ? 1 : compareBytes(a.hash, b.hash),
          )) {
          const hash = bytesToHex(w.hash);
          if (distinct.has(hash)) continue;
          distinct.add(hash);
          candidates.push(w);
        }
      }

      let chosen: (typeof witnessed)[number] | undefined;
      for (const candidate of candidates) {
        if (chosen !== undefined) {
          // Past the standing candidate's effective index the link has moved
          // on, and nothing witnessed later reaches it.
          if (candidate.at >= chosen.replacement.effective) break;
          // A same-index sibling is not "the later" — that tie resolved at the
          // sort, and letting the sibling supersede here handed the win to the
          // GREATER hash whenever the winner declared any lead time (found
          // reviewing this slice). Skipped, not broken on: a candidate at a
          // genuinely later index can still supersede.
          if (candidate.at === chosen.at) continue;
        }
        chosen =
          compareBytes(candidate.replacement.successor, incumbent.operator) === 0
            ? undefined
            : candidate;
      }
      if (chosen === undefined) return chain;

      const from = chosen.replacement.effective;
      // Named, and its index not yet reached: the predecessor governs until it
      // does, so the chain ends here and the tip is the operator in force.
      if (from > now) return chain;

      const hash = chosen.hash;
      // A hash cycle cannot be built (invariant 5's reasoning), so this guards a
      // malformed record rather than a real cycle — and it guarantees the walk
      // terminates on any input at all, which a verifier needs.
      if (seen.has(bytesToHex(hash))) return chain;
      seen.add(bytesToHex(hash));

      chain.push({ operator: copyBytes(chosen.replacement.successor), from, link: copyBytes(hash) });
      link = hash;
    }
  }, chain);
}

/**
 * The last index of a link's term: the index before its successor takes force,
 * and unbounded at the tip. A term is what a key holds the backing FOR, and the
 * two functions below are the only readers that need both ends of one.
 */
function termEnd(chain: readonly Succession[], i: number, bound?: bigint): bigint | undefined {
  const next = chain[i + 1];
  if (next === undefined) return bound;
  const end = next.from - 1n;
  return bound === undefined || end < bound ? end : bound;
}

/**
 * **Which TERM of the chain a committed state belongs to**, or undefined where
 * it belongs to none — §C2: "A term of the chain, rather than a key, is the unit
 * of obligation, of accrual and of fault."
 *
 * Read from the record, never asserted: a commitment carries a sequence and no
 * venue index by design (slice 13), so the term is that sequence placed against
 * the commitments this operator had witnessed at each end of each of its terms.
 * Letting the operator name its own term would hand the choice to the party with
 * the motive.
 *
 * **A key the rule-holder names twice holds two terms and answers for each
 * separately.** Ranking a key by its FIRST link — which is what
 * `chain.findIndex` did — made every re-appointed key exempt by construction: its
 * second-term state read as older than its successor's, so shrinking the book
 * back to a stale pre-handover copy read as growth and was unprovable in both
 * argument orders. That is the serious half of the stale-latch defect.
 *
 * **A commitment inside the lead time belongs to no term**, and that is the
 * answer rather than an edge case. §C2 gives a successor a lead time and forbids
 * it to carry the backing in it — the predecessor is still serving — so a
 * punctual multi-backing successor's own commitments there are obedience, not a
 * drop. Read as its term's, every one of them manufactured a permanent,
 * stranger-checkable fault proof against an honest heir.
 */
export function termOf(
  chain: readonly Succession[],
  venue: Venue,
  operator: Uint8Array,
  sequence: bigint,
): number | undefined {
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i] as Succession;
    if (compareBytes(link.operator, operator) !== 0) continue;
    // Bounded above only where the term has CLOSED: by the last commitment this
    // key had witnessed when its successor took force — a sequence past that
    // was published after the term ended. The tip is unbounded, deliberately:
    // in force, there is no excuse, and a state an operator SERVED but never
    // published must still rank here, or rewriting is free as long as the
    // rewrite stays unwitnessed. That is the same asymmetry the boundary read
    // always had; this is it per term instead of per key.
    const end = termEnd(chain, i);
    if (end !== undefined) {
      const last = venue.latestFor(operator, end);
      if (last === undefined || sequence > last.sequence) continue;
    }
    // And bounded below by the last it had witnessed before the term opened,
    // which the genesis link has none of. A sequence at or below that was
    // published before the term did — a successor's own commitments in its
    // lead time are its obedience, not its term's.
    const before = link.from === 0n ? undefined : venue.latestFor(operator, link.from - 1n);
    if (before !== undefined && sequence <= before.sequence) continue;
    return i;
  }
  return undefined;
}

/**
 * **The backing's own last commitment**: the last one the venue witnessed from a
 * party that was in force for this backing when it published it (§C2b).
 *
 * One answer, and every reader that used to ask a KEY asks this instead — the
 * silence grade, whether an operator is overdue, which snapshot a redemption
 * runs against, the outstanding count a revocation freezes, and which state is
 * latest at a past index.
 *
 * **Why a key cannot be the subject.** Under the retired two-stage rule force
 * arrived on a commitment, so "the party in force" always had one and
 * `latestFor(inForce)` was total. §C2 seats a successor on a signed field, so it
 * may have published nothing — and then a holder's redemption proof, which is the
 * only checkable remedy §C2b gives against a dark operator, is destroyed by ONE
 * published record naming a key the rule-holder can generate and co-sign itself.
 * The rule-holder is the backer by default: the party that owes the money.
 *
 * **And why the clock cannot reset on a handover.** A replacement costs one
 * publication, so any clock resetting on a rule-holder-chosen event is
 * cancellable by the rule-holder — hopping to a FRESH key every duration defeats
 * every per-key clock there is. This one never asks who is in force now, only
 * what was witnessed from whoever was, so a handover neither opens a gap nor
 * closes one and only a commitment closes one.
 *
 * Bounded at BOTH ends per link, which is the whole content of "then in force":
 * a retired key's later commitments for its other backings do not keep this
 * backing's clock alive, and a successor's own commitments inside the lead time
 * do not start it early. Undefined where no such commitment exists, which every
 * caller reads as index zero — never publishing at all must not read as punctual.
 */
export function lastCommitmentInForce(
  chain: readonly Succession[],
  venue: Venue,
  asOf?: bigint,
): { readonly commitment: Commitment; readonly at: bigint } | undefined {
  let best: { commitment: Commitment; at: bigint } | undefined;
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i] as Succession;
    const end = termEnd(chain, i, asOf);
    const at = venue.witnessedAtFor(link.operator, end);
    // Committed only before it held the role: not this backing's.
    if (at === undefined || at < link.from) continue;
    if (best !== undefined && at <= best.at) continue;
    const commitment = venue.latestFor(link.operator, end);
    if (commitment === undefined) continue;
    best = { commitment, at };
  }
  return best;
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
  return copyBytes(linkIn(chain, index).operator);
}

/**
 * The same walk, answering the whole link rather than only the key — because
 * **when** an operator took the role is a fact about it too, and one reader
 * needs it: silence runs from the index a party took the role, never from index
 * zero, or a successor is born already dark (`publishedInGap`). At genesis the
 * link's `from` IS zero, so that is one rule and not a special case.
 */
export function linkIn(chain: readonly Succession[], index: bigint): Succession {
  let inForce = chain[0] as Succession;
  for (const link of chain) if (link.from <= index) inForce = link;
  return inForce;
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
