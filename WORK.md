# Current work

Updated: 2026-09-12

## Goal

Complete local private wallet credentials and authenticated invoice pairing.
Acceptance: independently authenticate an invitation digest, persist its exact
invoice/endpoint/certificate binding, restart and rotate with stale credentials
refused, then complete the existing real-proof payment and offline recovery flow.
Work: reference-ts/main; baseline 1d5366b, hosted CI 34702129809 passed.
Design and independent review precede implementation; full check, hostile
transport/rotation/backup cases and real wallet acceptance precede delivery.
Companion money-from-first-principles/main at 7ea0ee8 is unchanged; runtime pin,
v2 circuits and derivation are unchanged. This is a local application custody
profile under v2 sections 3 and 9, not seed-only or protocol failure recovery.

## Status

- [Wallet custody](docs/POOL_WALLET.md#encrypted-offline-handoff-and-recovery):
  bounded AES-256-GCM whole-state exports commit with durable source freeze.
  Exact repeated export survives a lost reply. No plaintext staging file.
- Restore requires a fresh destination, key and independently retained digest.
  All seven state tables and import provenance commit atomically. Concurrent
  destination writes are retained and make import refuse. Reservations remain.
- Writable sessions pin full authority. Explicit SQLite read-only sessions
  preserve verification of imported notes under another same-domain segment.
  Source/reader guards run before callbacks and inside write transactions.
- Independent design and actual-source review/readback are complete. Findings
  addressed source authority, post-await freeze guards, destination write races,
  lost-import provenance and owning ciphertext before authentication. No material
  finding remains within the documented trusted current-version profile.
- Real acceptance passed: recover payer after accepted/lost reply and receiver
  after inbox storage, then exact retry, verify and burn 7+3 to outstanding zero.
  Exports were 64,330 and 32,174 bytes. Full npm check passed.

## Evidence

- Full npm check passed: 102 files / 1,851 tests, build, installed-package imports
  and all acceptance stages. No runtime or circuit pin changed after verification.
- Focused backup suite: 15 tests passed. Covers complete state, both reservations,
  counter freshness, key/context/digest/framing, aliasing, independent handles,
  in-flight submission/fulfillment, read-only sessions, unsupported/oversize state
  refusal, legacy context and raced destination retention. Typecheck passed.
- Abrupt-commit harness: 16 exits and 16 fresh recoveries across request, pending,
  receipt, fulfillment, capability, inbox, export and import. All passed.
- Ideal and pinned real two-wallet HTTPS/recovery/public-audit acceptance passed.
  Final source pins and consolidated results belong in
  [wallet evidence](docs/pool-wallet-verification.json).
- Protected active storage, a separately retained random key/current digest,
  one active restored copy and current binaries are preconditions. No automatic
  rollback detection, continuous backup or encrypted-device qualification claim.

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

1. Active product slice: replace public fixture TLS credentials and manual trusted
   pairing with private per-wallet credentials and authenticated pairing, including
   restart, rotation and rejection of stale/wrong bindings. Keep it local until
   deployment is separately authorized; do not let pairing authorize fulfillment.
2. Continuous/device-loss recovery needs its own concrete custody boundary.
   Offline export cannot safely resume stale state after later wallet activity.
   Do not add C4 derivation or successor seed capsules to pinned v2.
3. CLI proof paths still need one segment/no imports. Extend selection from the
   verified forest only when a concrete multi-segment wallet flow requires it.
   Applied Ergo history/publication remains unestablished; more sync needs separate
   justification and exact ancestor/body checks against pinned upper IDs.

## Open questions

- Runtime failure recovery, authenticated evidence/publication, qualified device
  custody/continuous recovery and credential lifecycle remain the largest blocks.
- About **45% done / 55% remaining**, plausible done range **35–55%**. This
  controlled offline recovery improves the wallet within existing uncertainty;
  it does not close continuous custody or the operator/witness recovery gates.
- Recommend a fresh instance for credential/pairing design after delivery. The
  next boundary benefits from fresh context; this is an efficiency judgment,
  not measured comparative model performance.
