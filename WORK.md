# Current work

Updated: 2026-09-20

## Goal

Completed slice: compact intrinsic exclusion for live non-opening, single-backing
checkpoints with silence, retaining complete ancestor/state/clock dependencies.
Clock reset, rollback and withheld-dependency probes passed before final acceptance.

Acceptance: proof/issue-K rejection permits original and successor descent with
only target events withheld; full/compact evidence agrees on classification,
selected state and silence clocks. Lapse keeps priority; missing clocks/predecessors
refuse; repairs preserve held sequences and last valid state. Real-proof,
portable/fresh-process acceptance and independent review passed.
Stop boundary: conditional v3 replay only; no shared/adopted-block expansion,
v2 runtime, configuration adoption or live-chain claim. Specification §9.1 at
183c09f already permits silence with complete dependencies; its application was reviewed.

## Status

- Delivery: the implementation commit containing this handoff, retained on
  `feat/compact-silence-exclusion`, based on delivered `9bb963b`.
  Companion `main` and `spec/compact-intrinsic-exclusion` remain at `183c09f`;
  no specification edit needed. Both baseline remotes match. No main protection
  or applicable ruleset gates were configured when checked before delivery.
- [Decision](decisions/2026-09.md#2026-09-20--preserve-silence-clocks-through-compact-intrinsic-exclusion)
  records reuse of §9.1 and the original path's structurally empty adopted block.
  Fresh design review found no normative gap before implementation.
- Original/import/scope classifiers permit single-backing silence continuations
  with complete dependencies and no adopted block. Lapse and full target evidence
  keep priority; intrinsic exclusion does not advance state or clocks.
- Integrated independent adversarial review found no blocker. Four separate
  probe groups checked invalid/missing openings, withheld original dependencies,
  full-trail precedence and same-index repair. Verifier keys, circuits, candidate
  configuration and v2 runtime remain unchanged.

## Evidence

- Baseline `9bb963b` hosted CI `35498168247` passed. Its full runtime/package
  checks are reused: only isolated v3 replay scripts/tests and documentation change.
- Oracle probes passed 104 import/scope groups, 53 recovery groups and the final
  21 silence groups. These use ideal proof membership, real hashes/signatures and
  synthetic complete venue evidence; they do not establish proof relations.
- Final `check:pool:ergo-replay` passed 207 groups / 64 real proofs, including
  portable and fresh-process checks for 31 compact intrinsic acceptance/refusal
  cases. The retained [report](docs/pool-v3-local-replay-verification.json) binds
  54 verified source hashes; log: `scratch/compact-silence-real.log`.
  Syntax, documentation, companion-link and whitespace checks pass.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Compact exclusion cannot fill missing ancestors.

## Next

1. Delivery includes final remote-parity and exact-head CI inspection. Recheck
   hosted CI for the delivery commit if it was still pending when pushed.
2. Next capability: probe §9.1 shared-scope exclusion with complete sibling
   snapshots, canonical predecessor/clock dependencies and no adopted block.
   First falsify unknown sibling lapse and rollback through split/rejoin ancestry;
   review the design before dependent code and keep unsupported cases unresolved.
3. Nonempty adoption and other fault classes retain explicit conformance boundaries.

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
2026-09-20. Compact intrinsic exclusion reduces target-history availability needs;
this remains conditional evidence, with no runtime or release gate closed.
Runtime integration, selected venue/decoder, qualified custody and continuous
wallet operation dominate remaining effort. No rounded estimate change.

Stay with this instance for the next dependency probe: the relevant
classifier and specification context is fresh; no broader restart is needed.
