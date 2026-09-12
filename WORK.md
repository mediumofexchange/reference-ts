# Current work

Updated: 2026-09-12

## Goal

Complete private HTTPS delivery between the existing v2 wallets: durable scoped
invoice capability, bounded canonical inbox frame committed before acknowledgment,
exact retry after lost replies/restart, and separate checkpoint verification.
Delivery: reference-ts/main, following b1773d2 (CI 34697364624 passed).
Use hosted CI for the exact delivered revision's platform results.
Companion money-from-first-principles/main at 7ea0ee8 is unchanged; runtime pin
and v2 circuits are unchanged. This is a local application profile under v2
sections 3 and 9, not v3 restoration, external finality or deployment.

## Status

- [Wallet](docs/POOL_WALLET.md): private delivery now crosses HTTPS between
  wallet processes. Durable per-invoice capabilities and immutable canonical
  inbox frames survive restart; exact replay returns the original hash.
- Original receipt proof/signature attestation is checked before inbox storage.
  Otherwise-valid re-proving cannot replace the original delivery. A stored
  acknowledgment never fulfills an invoice or asserts proof validity/finality.
- Receiver checkNote and fulfill still use caller-owned checkpoint evidence.
  Historical fulfillment lookup remains separate from current spendability.
- Independent adversarial design/patch review is complete. BOM framing and
  child-cleanup findings were fixed, exercised and read back; no material issue
  remains. Full local, real and ideal acceptance passed; hosted platform checks
  run on the delivered revision.
- Old duplicate private-payment framework was removed at b1773d2: 20 tracked
  files and dependencies, 203,307,820 bytes. Its [case map](docs/PRIVATE_PAYMENT_ARCHITECTURE.md#private-payment-experiment-case-map)
  retains active equivalents and immutable history links. No further broad
  deletion is needed; this slice's scratch evidence is captured in the record.

## Evidence

- Full npm check passed: 101 files / 1,836 tests, build, installed-package imports
  and all acceptance stages. Ideal and real flows include forced receiver
  termination with observed exit. Real issue 10/pay 7/burn 7+3 audits to zero.
- [Wallet evidence](docs/pool-wallet-verification.json) records
  current source hashes, TLS/HTTP/parser cases, real payment/public audit and
  12 abrupt exits plus 12 fresh recoveries across six transaction boundaries.
- The known venue, public TLS/obligor keys and trusted local pairing remain
  fixtures. Plaintext DB/WAL/backups, supported custody, rollback protection,
  authenticated pairing/discovery and certificate lifecycle remain open.
  SQLite requires Node 24; non-SQLite delivery imports retain Node 20 support.

### Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): bounded
  Ergo 6.0.5 / Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms.
  Sampled headers reached 97,923; all sampled full heights were null. No applied
  history or ancestry claim. Automatic result unresolved; final worker checks
  were not reached. Independent owner cleanup found no surviving processes or
  mapping, established exclusive image access and matching GPT identity.
- Retain detached fixed 20 GiB image and actual reports:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. ResumeSync's original configuration pin
  is spent; blindly repeating the one-time command will refuse admission.
- Native resume 56, disk 79, sync profile 25 and PowerShell resume 12 checks
  passed; read-only preflight passed. No unattended sync run is active.

## Next

1. Next product slice: select a concrete supported wallet custody and backup
   boundary, independently review it, then demonstrate private receive/pay after
   restart and explicit recovery without leaking secrets or reusing reservations.
   Resolve copied-database/rollback limits explicitly; do not add successor C4
   derivation or seed-only restoration capsules to the pinned v2 profile.
2. CLI proof paths still require one segment/no imports. Extend selection from
   the verified forest when a concrete multi-segment wallet flow requires it.
3. Applied Ergo history remains open. At heights 100,000, 1,000,000 and 1,500,000
   compare bounded parent links and bodies against pinned upper IDs. Body presence
   alone proves no ancestry; additional sync needs separate justification.

## Open questions

- Runtime recovery, authenticated evidence/publication, supported custody and
  rollback, deployed pairing/credentials and practical devices are the largest
  product blocks. HTTPS closes a local delivery boundary, not these release gates.
- About **45% done / 55% remaining**, plausible done range **35–55%**. Keep the
  coarse estimate: this integration fits within the existing uncertainty and
  the largest custody, external evidence and recovery work remains open.
- Recommend switching to a fresh instance for custody design once delivery is
  complete: use this handoff and wallet evidence; the next boundary benefits
  from fresh context. This is an efficiency judgment, not measured performance.
