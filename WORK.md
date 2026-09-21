# Current work

Updated: 2026-09-21

## Goal

Completed slice: compact intrinsic exclusion for live non-opening shared-scope
checkpoints, with complete sibling snapshots and ancestor/state/clock dependencies.
Unknown sibling lapse and split/rejoin rollback probes passed before final acceptance.

Acceptance: proof/issue-K rejection permits shared-scope descent with only target
events withheld; full/compact evidence agrees for either selected backing on state,
classification and clocks. Unknown sibling state/lapse refuses; faults never reset
clocks or restore spent holdings. Portable/fresh-process real-proof checks and
independent design/integrated review passed. Stop boundary: conditional v3
replay only, with no adopted-block, other fault class, runtime or adoption expansion.
Specification §9.1 at 183c09f covers complete scopes; application was reviewed.

## Status

- Commits `b14618f` (implementation) and `8df5654` (acceptance record) are
  merged locally into `main`, based on delivered `dc7a848`.
  Companion `main` and `spec/compact-intrinsic-exclusion` remain at `183c09f`;
  no specification edit needed. Both baseline remotes match. No main protection
  or applicable ruleset gates were configured when checked before delivery.
- [Decision](decisions/2026-09.md#2026-09-20--resolve-the-complete-shared-scope-before-intrinsic-exclusion)
  records reuse of §9.1 and the complete scope classifier's dependency walk.
  Fresh design review found no normative gap before implementation.
- The scope classifier now permits shared continuations with complete dependencies
  and no adopted block. Lapse and full target evidence keep priority; exclusion
  does not advance state or clocks. Original/import dispatch is unchanged.
- Integrated independent adversarial review found no blocker. Four separate
  probe groups checked faulty selections, unknown verifiers, repaired-commitment
  isolation and corrupted sibling terms. Verifier keys, circuits, candidate
  configuration and v2 runtime remain unchanged.

## Evidence

- Baseline `dc7a848` hosted CI `35499823557` passed. Its full runtime/package
  checks are reused: only isolated v3 replay scripts/tests and documentation change.
- Oracle probes passed 39 scope and 32 scope-recovery groups, including cross-sibling
  proof/K faults, sibling snapshot/term/range refusal, repair, split/rejoin rollback,
  silence and adoption boundaries. Proof membership is ideal; hashes/signatures are real.
- Final `check:pool:ergo-replay` passed 218 replay groups / 65 real proofs,
  including portable and fresh-process checks; 58 compact shared-scope cases are
  retained in the report. The [report](docs/pool-v3-local-replay-verification.json)
  binds 55 source hashes and matches the delivered files. Log:
  `scratch/compact-shared-real.log`. Syntax, documentation, companion-link and
  whitespace checks pass.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Compact exclusion cannot fill missing ancestors.

## Next

1. Push `b14618f` and `8df5654`, then verify remote parity/exact-head CI when the
   account gate clears.
   The push was rejected by automatic approval review for the account usage limit;
   no workaround was attempted. Local `main` is ahead of `origin/main` by two.
2. Next capability: probe §9.1 intrinsic faults outside a nonempty adopted block.
   First falsify confusing an adopted position with a local target and skipping
   exact publication/dependency evidence. The intrinsic cache currently retains
   only the failure check, so position eligibility needs explicit investigation.
   Review before dependent implementation.
3. Targets inside an adopted block and other fault classes retain ordinary evidence.

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

Switch to a fresh instance for the adopted-block probe: the shared-scope slice
has a bounded handoff, and the next review centers on publication positions and
inherited adoption rather than the completed scope extension.
