# Current work

Updated: 2026-09-12

## Goal

Complete a caller-configured local wallet/operator payment flow.
Acceptance: authenticated public signed terms and exact initial authority,
pinned real v2 proofs, holder commands without fixture signing keys or issuance,
locally configured operator, private payment and change followed by another
payment, rejection of changed/unsupported profiles, and exact restart/retry.
Work: reference-ts/main, configured profile slice from feat/local-wallet-profile,
based on e566ade (hosted CI 34709509899 passed). Local checks and independent
review are complete. Read hosted CI for the current main delivery before the next
slice. Companion money-from-first-principles/main 7ea0ee8 is unchanged: existing v2
only, no protocol, circuit, derivation or custody schema change.

## Status

- [Configured local profile](docs/POOL_LOCAL_PROFILE.md) authenticates canonical
  signed terms and initial authority against a caller-held digest and real v2 pins.
  Separate holder, receiver and operator commands share ordinary payment logic;
  the holder import graph excludes fixture keys and cannot issue.
- One initial constant-payout backing, no reliance/imports/recovery clauses.
  Exact saved retries need no proof artifacts; new verification always uses the
  pinned real verifier. Local venue records and digest authentication stay modeled.
- Independent design/source review and narrow fix readbacks are closed with no
  unresolved material finding. Store header constraints check before fencing and
  signing. File identity guards cover Windows aliases, links and SQLite sidecars;
  atomic file replacement, bounded publication and IPC cleanup are explicit.
## Evidence

- Final full check passed 105 files / 1,882 tests and all process stages. Profile
  and path checks passed, including otherwise-valid unsupported terms. Six new
  store guard tests passed. Results/source hashes:
  [configured evidence](docs/pool-local-verification.json).
- Existing HTTPS rotation, encrypted offline restores and 22 abrupt wallet commit
  exits/recoveries passed. Configured real-proof acceptance funds 4 + 6 through
  private issuance delivery, pays 7, restarts the operator, records change 3 and
  pays it exactly. Separate public audit: issued 10, burned 0, outstanding 10.
  All configured workers exited and their generated scratch files were removed.

## Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): bounded
  Ergo 6.0.5 / Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms.
  Sampled headers reached 97,923; full heights were null. No applied history or
  ancestry claim. Final worker checks were not reached; automatic result remains
  unresolved. Owner cleanup found no surviving processes or mapping, established
  exclusive image access and matching GPT identity.
- Retain detached fixed 20 GiB image and actual reports:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. ResumeSync's original configuration pin
  is spent; blindly repeating the one-time command refuses admission.
- Native resume 56, disk 79, sync profile 25 and PowerShell resume 12 checks
  passed; read-only preflight passed. No unattended sync run is active.

## Next

1. Verify remote parity and hosted CI for delivered main.
2. Extend the configured flow through encrypted offline export/restore and
   credential rotation using the existing custody format, without fixture
   profiles. Acceptance: pay, freeze/export, restore using independently retained
   profile/recovery digests, then exact retry and another verified payment.
3. Continuous/device-loss recovery needs its own concrete custody boundary.
   An old offline export cannot resume safely after later wallet activity. Do
   not add successor derivation/capsules to pinned v2. Imported-note selection
   and automatic consolidation need concrete flows before expanding this profile.
   External witness publication/applied Ergo history remain unestablished.

## Open questions

- About **45% done / 55% remaining**, plausible done range **35-55%**. Configured
  holder/operator operation improves the wallet path within this coarse
  uncertainty; no external witness, device custody or runtime recovery gate closes.
- Largest blocks: runtime recovery and authenticated evidence/publication,
  qualified device custody and continuous recovery, supported user operation.
- Switch to a fresh instance for the next configured custody/recovery slice: it
  benefits from fresh context after this detailed command/path review. This is
  an efficiency judgment, not measured comparative model performance.
