# Current work

Updated: 2026-09-19

## Goal

Completed slice: multi-backing receipt reads through scope changes and recovery at
the conditional v3 layer. Authenticate the complete original scope and preserve
exact original/adopted inclusion, liability precedence and the earliest scoped
silence or term boundary. Missing required evidence refuses without inventing a
verdict or exposing wallet state.

Acceptance: seedless portable/fresh-process receipt reads, hostile scope/term/
clock and exact-evidence cases, independent integrated review, real-proof replay,
documentation and verified delivery. Stop after this receipt capability;
multi-backing non-service counts and runtime adoption remain separate work.

## Status

- Delivery branch: `feat/multi-backing-receipts`, based on main `d633fb0`.
  Fetched main/remote parity confirmed. Baseline hosted CI 35465879402 passed
  all seven jobs. Main has no branch protection or applicable ruleset gates.
- Scope receipt reads reuse whole-checkpoint classification. Every original
  backing contributes term/clock boundaries and transition carriage; all held
  sequences occupy their position for repair. Early inclusion ends the read.
  Original/adopted receipt queries expose no audit state or wallet candidates.
- [Decision](decisions/2026-09.md#2026-09-19--read-receipts-against-their-complete-original-scope)
  applies existing C2.10.9a–c and C2b.4.3. No normative amendment. Companion
  specification stays on clean main `e41cac8`; normative pin remains `fb7dd07`.

## Evidence

- Independent design and integrated adversarial reviews found no remaining
  material blockers. Focused readback covered both single/multi-scope dispatch
  directions and contradiction retention when a new sibling's evidence is absent.
- All 46 ideal-proof-oracle fixture groups passed against final sources,
  covering scope finality, adopted exact hashes, imported spent
  history, sibling-only abandonment/repair, occupied sequences, same-index
  inclusion, term/silence equality and missing evidence without partial state.
- Final `npm run check:pool:ergo-replay` passed 153 groups and 57 real proofs,
  including portable receipt packages, fresh seedless readers and the synthetic
  Ergo adapter. The [retained report](docs/pool-v3-local-replay-verification.json)
  binds all 46 verified source hashes. Circuits/keys/configuration are unchanged.
- Syntax and documentation checks passed. Baseline full-check/real-proof CI is
  reusable for unchanged runtime, relations and package inputs; this slice
  passed its required final experiment replay and documentation checks.
- Required multi-backing ancestry with non-service clauses remains unsupported.
  Import lapse still needs full trails. No runtime, authenticated live-chain,
  configuration-adoption or production spendability claim.

## Next

1. Inspect hosted CI for the delivery commit from Git; local acceptance is
   complete. Delivery/parity is recorded in Git, not self-hashed in this handoff.
2. Next capability: multi-backing non-service counts through scope changes and
   recovery. Start with C2b.5.1–2's strictly preceding canonical snapshot, first
   request index and distinct unserved tags; reuse complete-scope replay and
   refusal semantics. Review scope/count interactions before dependent code.
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

Roughly **50% done / 50% remaining**, plausible range **40–60%**. Complete-scope
receipt evidence adds reusable progress; runtime recovery, selected venue/decoder,
qualified custody and user operation still dominate. No rounded estimate change.

Stay with this instance for the next non-service slice if context remains fresh:
it reuses the same scope classifier and recovery dependencies. WORK.md is sufficient
for a fresh instance if switching is otherwise preferable.
