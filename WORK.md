# Current work

Updated: 2026-09-20

## Goal

Completed slice: investigate the compact exclusion-certificate dependency boundary
under C2.10.11–13 and pool-v3 §§9/10/12 before implementation. Resolve the inherited
Windows fresh-process CI failure as far as reproducible evidence permits.

Acceptance: map classification dependencies to rules/code, exercise withheld
history and precedence controls, independently review the conclusion, and deliver
a bounded next proposal. Verify the fixture worker's prepared-parameter startup
and complete real replay after its cache-path correction.
The investigation and fixture fix are reviewed and verified for delivery.
No classification change, normative amendment or runtime adoption in this slice.

## Status

- Delivery branch: `docs/compact-exclusion-boundary`, based on main `0e4838b`,
  for fast-forward delivery to main. Verify final parity and hosted CI from Git.
  No main branch protection or applicable ruleset gates were configured.
- [Dependency investigation](decisions/2026-09.md#2026-09-20--keep-compact-exclusion-behind-an-explicit-dependency-rule):
  current compact proof/authorization observations cannot replace missing target
  history for exclusion. A smaller intrinsic-fault certificate needs a reviewed
  amendment; missing predecessor, clock and range evidence remains unresolved.
- Existing exclusion authenticates complete event evidence and fails fast on a
  deterministic replay error. It does not finish reproducing semantic state after
  that failure. The next normative proposal must make that distinction explicit.
- The fixture worker now uses the parent's prepared `scratch/private-payment-crs`
  path instead of a separate environment/user cache. Verifier keys, circuits,
  configuration, classification and v2 runtime are unchanged.
- Companion specification remains clean main `e41cac8`; normative pin `fb7dd07`.
  No companion branch or normative edit in this slice.

## Evidence

- Prior delivery CI `35494161661` initially failed only the Windows v3 job at
  its first fresh worker; the worker's generic error does not establish cause.
  All six other jobs passed; the single failed-job retry also passed. Baseline
  hosted CI is green, while the original exception's cause remains unproven.
- Offline startup probe: prepared parameters succeed with zero fetches; empty
  scratch cache attempts two fetches and fails with injected network rejection.
  This proves an unintended startup dependency, not the original CI root cause.
- Focused `checkImports` execution passed 34 groups across both silence modes
  with ideal proof-membership oracle, real hashes/Ed25519 and synthetic venue.
  Independent normative/source and exact-proposal reviews completed; no blockers
  remain after held-sequence and independent-fault wording corrections.
- Final `check:pool:ergo-replay` passed 194 groups and 63 real proofs, including
  portable/fresh-process agreement. The [report](docs/pool-v3-local-replay-verification.json)
  binds 54 checked source hashes. Worker syntax, docs/links and whitespace pass.
  Broad runtime checks reuse the unchanged baseline's passing hosted CI.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Reported faults cannot fill missing history.

## Next

1. Inspect final hosted CI and remote parity for the delivery; local verification
   and review are complete. No unresolved review findings.
2. Next capability: review an explicit intrinsic exclusion rule before code.
   Resolve failed-replay wording and dependencies in the normative specification;
   then commit that specification before conditional proof/issue-K exclusion
   through original non-silence ancestry, successor descent and portable replay.
   Missing predecessors must refuse; later repairs extend the last valid prefix.
3. Keep silence, shared scope, adoption and other fault classes behind explicit
   conformance boundaries. Do not reinterpret current observational reports.

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
2026-09-20. This investigation and fixture correction add no product capability.
Runtime integration, selected venue/decoder, qualified custody and continuous
wallet operation dominate remaining effort. No rounded estimate change.

Stay with this instance for the next normative proposal: its dependency and
failed-replay context is fresh, and the implementation boundary is now explicit.
