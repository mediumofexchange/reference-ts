# Current work

Updated: 2026-09-20

## Goal

Completed slice: import-lapse classification without complete history trails at
the conditional v3 layer. Authenticate the exact backing snapshot, header and
scoped signed terms independently of event history. Missing live evidence remains
unresolved; validity and exclusion require the full committed trail.

Acceptance demonstrated: single/shared-scope term and silence lapse with withheld
history; hostile snapshot/header/term/range and live-history cases; original-prefix
clocks; portable and fresh-process agreement; independent design/patch review and
real-proof replay. Runtime adoption and new normative formats remain outside scope.

## Status

- Delivery branch: `feat/import-lapse-evidence`, based on main `31b2ae6`.
  Upstream fetched and baseline parity verified; no branch protection or applicable
  ruleset gates. Prior main CI 35469049390 passed. Inspect delivery CI from Git.
- [Decision](decisions/2026-09.md#2026-09-20--authenticate-import-lapse-independently-of-event-history)
  applies existing C2.10.4 and C2.10.11–12. No normative amendment; companion
  specification remains main `e41cac8`, normative pin `fb7dd07`.
- Reuse bounded trail containers with omitted records as public scope evidence.
  An ended scoped term takes precedence over an unknown sibling link. One carried
  snapshot binds the entire header even if its directory omits a sibling.
  Directory/sibling-snapshot finalization checks follow term and silence lapse.
  Invalid term copies cannot shadow authentic scope evidence, including receipts.

## Evidence

- Independent design and integrated adversarial reviews completed. Critical
  readback confirmed the directory/snapshot ordering fix; malformed-term discovery
  was independently reproduced with actual codecs. No remaining review blocker.
- Focused proof-oracle scope/recovery probe passed all 60 groups. Final
  `npm run check:pool:ergo-replay` passed 170 groups and 63 real proofs, including
  seedless portable packages, fresh readers and the synthetic Ergo adapter.
  The [retained report](docs/pool-v3-local-replay-verification.json) binds 48
  checked source hashes. Circuits, keys, configuration and runtime are unchanged.
- Syntax and documentation checks passed. Baseline broad runtime/proof CI remains
  reusable for unchanged inputs; the changed experiment passed its full acceptance.
- Selected state still requires its complete selection envelope. Compact fault
  certificates, runtime integration and authenticated live-chain evidence remain
  open. No configuration-adoption or production spendability claim.

## Next

1. Inspect hosted CI for the delivery commit from Git; local acceptance is complete.
   Verify delivery/parity from Git rather than adding a self-hash to this handoff.
2. Next capability: compact authenticated fault evidence through import descent.
   Start with C2.10.11–12, pool-v3 §§9–10 and `model/pool-v3-fault-evidence.ts`.
   Probe one committed invalid proof with an authenticated evidence-chain opening
   while withholding unrelated events. Distinguish fault authentication from a
   complete exclusion verdict, preserving lapse priority and original-prefix
   dependencies. Review the evidence boundary before dependent implementation.
3. A future proof-fixture cache must bind exact sources, artifacts and configuration
   and retain independent generation checks; do not interrupt the active slice.

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

Roughly **50% done / 50% remaining**, plausible range **40–60%**. Shared recovery,
receipt, count and history-free lapse evidence are reusable progress; runtime
integration, selected venue/decoder, qualified custody and user operation dominate
remaining effort. No rounded estimate change.

Switch to a fresh instance for compact fault evidence: it changes the exclusion
evidence boundary and benefits from focused context. This handoff retains the
verified import-lapse result and next decisive probe.
