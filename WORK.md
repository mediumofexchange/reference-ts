# Current work

Updated: 2026-09-12

## Goal

Complete ordinary local wallet operation beyond the fixed acceptance invoice.
Acceptance: caller-selected invoices, authenticated enrollment, verified one/two
note selection, exact saved payment retry, private delivery, historical status
and receipt/change recording, then another payment spending verified change.
Work: reference-ts/main, design 999d9a4; implementation is reviewed and fully
verified for main delivery. Baseline 150fdbd had
hosted CI 34704797024 passed. Companion money-from-first-principles/main 7ea0ee8
is unchanged. No protocol, circuit, derivation or custody schema change.

## Status

- [Operation profile](docs/POOL_WALLET_OPERATION.md) and developer commands use
  one shared payment builder. Inventory is the existing fulfilled records;
  checkpoint spentness, absence, reservations and historical fulfillment stay
  distinct. Selection supports two same-backing notes in one segment, no imports.
- One authenticated alias has one immutable payment. New duplicate-owner aliases
  and reused change owners refuse; post-proof reservation transactions recheck
  change use. Historical exact request replay and credential rotation remain
  available, while new ambiguous legacy payments refuse.
- Independent design/source review and narrow fix readbacks are closed with no
  unresolved material finding. Review resolved duplicate payment aliases, change
  collisions/races, pending change variants, Node 20 import order, reproof reuse,
  child cleanup ownership and historical request/rotation compatibility.
## Evidence

- Final full check passed 104 files / 1,876 tests and all process stages. Final
  focused operation/pairing passed 25 tests; final typecheck passed. Pinned real
  proofs passed both flows and independent public audit. Results/source hashes:
  [wallet evidence](docs/pool-wallet-verification.json).
- Existing HTTPS rotation, encrypted offline restores and 22 abrupt wallet commit
  exits/recoveries are retained. Ordinary acceptance funds 4 + 6, pays 7, records
  change 3 and pays it exactly; separate audit derived issued 20, burned 10,
  outstanding 10 after the combined original and ordinary flows.

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

1. Inspect hosted CI for the delivered main revision. Local verification and
   independent review are complete; verify remote delivery before continuation.
2. Define the smallest locally configurable wallet/operator flow that consumes
   caller-held signed terms and pinned authority/configuration instead of public
   fixture profiles. Separate holder commands from fixture issuance, and retain
   independently authenticated enrollment and checkpoint evidence. Keep it local.
3. Continuous/device-loss recovery needs its own concrete custody boundary.
   An old offline export cannot resume safely after later wallet activity. Do
   not add successor derivation/capsules to pinned v2. Imported-note selection
   and automatic consolidation need concrete flows before expanding this profile.
   External witness publication/applied Ergo history remain unestablished.

## Open questions

- About **45% done / 55% remaining**, plausible done range **35-55%**. Ordinary
  selection and command operation improve the wallet path within this coarse
  uncertainty; no external witness, device custody or runtime recovery gate closes.
- Largest blocks: runtime recovery and authenticated evidence/publication,
  qualified device custody and continuous recovery, supported user operation.
- Switch to a fresh instance for the next configurable wallet/custody slice: it
  benefits from fresh product context after this detailed retry review. This is
  an efficiency judgment, not measured comparative model performance.
