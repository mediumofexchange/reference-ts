# Current work

Updated: 2026-09-20

## Goal

Completed slice: compact committed authorization-failure observations through
original/import descent at the conditional v3 layer. Reuse §9 and §12 kind-7
evidence for issue K, settlement K/presenter and withdrawal presenter failures.
Resolve presenter identity from the exact named demand statement preimage.
The boundary and integrated patch are independently reviewed. No classification shortcut.

Acceptance: exact signer/target/demand binding, wrong-key and sibling-key cases,
missing/substituted preimages, valid controls and combined faults; unchanged
withheld-history refusal/lapse; portable/fresh-process and real-proof agreement.
Stop after authorization observations are reviewed, verified and delivered.
Compact exclusion, capsule/admission faults and runtime adoption stay outside scope.

## Status

- Delivery: `feat/compact-authorization-evidence`, based on main `7bd70c9`,
  fast-forwarded to main. Verify delivery/parity and hosted CI from Git.
  Baseline CI 35491741767 passed;
  main has no branch protection or applicable ruleset gates.
- [Decision](decisions/2026-09.md#2026-09-20--resolve-compact-authorization-faults-from-committed-identities)
  applies existing C2.10.11–12 and pool-v3 §§9/12. No normative amendment;
  companion specification remains main `e41cac8`, normative pin `fb7dd07`.
- Compact reports bind a held commitment/index, backing snapshot, position and
  exact field hashes to strict proof/signature rejection. Every scoped term
  must match the candidate configuration/venue. A sibling's directory digest
  can authenticate shared-chain evidence. Complete history still governs
  exclusion, clocks and selected state; selected envelopes remain complete.
- K follows the target backing. Presenter identity uses the exact named demand
  preimage; its enclosing opening need not authenticate. This proves no demand
  admission or standing. Missing preimages do not suppress independent K faults.
- Local limits: 32 compact records, 1 MiB backing allocations, 1024 suffix
  entries each. Capture inventory once, use intrinsic byte views and bound
  before copying. Proof checks cache by exact item across scope fallback.

## Evidence

- Independent design and integrated adversarial review completed without blockers.
  Primary and reviewer each passed 103 oracle fixture groups. Reviewer separately
  checked maximum-u64 deadline, exact acceptance/release messages, absent
  dependencies, malformed widths, zero owner and withdrawal with real signatures.
- Final `npm run check:pool:ergo-replay` passed 194 groups and 63 real proofs,
  including portable/fresh-process agreement for all six authorization packages.
  The [retained report](docs/pool-v3-local-replay-verification.json) binds 54
  verified source hashes. Packages range from 17,928 to 51,690 bytes.
- Baseline `npm run check` passed 110 files / 1941 tests and operational checks;
  hosted CI passed. Runtime/model, circuits, keys and configuration are unchanged,
  so that evidence is reused. Syntax, documentation/link and whitespace checks pass.
- Direct bad-authorization targets cover original source/recovery records,
  successor descent and sibling scopes. Adopted-block target coverage remains
  indirect through existing exact-original-byte adoption checks; no broader claim.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Reported faults cannot fill missing history.

## Next

1. Inspect hosted CI for the delivery commit; local acceptance and review are
   complete. Verify parity from Git rather than inserting a self-hash here.
2. Next bounded investigation: review the complete compact exclusion-certificate
   dependency boundary against C2.10.11–12 before proposing implementation.
   Current proof/authorization observations cannot shortcut missing history.
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

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-20 after authorization evidence. Reusable recovery and compact fault
verification reduce integration uncertainty; runtime integration, selected venue/
decoder, qualified custody and continuous wallet operation dominate remaining
effort. No rounded estimate change.

Switch to a fresh instance after delivery: the next certificate-design question
needs focused normative context; this handoff preserves the completed evidence.
