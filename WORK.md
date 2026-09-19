# Current work

Updated: 2026-09-19

## Goal

Completed slice: multi-backing non-service counts through scope changes and recovery
at the conditional v3 layer. Count the independently selected backing's requests
against its canonical state strictly before judgment, preserving first identity
indices, imported anchors, spent tags and live locks. Unadopted publications do
not change the counting state; missing required evidence refuses the complete read.

Acceptance: independent selected-backing counts through split/rejoin/handover and
recovery, strict-index/refresh/lock/spent adversarial cases, seedless portable and
fresh-process agreement, reviewed design/patch, real-proof replay and delivery.
Stop after this complete counting capability; runtime adoption remains separate.

## Status

- Delivery branch: `feat/multi-backing-non-service`, based on main `9edf6dd`.
  Fetched main/remote parity confirmed. Baseline hosted CI 35467656025 passed
  all seven jobs. No branch protection or applicable ruleset gates at last read.
- The existing counter now reads shared canonical history strictly before
  judgment. Each selected backing retains its own duration, threshold and window;
  a missing clause adds no count or request-range dependency. Recovery effects
  enter the count only once adopted into a prior canonical checkpoint.
- [Decision](decisions/2026-09.md#2026-09-19--count-each-backings-requests-against-shared-canonical-history)
  applies existing C2b.5.1–2 and C2.10.3–7. No normative amendment. Companion
  specification stays on main `e41cac8`; normative pin remains `fb7dd07`.

## Evidence

- Independent design and integrated adversarial reviews found no remaining
  material blockers. Final readback covered initial-index and publication-index
  bounds, absence/receipt isolation, cached ranges and portable/fresh-process wiring.
- Final proof-oracle probe passed all 60 groups, including the last boundary
  assertions. Six new request proofs reuse existing note/history traces.
- Final `npm run check:pool:ergo-replay` passed 168 groups and 63 real proofs,
  including portable packages, fresh count readers and the synthetic Ergo
  adapter. The [retained report](docs/pool-v3-local-replay-verification.json)
  binds 47 checked source hashes. Circuits/keys/configuration are unchanged.
- Syntax and documentation checks passed. Baseline full-check/real-proof CI is
  reusable for unchanged runtime, relations and package inputs; this slice passed
  its required experiment acceptance and documentation checks.
- Import lapse still needs full trails. No runtime, authenticated live-chain,
  configuration-adoption or production spendability claim.

## Next

1. Inspect hosted CI for the delivery commit from Git; local acceptance is
   complete. Delivery/parity is recorded in Git, not self-hashed in this handoff.
2. Next capability: import-lapse classification without complete history trails.
   Start with C2.10.4 and C2.10.12's authenticated scope/term lapse evidence,
   exact snapshot/header binding and package dependency rules. Probe withholding
   a lapsed checkpoint's history while preserving all required public evidence;
   preserve unresolved-versus-excluded distinctions and original-prefix clocks.
   Review this evidence boundary before implementation; no runtime adoption.
3. A future proof-fixture cache must bind exact sources, artifacts and configuration
   and retain independent generation checks. Do not interrupt the active slice.

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
receipt and count evidence is reusable progress; runtime integration, selected
venue/decoder, qualified custody and user operation dominate remaining effort.
No rounded estimate change.

Switch to a fresh instance for the next import-lapse evidence slice: it changes
the evidence-availability boundary and benefits from focused context. This
handoff retains the verified shared-replay work and the next decisive probe.
