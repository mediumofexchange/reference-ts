# Current work

Updated: 2026-09-20

## Goal

Completed slice: compact authenticated bad-proof observations through original and
import descent at the conditional v3 layer. Reuse §9 openings and §12 kind-7
transport to retain provable committed bad proofs when unrelated history is
withheld. Fault authentication never grants exclusion or bypasses dependencies.

Acceptance demonstrated: exact target/directory/header/configuration binding; single/shared
scope and original-segment reads; withheld-history refusal and lapse priority;
valid/unsupported targets, verifier failures and pre-copy resource guards;
portable/fresh-process agreement, independent review and real-proof replay.
The bounded reporting capability is the stop boundary. Compact exclusion,
authorization/capsule/admission fault reporting and runtime adoption remain open.

## Status

- Delivery branch: `feat/compact-import-fault-evidence`, based on main `3c3d6a4`.
  Upstream fetched and baseline parity verified. Baseline CI 35489938677 passed;
  main has no branch protection or applicable ruleset gates.
- [Decision](decisions/2026-09.md#2026-09-20--report-compact-proof-faults-independently-of-checkpoint-classification)
  applies existing C2.10.11–12 and pool-v3 §§9/12. No normative amendment;
  companion specification remains main `e41cac8`, normative pin `fb7dd07`.
- Compact reports bind a held commitment/index, backing snapshot, position and
  exact field hashes to a strict proof-verifier rejection. Every scoped term
  must match the candidate configuration/venue. A sibling's directory digest
  can authenticate shared-chain evidence. Complete history still governs
  exclusion, clocks and selected state; selected envelopes remain complete.
- Local limits: 32 compact records, 1 MiB backing allocations, 1024 suffix
  entries each. Capture inventory once, use intrinsic byte views and bound
  before copying. Proof checks cache by exact item across scope fallback.

## Evidence

- Independent design and integrated adversarial review completed; no remaining
  blocker. Reviewer independently passed the 14-group import oracle and original
  segment refusal probe, plus ownership/getter/iterator/allocation variants.
- Full initial oracle probe: 63 groups plus compact portable agreement. Final
  focused import probe: 14 groups plus portable agreement; original-path case
  subsequently promoted from independent review into permanent acceptance.
- `npm run check` passed: typecheck, 110 files / 1941 tests, packaging,
  pilot/store/service/wallet checks, crash recovery and ten spent-set groups.
- Final real-proof replay passed 178 groups and 63 proofs: verified CRS then
  local-check --ergo, reusing npm check's build. The [retained report](docs/pool-v3-local-replay-verification.json)
  binds 51 verified source hashes and includes portable/fresh-process agreement.
  The fault record is 15,476 bytes; its partial package is 34,103 bytes versus
  50,020 for complete replay, which establishes the stronger exclusion verdict.
  Circuits, keys, configuration and runtime sources are unchanged.
- Final syntax, documentation/link and whitespace checks passed. No review owed.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Reported faults cannot fill missing history.

## Next

1. Inspect hosted CI for the delivery commit from Git; local acceptance is complete.
   Verify delivery/parity from Git rather than inserting a self-hash here.
2. Next bounded capability: compact committed authorization-failure observations
   using the same authenticated boundary. Probe issue K authorization first;
   do not turn proof/authorization facts into compact exclusion certificates.
3. A future proof-fixture cache must bind exact sources, artifacts/configuration
   and retain independent generation checks; do not interrupt this slice.

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

Roughly **50% done / 50% remaining**, plausible range **40–60%**. Reusable
recovery/receipt/count/lapse and compact fault evidence help; runtime integration,
selected venue/decoder, qualified custody and user operation dominate remaining
effort. No rounded estimate change.

Stay with this instance for the adjacent authorization-observation slice: the
reviewed evidence boundary and test fixtures are fresh context.
