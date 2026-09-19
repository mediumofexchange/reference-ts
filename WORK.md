# Current work

Updated: 2026-09-19

## Goal

Completed slice: multi-backing recovery through a scope change at the conditional
v3 layer, with seedless public audit, restored candidate note paths and service
continuation after exact adoption.

Each backing retains its original-prefix silence clock and inherited adoption
index. Return adopts the owed publication union in venue order with exact
proof/authorization bytes. Shared ancestry, totals, standing demands and historical
retirement survive scope changes. Missing evidence refuses the complete read.
Acceptance includes unequal obligations, seedless audits, issuer-note restoration
and subsequent payment. No runtime, live-chain or production spendability claim.

## Status

- Delivery branch: `feat/multi-backing-recovery`, based on main `0b7b242`.
  Baseline hosted CI 35463289247 passed all seven jobs; inspect the delivery
  commit's hosted run separately. Delivery/parity is recorded in Git.
- Scope recovery now reads strict-prefix clocks, preserves per-backing adoption
  indices, orders the exact publication union and carries causal demand ancestry.
  Shared event identities, totals and original-tree restoration remain intact.
- Existing C2b.3.1–4.2, C2b.6.1 and C3.7 apply; no normative amendment. Companion
  specification stays on main e41cac8; normative pin remains fb7dd07.
## Evidence

- Fifteen normal-scope and eleven recovery fixture groups passed with an ideal
  proof oracle. Recovery includes unequal adoption obligations, global ordinal
  conflicts, exact bytes, unselected issuer/range evidence, historical retirement,
  mixed durations and incomparable demand/spend/settle/withdraw conflicts.
- Independent design and integrated adversarial reviews found no remaining
  material blockers; final actual kind-2 conflict fixture was read back.
- Final real replay (`prepare-crs.mjs`, then `local-check.mjs --ergo`) passed
  132 groups and 57 real proofs, including fresh seedless and wallet processes.
  The [retained report](docs/pool-v3-local-replay-verification.json) binds all 45
  exact source hashes, unchanged circuit identities and candidate configuration.
  The two-backing recovery package is 242,791 bytes.
- Exact adoption bytes precede backing/demand guards, preserving the old
  reordered-block verdict. Independent readback and 39 old ideal-oracle
  recovery/receipt/count groups passed before final real acceptance.
- All 1,934 tests passed cleanly with two workers after default Vitest reported
  an onTaskUpdate worker timeout. Every full-check component passed: docs,
  typecheck, packaging, profile, pilot, service, wallet, crash and spent-set checks.
- Required multi-scope ancestry with non-service clauses and multi-backing
  receipt queries remains unsupported. Single-backing receipts/counts are separate.

## Next

1. Check main/remote parity and hosted CI for the delivery commit from Git.
2. Next slice: multi-backing receipt reads through scope changes and recovery.
   Start with C2b.4.3 and C2.10.9b's complete receipt scope, liability precedence
   and earliest silence/term boundary. Reuse the verified scope classifier;
   require exact original/adopted inclusion and refusal on missing dependencies.
   Multi-backing non-service counts follow that slice.
3. Import lapse still needs full trails. A future proof-fixture cache must bind
   exact sources, artifacts and configuration and retain independent generation
   checks. Neither improvement should interrupt the active capability slice.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- Ergo node is stopped. Retain the detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and the
  verified parameter/tool caches. Do not delete the image or allocate another.
  [Sync handoff](docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. P2 node publication, P4 real-chain exhaustion,
  decoder equivalence and authenticated venue evidence remain open.
- The legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**. Shared recovery
replay is reusable progress; runtime recovery, selected venue/decoder, qualified
custody and user operation still dominate remaining work. No estimate change.

Switch to a fresh instance for the receipt slice: its liability and scope-boundary
rules benefit from focused context; this handoff contains the completed evidence.
