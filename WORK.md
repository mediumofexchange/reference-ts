# Current work

Updated: 2026-09-13

## Goal

Active slice: frame a portable exact-byte evidence package and use it for fresh
seedless/receiver local replay. Acceptance: independently reviewed normative
framing committed before codecs; canonical vectors, malformed/duplicate/order,
budget and aliasing refusals; real-proof package replay agrees with existing
audit without granting authority or completeness. Range authentication remains
a separate venue-profile dependency, not a fixture boolean.
Branches: reference `feat/v3-evidence-package`; companion
`spec/v3-evidence-package`. Both started at clean main with fetched parity.

## Status

- Specification §12 at 10dcf67 fixes canonical source-neutral evidence transport
  and the exact-request venue-evidence boundary. Independent normative review
  clarified the 355-byte receipt-record item; no material findings remain.
- Model codec and fresh-process package integration are implemented. Final
  codec tests, independent implementation review and delivery remain pending.
- Prior §11 configuration/signed-terms checks remain unchanged, including
  the existing exact cofactored signature equation and canonical identity R.
- Model-only codecs and candidate manifest/tooling are implemented. Replay
  derives its candidate domain from the frame and issuance key from signed
  terms. Original operator/genesis link restrict the fixture only; replacement,
  revocation, empty opening and checkpoint force still require venue evidence.
- Configuration and signed terms checks are separate from full authority.
  All candidates remain unspendable. No runtime Backing or declaration support.
- [Active decision](decisions/2026-09.md#2026-09-13--transport-exact-evidence-without-asserting-certificate-completeness).

## Evidence

- Baseline main 3eeac8b: CI 34720418325 passed. Both repositories fetched with
  parity before branching; no branch protections/rulesets reported.
- Typecheck and real `check:pool:local-replay`: 24 groups/8 proofs passed,
  including canonical package worker replay, omitted/conflicting objects,
  unsupported range assertions, budgets, shared storage and async ownership.
  Current run is scratch/pool-v3-local-replay-results.json; promote after review.
- Issue 10, pay 7/change 3, burn 5/change 2; public outstanding 5. Fresh audit
  and receiver agree with all six artifact identities checked. Candidate terms
  validity never sets the full terms-authority/currentness flags.
- Circuits/configuration/keys and production runtime are unchanged; reuse
  baseline conformance. Current typecheck and focused codec evidence are due.

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

## Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): Ergo 6.0.5 /
  Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms. Headers reached
  97,923; full heights null. No applied history/ancestry claim; unresolved result.
  Cleanup found no workers/mapping; exclusive image access and GPT identity held.
- Retain detached fixed 20 GiB image:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. Original ResumeSync pin is spent; blind
  repetition refuses. Native resume 56, disk 79, sync profile 25, PowerShell
  resume 12 checks and read-only preflight passed. No sync run is active.

## Next

1. Finish package codec tests, independent review, documentation and delivery.
2. Define authenticated record-range profile and complete dependency replay against
   the [package checks](docs/POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay).
   Independently review/commit normative certificate gaps before code.
3. Configuration approval stays disabled until all adoption prerequisites hold.
   Device qualification and external publication remain separate dependencies;
   do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-12: roughly **50% done / 50% remaining**, plausible done
  range **40-60%**. Checked candidate configuration and signed terms are reusable
  progress; they do not materially move the coarse estimate while recovery and
  authority gates remain. Largest blocks: runtime recovery, authenticated range
  evidence/publication, qualified custody/continuous recovery and user operation.
- Stay with the current instance through package acceptance; switch to a fresh
  instance for venue-range authority design. This is a context-efficiency
  recommendation, not measured model performance.
