# Current work

Updated: 2026-09-12

## Goal

Extend configured wallets through encrypted offline handoff and credential
rotation. Acceptance: pay, stop listeners, freeze/export, restore with separately
retained profile/recovery digests, reconcile exact payment retries, rotate
receiver credentials with stale-binding refusal, then spend verified change.
Reject wrong credentials, conflicting files and occupied restore destinations.
Work: reference-ts/main, custody slice from feat/local-wallet-custody based on
af5ab7f. Hosted baseline CI 34711462707 passed. Implementation, independent review
and final full/real acceptance are complete. Read delivery CI for the commit
containing this handoff before the next slice.
Companion money-from-first-principles/main 7ea0ee8 remains unchanged: existing v2
and custody APIs only; no protocol, circuit, derivation or backup schema change.

## Status

- [Configured local profile](docs/POOL_LOCAL_PROFILE.md) now exposes encrypted
  export/restore/inspection and expected-generation receiver credential rotation.
  Existing backup schema, transaction fencing and pinned v2 proofs are unchanged.
- Export freezes before copying; exact file retries succeed and partial/conflicting
  files remain preserved. Restore requires a fresh destination. Lost replies are
  reconciled through the same destination's saved digest. One active copy remains
  a precondition; rotation readback uses restart without another generation change.
- Independent actual-source review closed with no unresolved material finding.
  Fixed native JSON parse errors quoting credential-bearing input; independent
  failed-process probe verified generic errors without the supplied secret prefix.
  File identities include Windows aliases, links and SQLite sidecars.
- One initial constant-payout backing, no reliance/imports/recovery clauses.
  Exact saved retries need no proof artifacts; new verification always uses the
  pinned real verifier. Local venue records and digest authentication stay modeled.
## Evidence

- Final full check passed 105 files / 1,882 tests and all process stages, including
  22 abrupt wallet commit exits/recoveries. Initial sandbox attempt could not
  start esbuild; the complete rerun outside that restriction passed.
- Final configured real-proof flow funds 4 + 6, pays 7, freezes/restores both
  wallets before checkpoint, compares the restored inbox before redelivery,
  reconciles exact statements/receipts without artifacts, rotates credentials,
  verifies change 3 and spends it. Separate audit: issued 10, burned 0,
  outstanding 10. All workers exited and owned acceptance directories removed.
- Hostile credentials/files, partial export recovery, busy-port rotation readback
  and stale bindings/generations passed. Source/log hashes and review disposition:
  [configured evidence](docs/pool-local-verification.json).

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
2. Define and independently review the smallest supported device custody and
   recovery boundary for the configured wallet. Select concrete protected
   database/WAL/key storage and recovery-record procedures, with failure drills
   and a falsifiable acceptance result, before claiming a usable wallet.
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
- Switch to a fresh instance for the next device custody/recovery design slice:
  it needs fresh assessment of deployment assumptions beyond this command review.
  This is an efficiency judgment, not measured comparative model performance.
