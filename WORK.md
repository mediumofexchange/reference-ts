# Current work

Updated: 2026-09-12

## Goal

Compose the capped-disk sync launcher using standard Ergo v6.0.5 and maintained
standard Java. Their offline checks and the four-peer candidate readback pass.
No connected sync or large allocation occurred. Next acceptance is the reviewed
disk/process/traffic composition with a bounded offline control.

Delivery: `main`; baseline `81e4810` (CI 34685216023 passed).
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change; original fixture provenance pins remain unchanged.

## Status

- [Current evidence](docs/ergo-maintained-java-verification.json) links actual
  storage/startup/settings/sync-profile reports, source inventory and reviews.
- Unchanged stable bundle: `scratch/ergo-stable/bundle/`; JAR SHA-256
  `2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588`.
- Official Temurin 21.0.12.1+1 JRE: `scratch/ergo-java/bundle/`, with pinned
  archive/manifest beside it. All 315 files verified. No system installation
  or bundle replacement; explicit `-MaintainedJava` selects it with `-Stable`.
- `node-sync-network.conf` is a candidate overlay, not a launcher. Existing
  settings script's `-SyncProfile` inspects it without actors/APIs/peers.
- Disposable run directories and downloaded review sources removed after
  capture. Both official packages retained. Custom candidates remain deleted;
  no demonstrated need for a custom database/native build.

## Evidence

- Native LevelDB write/update/delete, fresh-process rollback and another reopen
  passed on Java 21.0.12.1. Four processes; 22 files / 2,675,435 bytes.
- Startup: Ergo 6.0.5, expected genesis UTXO state, zero peers, wallet HTTP403,
  empty secrets. 73,624 ms / 341,065,728 peak commit bytes / 966,056 combined
  file-output bytes / 285 loopback socket observations; process job empty.
- Final ordinary settings baseline accepted and pruning/checkpoint controls
  rejected. Compiler plus three cases passed; final files 11,811 bytes.
- Candidate four-peer settings accepted; pruning, checkpoint and JVM fifth-peer
  overrides rejected. Five processes passed under existing bounds; max peak
  commit 206,827,520 bytes; final files 13,239 bytes; data/secrets empty.
- Independent actual patch/report review found no material issue. Peer review
  checked 86 exact source blobs. Incoming proof/snapshot parsers remain; sparse
  headers are not full-state evidence. Full blocks still start at genesis and
  apply transactions/root checks. No artificial proof-quorum fix selected.
- Full project checks passed: 96 files / 1,795 tests in 233.65 s, plus
  docs/typecheck, build/package, pilot, store-crash and spent-set checks.
  Final docs/link and diff whitespace checks pass. Inspect CI for the delivery
  revision; local checks and independent review are complete.

## Next

1. Combine existing owned-volume/drive-letter, process-job and traffic controls
   for the standard node. The supervisor currently permits 120 seconds and the
   disk helper only 64 MiB: no 30-minute/20 GiB launch exists yet. Target:
   30 min, 20 GiB disk, 100 GiB host reserve, 8 GiB traffic trigger / 10 GiB final
   maximum. Prepare/review concrete code and bounded offline composition before
   separate full-allocation/connected-run authorization.
2. Use the measured stock baseline plus candidate overlay; read back exact
   invocation settings. No spending keys; fresh validation data; bounded local
   reads. Preserve the disk ceiling rather than substituting file sampling.
3. After bounded sync, compare all three fixtures as ancestors of an applied
   full-state tip. Header height or /info alone is insufficient. Historical
   block retention does not ensure AD proofs; these fixtures use spending proofs.

## Open questions

- Public-peer parsing can stall or exhaust resources; finite supervision is not
  hostile-code isolation. Current Java selection is not a security certificate.
- Reduce the long historical preflight once the active launch is concrete;
  preserve old evidence via immutable Git links instead of more parallel plans.
- Stay with this instance for disk/process/traffic integration: package and
  host-control context is fresh. This is an efficiency recommendation.
- Estimate **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback dominate remaining effort. No product gate closed here.
