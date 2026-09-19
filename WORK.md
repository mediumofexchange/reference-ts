# Current work

Updated: 2026-09-19

## Goal

Single-backing recovery-publication force and ordered adoption completed on
`feat/v3-recovery-publications` from main 6a7d112 for delivery on `main`. Companion specification
stays `main` at 3ed1800; no normative change.

Acceptance: real-proof demand, withdrawal and settlement during silence;
exact force at the original prefix, complete adoption on return, then payment
and restoration in fresh public, receiver and backer processes. Hostile order,
substituted evidence, lock conflicts, replay and withheld closure refuse
without partial state. No live chain or configuration-adoption claim.

## Status

- Implemented: publication groups precede checkpoints at their index; force
  uses the strictly earlier snapshot plus accumulated effects with its forest
  fixed. Only demand, withdrawal and release have force; malformed, invalid,
  misrouted and unauthorized publications have none.
- Empty openings inherit the predecessor's adoption index. Non-opening
  checkpoints start with the complete block through the opening index,
  preserving original proof/signature bytes. Effective statement identities
  persist after discharge; standing demands and individual locks import.
- Lit settlement outputs restore from public fields and the seed. Ordinary
  post-return payments retain the existing capsule restoration path.
- Independent design and patch reviews closed with no unresolved material
  finding. Boundary, second-silence, exact-evidence, lock and replay cases
  received focused readback. Final real-proof execution passed.
- [Decision](decisions/2026-09.md#2026-09-19--classify-and-adopt-single-backing-recovery-publications).

## Evidence

- Main 6a7d112 hosted CI 35452105469 passed all seven jobs this session.
  Reuse that unchanged runtime/circuit/dependency baseline: 1,934 tests and
  package/service/wallet/crash/spent plus real v2/v3 proof acceptance.
- Final `npm run check:pool:ergo-replay`: 74 groups / 31 real proofs pass,
  including fresh seedless, receiver and backer processes. Earlier fixture
  refusal expectations were corrected after independent review.
  The portable recovery package is 128,236 bytes. The unchanged synthetic
  Ergo import trace uses 21 blocks / 3,684 raw bytes; recovery force uses the
  fixture venue, with no new node-publication claim.
- Syntax, docs/index/link checks and focused diff review pass. The
  [retained report](docs/pool-v3-local-replay-verification.json) has source
  hashes verified against the final files.
- Delivery target is `main`; its final hosted CI must be checked separately
  from the baseline above. No branch protections or required rulesets exist.
  No safeguards changed.

## Existing local product and custody boundary

- Configured v2 supports one constant-payout backing, real-proof local payments,
  private delivery and independent public audit. Venue/digest authentication
  are locally modeled. No real funds or host controls changed.
- Offline handoff freezes source and binds one destination. Mark paper export
  historical before activating the matching unfrozen restore; lost replies stay
  with that destination. Old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): automatic preflight
  fail; directory ACL refused, BitLocker/PIN and Secure Boot unavailable.
  Physical theft, cross-account, power-loss, backup isolation and continuous
  recovery qualification need separately authorized test hardware/provisioning.
- Ergo node stopped; [continuation report](docs/ergo-node-sync-resume-verification.json)
  (headers 97,923, full heights null, unresolved). Retain the detached 20 GiB
  image scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd;
  do not delete it or allocate another. No sync run is active.

## Next

1. Read final main hosted CI, then continue the next complete recovery path:
   receipt finality across silence/return, followed by the
   non-service count and its signed terms/configuration dependencies.
2. Same-index fresh silence openings with a same-index predecessor and
   multi-backing closure remain unsupported. Import lapse requires full trails.
   The count, receipts and authenticated venue evidence remain open.
3. P2 confirms the measured 24-piece transaction on a node; P4 measures
   exhaustion from index zero on a real chain. Decoder node equivalence is a
   selection prerequisite; a decoder refusal denies ranges through its height.
4. Configuration approval stays disabled until adoption prerequisites hold.
   Device qualification and external publication remain separate dependencies.

## Open questions

Reassessed from existing evidence: roughly **50% done / 50% remaining**,
plausible range **40-60%**. Reusable recovery logic has advanced; selected
venue/decoder, complete recovery, qualified custody and user operation remain
the largest blocks. No percentage change is warranted.

A fresh instance is recommended for the receipt-finality slice: it crosses
receipt precedence and recovery boundaries beyond this force/adoption review.
