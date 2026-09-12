# Current work

Updated: 2026-09-12

## Goal

Complete real-proof two-wallet acceptance and abrupt persistence checks, then
continue toward a usable receiver path. The real flow now issues 10, pays 7,
verifies receipt and retained change, burns both holdings and independently
checks public outstanding supply zero. No normative or circuit bytes changed.

Delivery: reference-ts/main; working slice follows c042cd4.
Companion money-from-first-principles/main at 7ea0ee8 is unchanged.
Runtime remains the README-pinned v2 profile. Hosted checks follow the push.

## Status

- [Wallet](docs/POOL_WALLET.md): durable fresh requests, full pending proof and
  both output openings, reservations, authenticated receipts and one verified
  local invoice record. The same CLI now uses pinned real v2 proofs.
- Separate public-input audit checks exact history and supply, including missing,
  corrupted, reordered and different valid history with unchanged outputs/totals.
- Eight actual wallet exits before/after request, pending, receipt and fulfillment
  COMMITs recover in eight fresh processes with rollback or exact retained state.
- Independent review fixed witness paths consuming unverified tails and cached
  preparation ignoring changed recipient intent. Both regressions pass. The
  adversarial audit copies serialized bytes before mutation to prevent aliasing.
  Final reviewed real acceptance passed; no unresolved material findings.
- Earlier cleanup removed 58 merged local branches and 360,689,609 bytes of
  verified obsolete bundles/archives/logs across the workspace. Frozen research
  remains for the specific receiver cases in the retirement map.

## Evidence

- [Wallet evidence](docs/pool-wallet-verification.json) records current real and
  ideal acceptance, independent crash execution/review, source hashes and limits.
- Reused unchanged runtime baseline c042cd4: full local check, 100 files / 1,815
  tests, build/package and acceptance stages; all seven CI jobs in 34694216066.
  Current source, tests, dependencies, circuits and package exports are unchanged.
  Current focused checks cover new tooling; CI runs full checks and real wallets.
- Real mode checks manifest source/toolchain/bytecode/key pins. Normal-user
  execution is required where sandbox directory access blocks the toolchain.
- Local fixture venue and public obligor keys prove no external finality.
  Plaintext DB/WAL/backups are custody material; public audit process separation
  is not an OS sandbox. Crash tests use ideal proofs and abrupt process exit,
  not power loss, rollback or external-goods atomicity. SQLite requires Node 24;
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

1. Complete the receiver boundary: distinguish historical payment inclusion
   from current spendability against caller-owned verified history. Port the
   frozen receiver's already-spent-note case and map exact fulfillment replay
   to the saved record without double delivery. Review semantics before code;
   do not silently change the existing historical received-record contract.
2. Retire the duplicate private-payment host only after an explicit case map
   accounts for those differences. Preserve useful vectors and evidence.
3. Extend the same wallet toward supported custody/private authenticated delivery
   and imported-segment note paths. Current CLI is one pinned segment/no imports;
   bulk local files do not establish private delivery or external finality.
   No capsules or successor C4 derivation may be added to v2.
4. Independently applied Ergo history remains open. At fixture heights 100,000,
   1,000,000 and 1,500,000 compare bounded parent links and bodies against pinned
   upper IDs. Body presence alone proves no ancestry; additional sync preparation
   must be justified separately from wallet progress.

## Open questions

- Full recovery, authenticated evidence/publication, supported custody/rollback,
  private delivery and practical devices remain the largest product blocks.
  Local history replay/proof work is not bounded by HTTP limits.
- Estimate **about 45% done / 55% remaining**, plausible done range **35–55%**.
  Real proofs and crash acceptance close integration uncertainty within this
  coarse estimate; external delivery, custody and recovery gates remain open.
- Stay with this instance for the receiver boundary: wallet integration and its
  review context are fresh. This is an efficiency recommendation, not a measured
  model comparison.
