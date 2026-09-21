# Current work

Updated: 2026-09-21

## Goal

Completed slice: the candidate Ergo full-block verifier as the local replay's
§13.2 verifier for every replay group (single-backing imports and silence,
two-backing scopes and scope recovery, receipts, non-service counts, compact
faults and returning segments), from exact transaction bytes and checked roots.

Acceptance: every fixture-verifier replay group's result is reproduced through
the Ergo adapter with kind-4 ordinals as transaction positions (fixture ordinal
`<< 32`) and `rangeEvidence` naming the candidate; each subject's kind-4 answer
and the cross-backing union (C2b.4.2) agree entry by entry; fresh seedless and
receiver processes reproduce a two-backing result; missing, tampered and
undecodable sections still refuse; unit, profile-experiment and real-proof
checks pass; independent review of the anchor rule and the integrated patch.
Evidence limits: reader-selected synthetic headers, no node acceptance, no
decoder equivalence, no real-chain read (P2/P4 open). Stop boundary: no profile
selection, specification change, runtime adoption or node publication.

## Status

- The slice forced a candidate-profile change: the venue is indexed from a
  pinned **anchor header** (index 0 is the anchor's child) instead of index =
  height with the genesis at 1. Every fixture witnesses at indices 0 and 1
  (`scratch/ergo-index-survey.mjs`), and any index shift changes the meaning
  of absolute indices inside signed records (replacement effect, deadlines);
  the anchor also bounds reads from index zero to the deployment's age.
  [Decision](decisions/2026-09.md#2026-09-21--index-the-ergo-venue-from-a-pinned-anchor-header).
  No specification change: §13 is source-neutral; companion `main` stays at
  `183c09f`.
- Delivered: model (`anchor`, context `moe/venue/ergo/v3`, duplicate-anchor
  refusal), fixture converter (index `i` = height `i + 2`, depth = lag − 1,
  one transaction per record), adapter, `ergo-check.mjs` over every builder
  pair (`replayPairs`, `underErgo`), local-check/worker, unit tests, profile
  experiment, docs; CI's pool-v3 job budget raised from 20 to 30 minutes for
  the second pass (baseline job ~13 min; local final run 18 min).
- Independent review (one opus lane): no design blocker; applied its fixes
  (duplicate-anchor refusal with a unit case, `restored` issuer reads in the
  pair walker, stale rule/architecture rows and reports, anchor-depth and
  header-retention consequences recorded).

## Evidence

- Ideal-proof probe `scratch/ergo-scope-probe.log` (107 groups agree), dry
  run `scratch/ergo-check-dry.log` (109 groups). Real-proof
  `check:pool:ergo-replay` on the final tree (`scratch/ergo-anchor-real.log`):
  223 replay groups / 65 real proofs; the Ergo pass replays 112 groups with 50
  kind-4 subjects, 193 union positions, 192 kind-1..3 ranges, 3 fresh
  processes. The [replay report](docs/pool-v3-local-replay-verification.json)
  binds the sources; the [profile report](docs/ergo-range-profile-verification.json)
  records 250 checks. `npm test` 1941 tests, typecheck and docs/link checks pass.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. The converter never places two records in one
  transaction; adjacency is covered by unit tests and the profile experiment.

## Next

1. P4: exhaustion cost on a real chain from a real anchor (header retention
   and block bytes per read), then P2 node publication and reassembly; both
   need the stopped node or a public node and are separate from this slice.
2. Alternatively the wallet/custody boundaries below. Review protocol choices
   before dependent code.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- Ergo node is stopped. Retain the detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches. Do not delete the image or allocate another.
  [Sync handoff](docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. P2 node publication, P4 real-chain exhaustion,
  decoder equivalence and authenticated venue evidence remain open.
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-21. The venue-evidence path is now exercised end to end on synthetic
chains; selection still needs P2/P4, an authenticated header source and a
contained node-equivalent decoder. Runtime integration, selected
venue/decoder, qualified custody and continuous wallet operation dominate
remaining effort. No rounded estimate change.

Switch to a fresh instance for the next capability: P2/P4 center on node and
network evidence this context does not hold, and the wallet work on different
sources.
