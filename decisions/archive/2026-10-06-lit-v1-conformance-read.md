# Conformance read of lit-v1 before adoption, 2026-10-06

Read the companion specification's `lit-v1.md` at `1bf5bfc` (unchanged at `df2332a`) against reference `f5c0001`:
`src/lit/`, the shared seams lit runs through (`pool/v3/construction.ts`, `state.ts`, `recovery.ts`, `replay-store.ts`,
`package-reader.ts`, `scope-reader.ts`, `reader.ts`, `evidence-store.ts`, `fault-observer.ts`, `non-service.ts` and the
v3 codecs lit parameterizes) and `test/lit-*.test.ts`. One fresh, read-only reviewer did the read, section by section;
the primary checked the blocker's code paths. It gates WORK.md's M14e, the adoption of `moe/lit/v1` (Construction C0a).

**Result:** do not adopt yet. Lit-v1 has a verdict rule that two readings separate (B1), and the conformance vectors
bind a fraction of the layouts (M1). No byte rule of §§2–9 deviates. Nothing was changed by this read.

**Recomputed independently and equal:** the configuration hash `17835aa2…77c1`; the statement prefix 53 and every body
length; acceptance 125, release 146, snapshot 163, receipt 194 (record 290) bytes; a demand over two notes 478, the
largest publication 569, records 189–719, the largest spend statement 583; fault evidence 244 fixed bytes; the header
126 + 136 per entry (262 to 8,913,022); trail 28 and its 8200-byte record bound; package 22; terms at most 1296; the
vector `owner0` under an independent RFC 5869 HKDF.

## Blocker

**B1. A record that splits but does not decode.** §3 says the length fields "let a reader split a committed record
without decoding it (§5)", and §5 takes `signatureHash_i` over the authorization "whatever its length", which only an
undecodable record can have wrong. §6 applies pool-v3 §10.1, whose procedure covers records "that can be decoded under
§5" and is inconclusive for the rest. The reference takes the narrow reading: `lit/construction.ts:148` digests through
`decodeRecord`, `evidence-store.ts:533` drops the chain on an `EncodingError`, and `state.ts:399` decodes with an
`EncodingError`, not a `ReplayRefusal`, which `scope-reader.ts:907` re-throws rather than classifies. *Trigger:* an
operator commits a record whose two lengths are exact but whose statement fails §3 (an output value 0, a small-order
owner key, kind 8, a 63-byte authorization). *Impact:* that checkpoint can never be excluded: the full trail is
inconclusive and compact exclusion (§6) needs a canonical decode, so readers wait for lapse; under the broad reading the
trail authenticates and the checkpoint is excluded. Choices, one sentence in §6 either way:
- (a) pool-v3 §10.1's "can be decoded" reads as "splits under §3", and a split record that fails §3 fails replay.
  Uses lit's split and strengthens exclusion; code: `digests` from `splitRecord`, a decode failure in replay a
  `ReplayRefusal`.
- (b) inconclusive, as in pool-v3; then §3's "(§5)" and §5's "whatever its length" are reworded.

Neither reading is pinned by a test, and where the re-thrown `EncodingError` ends (a failed read, or a codec refusal
earlier in the trail) is to be traced with the fix.

## Majors

**M1. The vectors bind part of the layouts.** Slice 14's acceptance asks that "conformance vectors bind every byte
layout". `test/fixtures/lit-v1-vectors.json` holds 11 records, 5 publications and `owner0`. History and evidence steps
(with a spent root), snapshot, receipt message and record, header, trail, package, terms bytes and name, fault evidence,
standalone acceptance and release bytes, `acceptSecret` and `presentSecret` (one and two inputs) are checked only
against in-test oracles (`test/lit-records.test.ts:311-356`, `lit-transport`, `lit-fault-evidence`), so an edit to code
and oracle together would pass.

**M2. §10 is implemented for the namespace's own outputs.** The text rebuilds "the output set from the kept statements
and imports". `reader.ts` `keptOutputsHold` rebuilds the namespace's own outputs; an imported namespace's rows are
checked only where its class is reused in the read, and a settlement's demand is read from the trail. The M14d decision
records both as resting on §14's file digest. Settle either by a wording correction of §10 (no verdict change) before
adoption, or by checking imported outputs.

## Tests worth adding

1. A lit trail holding a record that splits but does not decode, pinning B1's verdict.
2. One operator key committing pool-v3 and lit checkpoints (§6): the lit read passes the pool's as non-carrying by
   directory alone, and a receipt whose `after` names one is not of the receipt's segment.
3. A demand publication with mixed backings or a sum past a `u64`: refused at decoding (`records.ts:400`, so no force
   and no evidence, pool-v3 §13.3) rather than by `ARITHMETIC`; same verdict, unpinned.
4. §10 resumption with a tampered imported output row (M2).

## Conformance found

§1 keys canonical and not small order, strict Ed25519 (`keys.ts:39-79`), positive `u64` values, bigint sums, contexts
prefix-free at load. §2's commitments, nullifiers, tags and both rho derivations (`notes.ts:75-107`). §3's frame,
exact split, authorization lengths and signers in input order, derived values; a settlement's output over the stored
demand's nullifiers in input order (`lit/construction.ts:90-94`, `replay-store.ts:589`). §4's acceptance and release
reconstruction and routing (per-kind body bounds, stricter than 478 with equal verdicts). §5's chains, snapshot and
receipt without a proof digest or scope root, pool-spent's contexts for the spent root, `SHA256("")` for an empty field.
§6's fault-evidence frame and compact exclusion on exactly the listed cases. §7's verdicts per kind and its readings
(C3.8's taken release unreachable behind `SPENT`; no distinct acceptance owner; no `rho_out`; requests counted by owner
signature over a live output). §8's HKDF (salt the domain, L = 32, three infos), HMAC inputs and zero `tag_2`. §9's
clause table, tag refusals and bound. §6's transport over the pool's codecs.

## Not implemented (later work, not blockers)

§8's wallet: owner-index allocation persisted before exposure, the 256-index window and the self-payment that moves it,
restoration scans, payee crediting once per output, fee outputs. The operator side: lit admission in the journal,
exact-resubmission receipts, publisher, serving and commands. A lit frontier read's `answers` (refused, M14d).
