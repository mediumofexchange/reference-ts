# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Next is the invalid-checkpoint recovery
contract, with exact authenticated evidence and explicit receipt consequences.

## Status

- Implementation: `main`, with repository cleanup based on `f3ca8b4`.
  [Architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md) owns the component map;
  [fault recovery](docs/POOL_FAULT_RECOVERY.md) owns the consolidated proposal,
  reader contract, evidence and alternatives. Superseded drafts live in Git.
- Companion `main`: `8eb6a8c` (README cleanup only); normative recovery remains
  `c5f5464`. Site `c93f1cf` and organization profile `ab91195` now link to the
  implementation's setup instructions and describe the current pool.
- Runtime remains v2 and PoolStore refuses silence clauses. Historical
  retirement is modeled. Fault clocks and R6/R7 remain unselected research.
- Retain the frozen private-payment fixture until receiver/invoice and
  independent-audit crash/retry cases move to the pool/wallet path.
- Retain the active offline Ergo probe and build/browser/setup caches in
  `scratch/`. Obsolete probes and merged local feature branches are removed.
  The modified detached `moeclean` worktree outside this workspace is untouched.

## Evidence

- Independent cleanup review confirmed preservation of active fault assumptions,
  alternatives, costs, gates and component retirement conditions.
- All 76 durable decisions and all regression tests remain. Documentation and
  link checks pass across all four repositories; presentation diffs reviewed.
- Full `npm run check` passed after cleanup: 85 files / 1,606 tests, typecheck,
  build, installed package, pilot and pool-store crash checks. Windows esbuild
  and process checks required sandbox escalation. No runtime behavior changed.

## Next

1. Draft one specification proposal for term-only non-carrying resets, R6/R7,
   exact checkpoint-evidence continuity, verification-failure classification
   and authenticated complete-range retrieval. Check C0a before adopting
   FaultWorld or freezing v3 bytes; use the consolidated fault document.
2. Continue [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md): target phone,
   authenticated note delivery/restoration, independently available evidence
   and pinned-node publication. Offline sizes do not establish node acceptance.

## Open questions

- Finite ideal reads supply no production retrieval/scaling result. Measure
  suffix/ancestry retention and cold reads; cached verdicts do not replace
  retained evidence or current snapshots.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
