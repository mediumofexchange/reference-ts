# Current work

Updated: 2026-09-12

## Goal

Receiver note verification is implemented and locally verified: unspent/spent
at an exact caller-selected checkpoint, saved fulfillment lookup after lost
replies, and no second fulfillment. The next product slice is private delivery
using the existing wallet; the duplicate experiment has been removed.

Delivery: reference-ts/main; receiver implementation 6ac2d18, cleanup follows it.
Companion money-from-first-principles/main at 7ea0ee8 remains unchanged.
Pinned v2 sections 3 and 8–11 already define the implemented note checks.
No normative, circuit, proof-key, database-schema or protocol byte change.

## Status

- [Wallet](docs/POOL_WALLET.md): checkNote validates request/owner, exact verified
  output inclusion and locally derived nullifier status. It reads imported
  events too; a handle remains bound to one configured segment.
- CLI checks unspent before receiver fulfillment and payer proof preparation.
  An old checkpoint may still report unspent after a later spend. Historical
  fulfill/received semantics remain unchanged; no latest-state assertion.
- fulfillment(id) returns owned original opening/receipt/checkpoint bytes for
  lost-reply reconciliation. Duplicate writes remain conflicts; a saved record
  never authorizes another external credit or delivery.
- Independent design and patch review found no unresolved material defect.
  Readback strengthened exact authority rejection and imported-spentness tests.
- [Experiment case map](docs/PRIVATE_PAYMENT_ARCHITECTURE.md#private-payment-experiment-case-map)
  now maps receiver, proof, admission, replay, audit and crash cases to active
  coverage. No unique protocol case requiring the duplicate framework was found.
  Historical contract/results have immutable Git links. Removed 20 tracked
  framework files and their dependencies: 203,307,820 bytes in total.

## Evidence

- [Wallet evidence](docs/pool-wallet-verification.json): full local npm check
  passed: 100 files / 1,820 tests, build, package, pilot, service, ideal wallet,
  eight wallet crash/recovery cases and spent-set acceptance.
- Final focused wallet suite passed 12 tests, including the added grandchild
  imported-nullifier regression. Independent review executed the earlier
  11-test patch and read back added coverage.
- Current real-proof wallet acceptance passed: issue 10, pay 7, verified receiver
  and change, burn 7 + 3, separate public audit outstanding zero, hostile
  histories, exact retries and receiver spent status with unchanged saved record.
- Local fixture venue, public obligor keys and plaintext DB/WAL/backups remain.
  No external finality, supported custody, rollback protection, private network
  delivery or external-goods atomicity is claimed. SQLite requires Node 24;
  Node 20 root imports remain supported. No deployment or real funds.

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

1. Develop private authenticated delivery and supported wallet custody with
   existing v2 outputs and fresh receiver requests. Select a concrete local
   transport/custody boundary before implementation; do not add successor C4
   derivation or capsules to v2. Full seed-only restoration remains separate.
2. Imported note checks are covered, but CLI proof paths still require one
   segment/no imports. Extend path selection using the existing verified forest
   when a concrete multi-segment wallet flow requires it.
3. Applied Ergo history remains open. At heights 100,000, 1,000,000 and 1,500,000
   compare bounded parent links and bodies against pinned upper IDs. Body
   presence alone proves no ancestry; additional sync needs separate justification.

## Open questions

- Full recovery, authenticated evidence/publication, supported custody/rollback,
  private delivery and practical devices remain the largest product blocks.
- Estimate **about 45% done / 55% remaining**, plausible done range **35–55%**.
  Receiver verification resolves another integration boundary within this coarse
  estimate; the main external delivery, custody and recovery gates remain open.
- Stay with this instance for wallet delivery: integration context is fresh.
  This is an efficiency recommendation, not a measured model comparison.
