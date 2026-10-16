# Conformance vectors

Language-neutral cases for an independent reader or verifier of the Medium of Exchange Protocol,
written from the specification ([direction](../decisions/2026-10.md#2026-10-16--want-a-second-reader-written-from-the-specification-and-accept-it-by-shared-conformance-vectors-direction)).
Each file holds genuine and hostile inputs with the verdict the specification gives them, as JSON
with hex bytes, so a reader in any language can run them without the TypeScript reference. The
reference generates every file from a test that judges each case and fails if its verdict or the
committed file differs; the generator is named below.

## Conventions

- Bytes are lowercase hex strings without a prefix. Integers that can exceed 2^53 (positions,
  values, quantities, indices) are decimal strings.
- `specification` names the adopted document and revision the file reads, in the
  [money-from-first-principles](https://github.com/mediumofexchange/money-from-first-principles) repository.
- A refused case gives `rule`, the rule it breaks, as `<document> §<section> <paragraph>: <rule>`.
  The rule is paraphrased, not quoted. `reference` is the reference's own name for the check that refuses it; the specification does
  not define these names, so a conforming reader matches the verdict and may cite any rule that
  refuses the case, not the label. Where a case breaks several rules (an arithmetic failure signed
  by the wrong key), any one of them is a conforming refusal.
- `intrinsic` says whether the failure is one of lit-v1 §6's intrinsic failures for compact
  exclusion (pool-v3 §9.1): in a record whose statement decodes canonically under §3, whose domain
  is the configuration's and whose authorization has §3's length, a listed signature or arithmetic
  failure (for kind 1, under **K** from the backing's authenticated signed terms). A reader that
  builds compact fault evidence must agree with it.
- Test keys are Ed25519 secrets of 32 repeated bytes; they sign nothing outside these files.

## Files

| File | Specification | What a reader does | Generator |
|---|---|---|---|
| [`lit-v1-replay.json`](lit-v1-replay.json) | lit-v1 §§2–3, 5–7 | Judge records in order against one segment's state | [`conformance-lit-v1.test.ts`](../test/conformance-lit-v1.test.ts) |
| [`lit-v1-vectors.json`](../test/fixtures/lit-v1-vectors.json) | lit-v1 §§2–6, 8–9 | Reproduce every byte layout and derived value (genuine only) | [`lit-records.test.ts`](../test/lit-records.test.ts) |
| [`pool-v3-genuine-proofs.json`](../test/fixtures/pool-v3-genuine-proofs.json) | pool-v3 §§3–4, 11.4 | Verify one genuine proof of each trail relation (issue, spend, burn, demand, settle; not request) under the adopted keys | [`pool-v3-check-set.test.ts`](../test/pool-v3-check-set.test.ts) |

The coverage still missing, and the order it is added in, is WORK.md's Next 13.

## `lit-v1-replay.json`

Top level: `configHash` (the lit-v1 §9 configuration hash, every statement's domain), `obligor`
(**K**'s public key from the backing's signed terms, which lit-v1 §7 reads for an issue and an
acceptance), `parties` (each test key's secret and public key) and `sequences`.

Each sequence starts one segment from empty: `context.segment` is its identity, `context.scope` the
backings in its scope (the first is the selected backing), and `context.index` the witnessed index
the replay judges at (C3.7's deadlines read it). The segment identity is given, not derived from a
header: every scope entry's opening is empty and there are no imports and no adopted block, so the
imported closure is empty. Backing names are arbitrary bytes, not terms' name hashes; each scoped
backing is read as holding terms in force at `index`, with **K** as its obligor, unrevoked (C2b.1)
and not lapsed. A reader starts with the genesis chains of lit-v1 §5, empty output and spent sets
(the spent root is pool-spent C1.2.8–9's over the empty set) and zero supply.

Steps are judged by lit-v1 §7 as replay judges them (C2.10.11: replay under the admission rules)
at `context.index`. The door's own checks, C3.3's instant window and C3.8's horizon, need the
venue's lag and are not applied. An exact resubmission is judged as a record at a new position,
which replay refuses; an operator's admission returns the original receipt for it instead
(pool-v2 §8, lit-v1 §7 Common). Each step in order:

- `"verdict": "admitted"`: the record passes lit-v1 §7, and after applying it the state holds
  `after`: its `position` (the record's 1-based position among admitted records), the §5
  `historyHash` and `evidenceHash`, the pool-spent `spentRoot` the history binds, the `outputs`
  (`cm`, lit-v1 §2) and `nullifiers` it inserted, and every scoped backing's `issued` and `burned`.
- `"verdict": "refused"`: the record fails lit-v1 §7 as `rule` says and leaves no trace (pool-v2 §8):
  the next step is judged as though the refused record was never offered.

A sequence is a reader's admission order, not a served trail: a served trail containing a refused
record fails replay at that position (C2.10.11).
