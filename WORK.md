# Current work

Updated: 2026-09-12

## Goal

Select the configured wallet's smallest device custody/recovery boundary and
deliver a read-only storage preflight, current-record procedures and failure
drills. Acceptance met: adverse/unavailable/malformed observations cannot pass,
the observed workspace refuses qualification, and offline handoff remains
distinct from active-device loss. No machine controls or real secrets changed.
Delivery target: reference-ts/main; slice from feat/local-wallet-device-boundary
based on 1f06f1b. Implementation, review and local verification are complete.
Read delivery parity/CI for the commit containing this handoff on resumption.
Companion money-from-first-principles/main 7ea0ee8 unchanged; no normative,
runtime, circuit, derivation, dependency or custody-schema changes.

## Status

- [Device custody contract](docs/POOL_WALLET_DEVICE.md) selects one Windows
  holder account/device, a protected flat directory on its BitLocker OS volume,
  PIN startup and explicit OS spill/backup controls. Provisioning is not performed.
- Current paper recovery record binds one exact destination. Mark the export
  historical before activating a matching unfrozen restore; lost replies stay
  with that same destination. Old exports cannot resume after later activity.
- Read-only preflight inspects path/volume, conservative directory/file ACLs,
  encryption status/protector types, Secure Boot and TEMP/TMP. It does not query
  recovery keys. Its report always has qualified=false and lists manual evidence.
- Independent design and actual-source adversarial review closed. Fixed provider
  array/truthiness coercion and non-exact GUID anchors; nearby cases regressed.
- Configured v2 remains one initial constant-payout backing, no imports/recovery
  clauses; exact saved retries need no artifacts, new verification uses real pins.
  Local venue and independent digest authentication remain modeled.

## Evidence

- Final focused suite: 320 assertions passed, independently rerun; synthetic
  providers/in-memory ACLs plus real isolated invalid-path CLI. Added Windows CI
  step without altering existing gates. Documentation and diff checks passed.
- [Source pins and observed report](docs/pool-wallet-device-verification.json):
  read-only run outside sandbox, process exit 2/automatic fail. OS-volume/NTFS,
  path and TEMP/TMP observations passed; directory ACL refused; BitLocker/PIN and
  Secure Boot unavailable. No host security settings or permissions were changed.
- Reused unchanged runtime/full/real proof baseline main 1f06f1b, hosted CI
  34712726859 success, verified this session. That acceptance funds 4+6, pays 7,
  freezes/restores before checkpoint, reconciles exact retries, rotates receiver
  credentials and spends change 3; separate public audit outstanding 10.
- No target physical theft, cross-account, power-loss, backup-isolation or
  continuous recovery evidence. A preflight pass would not close those gates.

## Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): Ergo 6.0.5 /
  Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms. Sampled headers
  reached 97,923; full heights null. No applied history/ancestry claim; automatic
  result unresolved. Cleanup found no workers/mapping; exclusive image access and
  matching GPT identity were established.
- Retain detached fixed 20 GiB image:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. Original ResumeSync pin is spent; blind
  repetition refuses. Native resume 56, disk 79, sync profile 25, PowerShell
  resume 12 checks and read-only preflight passed. No sync run is active.

## Next

1. Verify delivered main parity and hosted CI for the commit with this handoff.
2. Device qualification needs separately authorized provisioning/test hardware
   for the contract's cross-account, PIN startup, power-loss and handoff drills.
   Do not alter this workstation's controls under development-only authorization.
3. Continue independent recovery work: inspect the existing successor delivery
   experiment and contract, then define an end-to-end wallet/public-evidence
   restoration experiment with omitted/current/stale request and delivery data.
   Keep it outside pinned v2; commit any normative gap before dependent code.
   Imported-note selection, consolidation and external witness publication remain
   open; no applied Ergo-history claim is established.

## Open questions

- About **45% done / 55% remaining**, plausible done range **35-55%**. This slice
  resolves deployment requirements and refusal behavior; it closes no device or
  recovery gate, so the coarse effort estimate is unchanged.
- Largest blocks: runtime recovery and authenticated evidence/publication,
  qualified device custody/continuous recovery and supported user operation.
- Switch to a fresh instance for successor restoration integration: the next
  work crosses protocol/version boundaries beyond this OS probe, and fresh
  context should be more efficient. This is not a measured model comparison.
