// Succession (§C2): who serves a backing, once the key E names no longer does.
//
// "**A replacement is itself a witnessed object.** It is signed by whoever
// **E**'s rule names, the backer by default, and co-signed by the successor,
// states the role, the successor and the effective index, and is published
// always at the successor venue and at the old one while it serves. Each
// replacement names its predecessor, so the chain from the original terms is
// walkable... Its effective index is later than the index at which it is
// itself witnessed by at least the venue's lag plus one — a record below that
// floor is not a replacement — and it takes effect there... Until the
// effective index the predecessor governs and goes on serving... From the
// effective index the old attester's co-signatures stop counting, which is why
// a wallet verifies the chain rather than the key it remembers."
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
import { backingName, type Backing } from "./backing.js";
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
  return walkSuccession(backing, venue).chain;
}

/**
 * The chain **and the link chosen at its tip whose effective index has not yet
 * arrived** — one more element than `successionOf` exactly while a handover is
 * in its lead time, and the same array otherwise.
 *
 * This is the possession question where `successionOf` is the force question:
 * a successor takes the book on IN the lead time (§C2, that is what the lead
 * time is for), so the reader that finds "my seat, and the links before it"
 * has to answer identically before and after the effective index. Asking the
 * clock instead — "who is in force right now" — is what made the takeover
 * reachable only strictly inside a lead time §C2 does not guarantee exists.
 *
 * The pending link is the walk's own chosen candidate, held to the admission
 * rules an arrived link is held to — signatures, supersession, the void rule,
 * the tie — with one stated exception: it is returned before the `seen` cycle
 * guard, which an arrived link passes on push. Unreachable in practice (a
 * pending hash already seen needs a hash collision), but the docstring should
 * not claim more than the code checks. Whether it ever takes force is still
 * the chain's question, answered then.
 */
export function successionAhead(backing: Backing, venue: Venue): Succession[] {
  const { chain, pending } = walkSuccession(backing, venue);
  return pending === undefined ? chain : [...chain, pending];
}

/**
 * A record the rule-holder really signed, with its hash: everything the walk
 * needs about a published replacement that does not depend on the clock.
 */
interface Admitted extends WitnessedReplacement {
  readonly hash: Uint8Array;
}

const NONE: readonly Admitted[] = Object.freeze([]);
const admittedByVenue = new WeakMap<Venue, Map<string, { through: number; seen: Set<string>; records: Admitted[] }>>();

/**
 * Drop everything this memo holds for a venue: the call a venue makes when it
 * replaces its whole view (`ErgoVenue.sync`), so that positions it judged
 * against the old view are judged again against the new. Not a verifier — it
 * answers nothing — which is why it is not on the refusal surface.
 */
export function forgetAdmitted(venue: Venue): void {
  admittedByVenue.delete(venue);
}

/** A replacement as the reader's own: every byte array copied. */
export function copyReplacement(replacement: Replacement): Replacement {
  return {
    role: replacement.role,
    successor: copyBytes(replacement.successor),
    predecessor: copyBytes(replacement.predecessor),
    effective: replacement.effective,
    signature: copyBytes(replacement.signature),
    successorSignature: copyBytes(replacement.successorSignature),
  };
}

/**
 * The walk's expensive step, taken once per record and held for as long as the
 * venue that answered it is.
 *
 * Returns every admitted record for this backing at this venue, in witnessed
 * order and each with its hash, one per distinct record — unfiltered by link:
 * the walk's own rules do that, per call.
 *
 * **Two signature verifications decide whether a record counts; byte compares
 * decide everything after.** `isSignedReplacement` is a pure function of
 * (backing, record): the rule-holder's key comes from inside the name, the
 * message from the record's own fields, so a verdict never changes and never
 * needs asking twice. Which link a record names, whether it supersedes, which of
 * two at one index has the lesser hash — all of that is a comparison over the
 * handful of records that passed. Anyone may publish a record for free and the
 * venue takes no view, so the expensive step is the adversary's to multiply and
 * the cheap one is the honest record's. Measured on this machine: one strict
 * Ed25519 verification is ~5 ms and a link comparison is well under a
 * microsecond, so a walk that verifies before it compares prices its reader at
 * the stranger's flood — seconds per door call per backing, and minutes of the
 * boot window the resume rule holds open until every registered backing serves.
 *
 * **The memo keeps only what it ADMITTED, once.** A junk record leaves nothing
 * behind but the count of records already judged, and a republished copy of a
 * record already held leaves nothing either (the review's S1: retained, each
 * copy cost ~1.5 kB for the venue's life and a sort per walk, at a stranger's
 * price), so a flood costs this map one integer rather than a key per record:
 * the memory bound is the DISTINCT honest record's, which is the same thing the
 * cost is. And nothing here needs an eviction rule — a `WeakMap` on the venue
 * holds the memo exactly as long as the venue object is (`forgetAdmitted` is
 * how a venue that re-gathers ends it sooner), and a second venue holding
 * different records for one backing name gets its own memo rather than this
 * one's answers.
 *
 * **What it leans on is the Venue contract's append-only clause — for WHO IS
 * IN FORCE, not merely for freshness.** Positions 0 up to `through` have been
 * judged and are never judged again for the life of the venue object, so a
 * view that re-gathers must only ever move that count forward (`ErgoVenue.sync`'s
 * finalised prefix is exactly that promise). A view that LOST records is out of
 * contract and is judged again from scratch rather than trusted; a view that
 * CHANGED a record below that count, at any length no shorter — a
 * reorganisation below the
 * declared depth, a third-party adapter — is not detected, and no later append
 * heals it, in EITHER direction: an operator seated from a record the venue no
 * longer holds stays seated for this reader, and a co-signed handover written
 * over a position once judged junk stays invisible, the retired key still in
 * force. That is the price, stated here because it is the only one (the
 * slice-37 panel and its review; the per-record verdict memo that removes it
 * costs fourteen times the per-walk residual and is the fallback if the clause
 * is ever weakened). A venue that re-gathers its whole view says so —
 * `forgetAdmitted` — and `ErgoVenue.sync` does, because its own frontier walk
 * is this memo's first reader and would otherwise widen on the stale chain. The sequencer's walk cache already keys on this clause;
 * this holds the same assumption one layer down, where every reader shares it
 * instead of only the one that thought to cache.
 *
 * **The verify is first, and nothing unverified is hashed.** `isSignedReplacement`
 * carries its own try/catch, so a malformed record a venue adapter hands out
 * drops itself here; hashed first, it would throw inside `answering` and
 * collapse the whole walk to the genesis chain — the retired operator back in
 * force for that reader. And every record the walk's later rules compare — the
 * fields-hash dedup, the same-index tie, supersession, the self-naming
 * exemption — has passed here: a junk twin of an honest record (its fields, a
 * stranger's signatures) published first would otherwise take the dedup slot
 * and then fail, and the signed handover would vanish (the panel's probes).
 */
function admitted(backing: Backing, venue: Venue): readonly Admitted[] {
  // By the RECOMPUTED name, as committedLogFor picks a snapshot: `readonly` is
  // erased at runtime and the Backing brand is a phantom type, so an object
  // carrying a real backing's `.name` beside other fields — another rule
  // key, another `nameHex` — is a Backing at runtime. Looked up by its
  // `.name` it read that backing's records, judged them under its own rule,
  // and took a memo entry per ask, ~2 kB each with no venue write (the
  // review's ADV-6, the verification's V-1). Looked up by the name its fields
  // derive, it reads the records of the backing it IS — none, for a
  // hand-built object — and the key needs no rule beside the name, because
  // the name binds E. One hash per walk.
  const name = backingName(backing);
  const published = venue.replacementsFor(name);
  let byBacking = admittedByVenue.get(venue);
  if (byBacking === undefined) {
    byBacking = new Map();
    admittedByVenue.set(venue, byBacking);
  }
  const memoKey = bytesToHex(name);
  let memo = byBacking.get(memoKey);
  if (memo === undefined || memo.through > published.length) {
    memo = { through: 0, seen: new Set(), records: [] };
    byBacking.set(memoKey, memo);
  }
  // A backing the venue holds no records for is memoised as nothing at all —
  // a name is a hash, minted for free, and the local venue answers `[]` for
  // any name (the review's ADV-12) — and it is asked AFTER the shrink guard
  // above, so a view that lost every record is re-judged when it refills
  // rather than served from the memo it emptied into (the verification's
  // V-2, a regression the first placement had made).
  if (published.length === 0) {
    byBacking.delete(memoKey);
    return NONE;
  }
  // Both call sites return before this for a backing with no rule; asked here
  // rather than defaulted, so a third caller would get the same answer.
  if (backing.evidence.replacementRule === undefined) return NONE;
  // Judged into a local list, then both writes together with nothing that can
  // throw between them: a memo whose records ran ahead of its count, or
  // behind it, would judge a position twice or never.
  const fresh: { record: Admitted; hashHex: string }[] = [];
  const seenNow = new Set<string>();
  for (let i = memo.through; i < published.length; i++) {
    const w = published[i] as WitnessedReplacement;
    if (!isSignedReplacement(backing, w.replacement)) continue;
    // **A replacement's lead is floored at the venue's lag plus one** (§C2,
    // slice 38): effective ≥ witnessed + lag + 1, and a record below the floor
    // is not a replacement — refused rather than corrected, as a backdated one
    // always was, since the rule-holder does not get to date a handover. The
    // floor is what gives every party the record before the last clock at
    // which an act it signs can still be witnessed in the incumbent's term —
    // at the venue's own speed: an act witnessed at or past the effective
    // index was signed no later than that index less the lag, which the
    // floor puts strictly after the record's own witnessing, so a commitment
    // the predecessor signed before it could read the record lands inside
    // its term where the venue includes at its lag, and one it signs after
    // is its own choice — and its payee's, reading the same record
    // (CLAUDE.md's party rule).
    // Inclusion is bounded below by the lag and above by nothing: the floor
    // buys one index of notice, and a slow block is the party's cost (the
    // slice-38 review, the spec angle's S2 and the security angle's S2). Without the floor a record effective at its own
    // witnessing — or, under a finality depth, one pre-armed by the depth and
    // aimed at the cadence E declares — put the incumbent's newest commitment
    // in no term: not the book, placed nowhere, every fault predicate false,
    // and a witnessed payment in it dead and re-spendable for one record from
    // the rule-holder (slice 36's F4; the slice-38 panel, three angles).
    // Clock-free like the signature — the lag is a constant of the venue's
    // identity, and the record is compared against its own witnessing — so it
    // belongs to the step that is taken once.
    if (w.replacement.effective < w.at + venue.lag() + 1n) continue;
    // Hashed here rather than once per link: the hash is the record's identity
    // for the dedup AND for the same-index tie the walk resolves below.
    // The reader's own copy: the memo is validated state, and what a venue
    // hands out is the venue's to overwrite — retained uncopied, a field
    // written afterwards would seat a successor no signature covers, where
    // the uncached walk merely stopped verifying the record (the review's
    // ADV-3).
    const hash = replacementHash(name, w.replacement);
    const hashHex = bytesToHex(hash);
    // A republished copy of a record already held — the rule-holder's own
    // bytes, which anyone may republish — is not held again: the walk keeps a
    // record's FIRST witnessing, positions are witnessed order, so the copy
    // already held is the one that counts. Retained, each copy cost ~1.5 kB
    // for the venue's life and a sort per walk, at a stranger's price (the
    // review's S1): junk and republication now leave the same nothing behind.
    if (memo.seen.has(hashHex) || seenNow.has(hashHex)) continue;
    seenNow.add(hashHex);
    fresh.push({ record: { replacement: copyReplacement(w.replacement), at: w.at, hash }, hashHex });
  }
  for (const { record, hashHex } of fresh) {
    memo.seen.add(hashHex);
    memo.records.push(record); // no spread: it has a stack bound, and its throw is answering's fallback
  }
  memo.through = published.length;
  return memo.records;
}

function walkSuccession(
  backing: Backing,
  venue: Venue,
): { chain: Succession[]; pending?: Succession } {
  const chain: Succession[] = [
    { operator: copyBytes(backing.evidence.operator), from: 0n, link: copyBytes(backing.name) },
  ];
  // The fallback is the chain as far as it got, which at minimum is the key E
  // names — and `answering` is what stops a venue's refusal being mistaken for
  // that, since the genesis chain is a real answer about who serves. The
  // fallback closes over the same array the body grows.
  const fallback = { chain };
  return answering(() => {
    if (backing.evidence.replacementRule === undefined) return { chain };
    const now = venue.witnessedIndex();
    const witnessed = admitted(backing, venue);

    const seen = new Set<string>([bytesToHex(backing.name)]);
    let link = backing.name;
    for (;;) {
      const incumbent = chain[chain.length - 1] as Succession;
      // The DISTINCT replacements at this link, each at its FIRST witnessing: a
      // replacement is one act of the rule-holder, and anyone may republish its
      // bytes, so dating a candidate by a replay would let a stranger move a
      // handover with the rule-holder's own signature.
      //
      // One whose effective index is not STRICTLY later than the incumbent's
      // force is void rather than superseding (§C2): at or before it, the chain
      // would run backwards or seat two operators at one index — and a record
      // seating a zero-width term was an eraser, not merely a mistake: it
      // emptied the incumbent's term retroactively, so `termOf` placed its
      // committed states nowhere, `operatorAt` moved at an already-read index,
      // and a witnessed book could neither serve nor accuse (the 35d fix
      // round, probe-proven from three angles). Letting it revoke a live
      // candidate would hand the rule-holder's mistake more effect than its
      // intent; letting it SEAT handed it an amnesty. The one exemption is a
      // candidate naming the incumbent itself — that is a revocation, not a
      // handover, and a co-signed revocation at the boundary must still
      // revoke (found by the fix panel's inventory angle: without it, the
      // revoked successor took force). The exemption is deliberately wider
      // than the boundary case: a self-naming record dated anywhere the lead
      // floor allows is admitted, including inside the incumbent's
      // own lead time — no new power, since the same two signatures could
      // always void the slot with a later-dated record, but the width is
      // stated rather than implied (the regression round's W-1).
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
      const candidates: Admitted[] = [];
      {
        const distinct = new Set<string>();
        for (const w of witnessed
          .filter((w) => compareBytes(w.replacement.predecessor, link) === 0)
          .filter(
            (w) =>
              w.replacement.effective > incumbent.from ||
              compareBytes(w.replacement.successor, incumbent.operator) === 0,
          )
          .sort((a, b) =>
            a.at < b.at ? -1 : a.at > b.at ? 1 : compareBytes(a.hash, b.hash),
          )) {
          const hash = bytesToHex(w.hash);
          if (distinct.has(hash)) continue;
          distinct.add(hash);
          candidates.push(w);
        }
      }

      // At each witnessed index, exactly ONE candidate is considered — the
      // lesser hash, which the sort put first — and the rest at that index are
      // not "the later" of anything: that tie resolved at the sort. Letting a
      // same-index sibling supersede handed the win to the GREATER hash
      // whenever the winner declared any lead time, and letting one follow a
      // revocation reset made a revocation lose every tie however its hash
      // sorted (both found reviewing this slice). Skipped, not broken on: a
      // candidate at a genuinely later index can still supersede or, after a
      // revocation, stand fresh.
      let chosen: Admitted | undefined;
      let consideredAt: bigint | undefined;
      for (const candidate of candidates) {
        if (consideredAt !== undefined && candidate.at === consideredAt) continue;
        // Past the standing candidate's effective index the link has moved
        // on, and nothing witnessed later reaches it.
        if (chosen !== undefined && candidate.at >= chosen.replacement.effective) break;
        consideredAt = candidate.at;
        chosen =
          compareBytes(candidate.replacement.successor, incumbent.operator) === 0
            ? undefined
            : candidate;
      }
      if (chosen === undefined) return { chain };

      const from = chosen.replacement.effective;
      const hash = chosen.hash;
      const next: Succession = {
        operator: copyBytes(chosen.replacement.successor),
        from,
        link: copyBytes(hash),
      };
      // Named, and its index not yet reached: the predecessor governs until it
      // does, so the chain ends here and the tip is the operator in force —
      // and the chosen link is the PENDING one, which is the possession
      // reader's answer (successionAhead).
      if (from > now) return { chain, pending: next };

      // A hash cycle cannot be built (invariant 5's reasoning), so this guards a
      // malformed record rather than a real cycle — and it guarantees the walk
      // terminates on any input at all, which a verifier needs.
      if (seen.has(bytesToHex(hash))) return { chain };
      seen.add(bytesToHex(hash));

      chain.push(next);
      link = hash;
    }
  }, fallback);
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
 *
 * **An unwitnessed sequence places at the tip only while the chain is the
 * genesis link alone.** Once ANY succession exists, every key on the record has
 * had a period out of force — before its seat, after a replacement, between two
 * namings — and a shared operator's ordinary service in such a period produces
 * signed states that drop this backing honestly. By sequence alone those are
 * indistinguishable from an in-force key's unwitnessed drop, so the ambiguous
 * case places nowhere and accuses nobody. The line is drawn at the CHAIN and
 * not at the key: a first draft bounded only keys named twice, which made the
 * policy a key gets purchasable — two records with a zero-width term bought the
 * bound — and treated one ambiguity two ways (found regression-reviewing this
 * slice's fix round). What the uniform line costs, priced in DECISIONS: past
 * the first handover, an in-force operator's UNWITNESSED dropped state is not
 * provable by this pair alone — the witnessed drop still is, and the
 * non-service grade still reaches the dropper.
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
    // Bounded above where the term has CLOSED: by the last commitment this
    // key had witnessed when its successor took force — a sequence past that
    // was published after the term ended. The genesis-only tip is unbounded,
    // deliberately: no succession exists, so nothing this key signed could
    // belong to a period out of force, and a state it served but never
    // published must still place here, or rewriting is free as long as the
    // rewrite stays unwitnessed. Any longer chain bounds every tip by what its
    // key has had WITNESSED — the docstring says why the line is the chain's.
    const end = termEnd(chain, i);
    // A term whose end precedes its own start is empty and holds nothing. The
    // walk voids the record that would build one (§C2's strictly-later rule),
    // so a chain from `successionOf` cannot carry it — but the chain is the
    // CALLER's parameter, and the guard is what keeps a malformed one from
    // putting a negative index on the Venue interface.
    if (end !== undefined && end < link.from) continue;
    if (end !== undefined || chain.length > 1) {
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
 *
 * One boundary case is the spec's own strictness, worth knowing: a predecessor's
 * commitment witnessed exactly AT the effective index belongs to neither term
 * (§C2 pins the handover to what was witnessed "strictly before" it, and at that
 * index the party in force is the successor), so a handover at precisely the
 * predecessor's last-commitment index ages this clock by one commitment. The
 * rule-holder aging its own backing's clock fires a grade against itself, which
 * is the collusion case §C2b already declines to distinguish from rescue.
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
    // An empty term (two links at one index) holds nothing, and the guard is
    // also what keeps a negative index off the Venue interface.
    if (end !== undefined && end < link.from) continue;
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
 * §C2's lead time is what a named successor takes the book on in — "until the
 * effective index the predecessor governs and goes on serving" — and a successor
 * cannot publish a commitment over a state it was never allowed to take on. So
 * a named successor may prepare — take over the predecessor's committed state —
 * while it co-signs nothing, and carries nothing, until it is in force.
 */
export function isNamedSuccessor(backing: Backing, venue: Venue, key: Uint8Array): boolean {
  return answering(() => {
    if (backing.evidence.replacementRule === undefined) return false;
    const chain = successionOf(backing, venue);
    const tip = chain[chain.length - 1] as Succession;
    if (compareBytes(tip.operator, key) === 0) return false;
    return admitted(backing, venue).some(
      (w) =>
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
