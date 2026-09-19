# Current work

Updated: 2026-09-19

## Goal

Single-backing silence-bearing imports completed on `feat/v3-silence-imports`
from main 8ef0ef9 for delivery on `main`. Companion specification stays
`main` at 3ed1800 (no normative change).

Acceptance: real-proof replacement/import/payment/burn under a declared silence
clause, exact predecessor selection, strict-before clock and permanent segment
retirement; fresh seedless audit and receiver restoration from portable evidence.
Stale, withheld and retired closure refuses without partial state. Independently
answered empty publication ranges establish the supported empty adoption block;
any publication remains unsupported. No live chain or adoption claim.

## Status

- Implemented: one strict-before backing clock across replacement terms;
  each segment retains its first gap after opening even after another resets
  the clock. Excluded openings close nothing. Retired continuations lapse
  before state replay; finalized imported spent state and wallet paths persist.
- Design review identified the strict snapshot versus generic same-index import
  distinction. New silence openings at a same-index canonical predecessor
  refuse as unsupported before choosing between those rules.
- Fresh independent patch review found no material findings. The actual clock
  block matched an independent oracle in 98,415 exhaustive scenarios with
  2,340,090 boundary comparisons. Final real-proof execution passed.
- No runtime, circuit, key, dependency, device-control or specification change.
  Any attributed publication, same-index fresh silence opening, multi-backing
  closure and adoption remain unsupported. Import lapse requires full trail
  evidence; header-only lapse is an availability improvement.

## Evidence

- Main 8ef0ef9 CI 35450519224 passed (confirmed remotely this session).
  Reuses unchanged runtime/circuit/dependency baseline: all 1,934 tests,
  package/service/wallet/crash/spent acceptance and seven hosted jobs.
- Final `npm run check:pool:ergo-replay`: 63 groups / 19 real proofs pass,
  including the ended-term case, fresh seedless/receiver processes and refusal
  of retired closure. The silent portable package is 68,301 bytes; candidate
  Ergo replay uses 21 blocks / 3,684 raw bytes under trusted synthetic headers.
  [Retained report](docs/pool-v3-local-replay-verification.json); source hashes
  match the final files. Syntax and docs/link checks pass.
- The final main revision's hosted CI must be checked separately; the baseline
  above is not evidence for the changed experiment. No branch protections or
  required repository rulesets were present when inspected; none was altered.
- [Decision](decisions/2026-09.md#2026-09-19--read-silence-across-single-backing-imports-with-empty-publication-evidence).

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

1. Read the final main revision's hosted CI. Next product slice: force classification and ordered
   adoption of single-backing recovery publications, with fresh public audit
   and receiver restoration. Multi-backing remains separate.
2. P2 (publication on a node) confirms the measured 24-piece transaction;
   P4 measures exhaustion from index zero on a real chain; decoder node
   equivalence is a selection prerequisite. A decoder-refused transaction
   currently denies every range through its height.
3. Configuration approval stays disabled until all adoption prerequisites hold;
   device qualification and external publication remain separate dependencies.
   Do not alter this workstation's controls.

## Open questions

- Reassessed from current evidence: roughly **50% done / 50% remaining**,
  plausible range **40-60%**. Single-backing imports advance the experiment;
  selected venue/decoder, complete recovery, qualified custody and user
  operation remain the largest blocks. No percentage change is warranted.
- Switch to a fresh instance for recovery publication adoption, which needs focused review of
  force and adoption dependencies under the six existing proof relations.
