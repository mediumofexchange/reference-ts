# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Next is the maintainer's selection among the
fault contract proposal's four choices, then the amendments and their review.

## Status

- Implementation: `main`. Branch `feat/pool-fault-proposal` adds two research
  switches to `model/pool-fault.ts`, `clockIsSnapshot` (D) and
  `faultContinuesSegment` (R7′), with `model/pool-fault-alternatives.test.ts`
  (13 cases against the defaults), and points the [fault document](docs/POOL_FAULT_RECOVERY.md),
  [architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md), README and production
  requirements at the proposal. No `src/`, v2 layout or runtime change.
- Companion: branch `spec/pool-fault-proposal` adds `pool-fault.md`, a
  proposal that is not adopted: rules C2.10.10–13 and C2.10.9c, a revised
  C2b.6.1 (the clock is the snapshot's), the sentence-level amendment table
  and the four choices the maintainer selects; indexed in its AGENTS.md and
  README. Normative texts are unchanged: recovery remains `c5f5464`.
- Recommendation recorded in the proposal: authenticated exclusion; D over
  term-only (D changes one sentence of Construction §C2b.6 and removes every
  cross-scope clock dependency); R7′ over R7; receipt precedence retained.
  The earlier term-only recommendation stands if the operator-wide clock is
  kept. Nothing is decided; the maintainer selects.
- Runtime remains v2 and PoolStore refuses silence clauses. Historical
  retirement is modeled. Fault clocks and R6/R7 remain unselected research.
- Retain the frozen private-payment fixture until receiver/invoice and
  independent-audit crash/retry cases move to the pool/wallet path. Retain
  the offline Ergo probe and build/browser/setup caches in `scratch/`.

## Evidence

- Model suite 14 files / 251 tests and `npm run typecheck` pass. The
  alternatives file shows, under D: a dropped backing's gap opens after the
  duration while the count also fires, a venue release has force and the
  return adopts it with no semantic violation; garbage carrying streams and
  fresh valid unrelated openings reset nothing; X's clock needs no Y or Z
  fault evidence or scope preimage but refuses without a directory; the
  silence boundary still retires the old segment. Under R7′: the honest stale
  twin recovers without a new segment, a bad proof then a valid continuation
  finalizes the receipt, and a replaced statement contradicts it.
- Documentation and link checks across the four repositories, and the full
  `npm run check`, are recorded in the merge commit message of this slice.
- Independent read-only review of the proposal and the alternatives was run
  in an Opus lane before merge; its findings and their disposition are in the
  proposal's text and this slice's commits.

## Next

1. Maintainer: select among `pool-fault.md` §10's four choices. Then apply
   §8's amendments on a spec branch, collapse the model switches to the
   selected rules, port the alternatives cases as the normative cases, and
   commission independent adversarial review of the amended contracts before
   any `pool-v3.md` byte layout.
2. Continue [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md): target phone,
   authenticated note delivery/restoration, independently available evidence
   and pinned-node publication. Offline sizes do not establish node acceptance.

## Open questions

- Under D, **E**'s no-commitment duration prices a drop as it prices
  darkness; the maintainer confirms that reading with the clock choice.
- Finite ideal reads supply no production retrieval/scaling result. Measure
  suffix/ancestry retention and cold reads; cached verdicts do not replace
  retained evidence or current snapshots.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
