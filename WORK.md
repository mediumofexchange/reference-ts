# Current work

Updated: 2026-09-12

## Goal

Candidate v3 configuration and signed constant-root terms are checked before
real local replay. Canonical vectors, independent review, hostile substitution
refusal and fresh seedless/receiver agreement passed. V2 still refuses v3;
no adoption, currentness or spendability claim.

Implementation main includes 2d3f997 from feat/v3-configuration-evidence.
Follow-up branch: test/v3-identity-signature-oracle; test-only CI portability fix.
Companion: spec/v3-configuration-evidence, 916bffb merged/pushed to main.
No production runtime, circuit, key, dependency or host-control change.

## Status

- Specification §11 fixes a 439-byte configuration (six circuit/key pairs,
  helper, bounds, delivery profile) and signed constant-root terms. Independent
  review resolved a signature-wording ambiguity: preserve the existing exact
  cofactored verification equation, including canonical identity R.
- Model-only codecs and candidate manifest/tooling are implemented. Replay
  derives its candidate domain from the frame and issuance key from signed
  terms. Original operator/genesis link restrict the fixture only; replacement,
  revocation, empty opening and checkpoint force still require venue evidence.
- Configuration and signed terms checks are separate from full authority.
  All candidates remain unspendable. No runtime Backing or declaration support.
- Independent implementation review and final real-proof acceptance passed.
  [Decision](decisions/2026-09.md#2026-09-12--check-candidate-v3-configuration-and-signed-root-terms-before-local-replay).

## Evidence

- New codec tests: 14 passed; full `npm run check`: 1,896 tests plus package,
  service/wallet/crash checks passed. Canonical independent byte/hash
  oracles, every config identity, strict terms signatures, hostile lengths,
  clause order, minimal integers, shared buffers and v2 refusal are covered.
- Prior e440bdb CI: all seven jobs passed, run 34717617310; both main branches
  had remote parity before this slice. No branch protections/rulesets reported.
- Combined `npm run check:pool:v3`: 304 checks/18 real proofs plus 21 local
  replay groups/8 proofs passed. Final local replay passed after relation-order
  freezing; [report](docs/pool-v3-local-replay-verification.json) source hashes
  all match final files. Independent review reproduced the candidate domain.
- Issue 10, pay 7/change 3, burn 5/change 2; public outstanding 5. Fresh audit
  and receiver agree with all six artifact identities checked. Candidate terms
  validity never sets the full terms-authority/currentness flags.
- CI 34719550226: both v3 proof jobs passed; Node 24.20 general checks exposed
  a Node/OpenSSL identity-R oracle difference. The test now constructs A=B,
  R=identity, S=k directly; focused 10 tests passed. Final CI still owed.

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

1. Verify delivered main parity and hosted CI for this handoff revision.
2. Define complete certificate/dependency framing and authenticated record-range
   inputs, then integrate complete replay against
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
- Switch to a fresh instance for complete range/certificate authority design;
  this completed slice and its retained report isolate the configuration checks.
  This is a context-efficiency recommendation, not measured model performance.
