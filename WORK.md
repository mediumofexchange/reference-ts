# Current work

Updated: 2026-09-20

## Goal

Completed slice: compact intrinsic exclusion for non-opening, single-backing
checkpoints without silence, retaining complete ancestor/state dependencies.
The normative amendment was reviewed and committed before dependent code.

Acceptance: proof/issue-K rejection permits original and successor descent with
only target events withheld; full/compact evidence agrees on classification and
selected state. Missing predecessors, wrong bindings, unknown verifiers and
unsupported contexts refuse; repairs preserve last valid state and held sequences.
Portable/fresh-process real-proof acceptance and adversarial review passed.
No v2 runtime, configuration adoption or live-chain claim.

## Status

- Delivery pair: the implementation commit containing this handoff and companion
  `183c09f`, now on specification `main`. Branches
  `feat/compact-intrinsic-exclusion` and `spec/compact-intrinsic-exclusion` retain
  the pair. No main protection or applicable ruleset gates were configured.
- [Decision](decisions/2026-09.md#2026-09-20--permit-intrinsic-exclusion-with-complete-checkpoint-dependencies)
  and companion commit `183c09f` define §9.1 and clarify authentication versus
  failed state replay. Fresh normative review completed before specification commit
  and dependent code; no remaining design finding. Specification remote parity is verified.
- Three conditional classifier paths now allow a compact intrinsic failure only
  after resolving a valid opening and last valid state, for single-backing
  non-silence continuations with no adopted block. Complete evidence takes priority;
  other failures still require their full event evidence. Individual fault facts
  remain observational; checkpoint classification consumes an internal bound fact.
- Verifier keys, circuits, candidate configuration and v2 runtime are unchanged.
  Integrated adversarial review is complete after correcting and independently
  reproducing the original path's nonempty-opening prerequisite. No blockers remain.
  Final oracle fixtures passed 153 groups; full and real-proof acceptance passed.

## Evidence

- Baseline `e015d31` hosted CI `35495694827` passed. Inspect hosted CI for the
  implementation delivery commit after push; local final gates below passed.
- Companion links, syntax and whitespace checks pass. Final oracle run passed
  153 groups with ideal proof membership, real hashes/signatures and synthetic
  complete venue; reviewer separately checked the opening substitution correction.
- `npm run check` passed: 110 files / 1,941 tests plus packaging, local profile,
  pilot, store/service/wallet, crash and spent-set checks. The initial sandbox
  launch failed in esbuild startup; the authorized unrestricted rerun passed.
- `check:pool:ergo-replay` passed 202 groups / 64 real proofs, including portable
  and fresh-process checks. The retained report binds 54 verified source hashes.
  The measured compact package is 34,103 versus 50,020 bytes (about 32% smaller);
  this is one fixture shape, not a general compression guarantee.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Compact exclusion cannot fill missing ancestors.

## Next

1. Verify implementation delivery remote parity and inspect exact-head hosted CI.
2. Next capability: probe compact exclusion for a live single-backing checkpoint
   with silence, using complete canonical clock dependencies and lapse priority.
   First falsify clock reset/rollback after exclusion and missing-clock acceptance;
   if feasible, carry the slice through real-proof/portable/fresh-process checks,
   independent review and delivery. Review any normative gap before dependent code.
3. Keep shared scope, adoption and other fault classes behind their explicit
   conformance boundaries; individual fault observations still supply no state.

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

Switch to a fresh instance for the next capability: this cross-repository slice
is complete, and the clock/dependency probe has a bounded handoff above.
