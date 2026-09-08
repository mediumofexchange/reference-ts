# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. The v3 recovery field/relation map is
written, probed and reviewed; next decide its open choices and write
`pool-v3.md`.

## Status

- Implementation: `main`. This slice is docs and ignored scratch probes only;
  no `src/`, model, circuit, runtime, CI or permission change.
- [v3 recovery map](docs/POOL_V3_RECOVERY_MAP.md): candidate public inputs,
  witnesses, relations, in-clear checks, state effects and exact evidence for
  demand (kind 4), withdraw (5), settle (6), request (7, never admitted), the
  acceptance, release and withdrawal bytes, the five publications, the
  evidence chain and v3 snapshot digest; one trace through wallet, operator,
  backer, venue and stranger (service, gap, return); the record range each
  read needs (C2.10.13) and what Ergo supplies today; resource assumptions;
  twenty-one open items A1–A21; probes P1–P6.
- Companion specification: unchanged (`main` at `6995082`). The map is not
  normative; `pool-v3.md` follows the decisions below.
- Runtime remains pinned v2; PoolStore refuses silence clauses.
- Keep the frozen private-payment fixture until receiver/invoice and audit
  crash/retry cases move to the pool/wallet. Retain the offline Ergo probe,
  `scratch/pool-v3` (candidate circuits, probe, results) and build/browser/
  setup caches in ignored `scratch/`.

## Evidence

- P1 (`node scratch/pool-v3/probe.mjs`): demand, settle and request compile
  without warnings under the pinned toolchain; 47 checks, 5 real proofs, all
  14,656 bytes; public inputs in the map's order and every one bound; every
  hostile witness refused (same note twice, zero or wrong tag, tagged padding,
  wrong quantity, foreign backing, wrong scope, wrong owner/rho_out, zero
  value). Desktop Node, one thread: demand 5.0–5.8 s, settle 6.3 s, request
  3.5 s; verification 85–156 ms.
- P3 (`node scratch/pool-v3/nm-size.mjs`): non-membership proofs 352/480/576
  bytes median at 10³/10⁴/10⁵ nullifiers; the reference spent set costs about
  2.7 ms per insert (265 s for 10⁵), an implementation cost to remove.
- Independent review of the map (opus lane, read-only, ~167k tokens): seven
  material and four minor findings, no blocker; all folded in as A16–A21 and
  corrections in §§2–6 (standing record not pruned by deadline, adopted
  position index, withdrawal binds its statement, routing name, terms of
  every scoped entry in the trail, spentRoot not in the digest, acceptance
  routing, request as bearer object, citations, sizes).
- `npm run check:docs` and cross-repository links pass; the full runtime check
  result of `16da1de` still applies (no runtime change).

## Next

1. Decide A1–A7, A12 and A16–A21 (map §8) as one specification decision
   with a decision log entry, then write `pool-v3.md`: contexts and `T_TAG`, the statement
   record with its authorization slot, six circuit sources and identities,
   the evidence chain and snapshot digest, publication frame and bodies,
   acceptance/release/withdrawal bytes, replayed state, bounds. Acceptance:
   independent adversarial review of the spec text, committed before code.
2. Then implement v3 over `src/pool/` with the model as oracle (P6 ports the
   fault-alternatives, adopted-evidence and recovery departures as runtime
   tests), and remove the spent-set insert cost.
3. In parallel, probes that need a node or device: P2 chunked publication on a
   testnet node, P4 range completeness and inclusion latency, P5 phone proving.

## Open questions

- Product estimate: about 40% done / 60% remaining; plausible done range
  30–50%. The map and probes reduce layout uncertainty but build nothing a
  holder can use. Largest work: v3 spec and runtime/circuits, wallet and
  transport, delivery/restoration (F3), fee shape (F4), witness publication,
  authenticated range reads (A8), deployment/security assurance. See
  [estimate scope](docs/PRODUCTION_REQUIREMENTS.md#progress-estimate).
- A8: no authenticated source for C2.10.13's complete range on Ergo; the
  indexed node is a trust assumption until P4 selects a candidate.
- Missing committed evidence remains unresolved; intrinsic exclusion supplies
  no availability guarantee. Cached verdicts do not replace evidence.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
