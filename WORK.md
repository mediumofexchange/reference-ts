# Current work

Updated: 2026-09-12

## Goal

Obtain independently applied Ergo history for the three fixture comparisons.
The approved connected run is complete: header progress, early output stop
and cleanup demonstrated; no applied full-state progress observed.
The relevant logging defect is corrected and verified through the stock loader.

Delivery: main; baseline 7c27a06 (CI 34688754933 passed), followed by d40b823
(scope verification and sustain end-to-end slices) and this change.
Companion specification: money-from-first-principles/main at 7ea0ee8;
no normative/provenance change. Runtime remains v2.

## Status

- AGENTS.md now selects checks from affected behavior and groups related
  implementation, review, execution and evidence into sustained slices.
  Shared runtime/protocol, dependency, API, packaging, broad CI/build changes
  and uncertain impact still require full checks. Required CI gates remain.
- [Actual connected evidence](docs/ergo-node-sync-verification.json):
  282,315 ms, stopped at the 12 MiB console trigger; three peers observed.
  API headers reached 25,733; later log reached 33,263. Last API read was about
  42 seconds before stop. All sampled full heights were null; no applied-state
  or fixture-ancestry claim follows from these observations.
- Observed host traffic 133,770,818 bytes; peak node commit 625,156,096 bytes;
  max accounting gap 382 ms; stop-to-empty 105 ms; final accounting 6 ms later.
  Ordinary node, loopback listeners, wallet 403 and empty secrets observed.
- Job empty, mapping removed and disk detached. Independent post-run checks
  found recorded processes and drive reservation absent, opened the image
  exclusively and matched its GPT disk GUID. Keep the 21,474,836,992-byte image:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete, automatically resume, or allocate an extra retained image.
- Standard Ergo 6.0.5 / Temurin 21.0.12.1+1 and normal LevelDB work. Custom
  database candidates were removed earlier; no system Java/ACL changes.
- The first disk preparation failed on a Windows reserved GPT partition.
  [Evidence](docs/ergo-node-sync-first-preparation.json) records identity and
  cleanup; that unused image was deleted. Reviewed automatic placement fixed it.
- Node settings override XML root WARN with inherited INFO. The worker now
  explicitly selects scorex.logging.level = WARN, preserving UtxoState INFO.
  [Logging regression](docs/ergo-node-sync-logging-verification.json) exercised
  the actual pinned loader, reproduced INFO override and verified correction.
  No second connected run is claimed; original executed hashes are preserved.

## Evidence

- Seven affected guard groups passed: profile/evidence 25, reader 49,
  identity 58, database accounting 37, native identity 21, offline evidence 26,
  handoff 12 (228 cases). Syntax/native compilation and read-only preflight pass.
- Two additional actual-loader logging cases pass, with no node services,
  state, secrets or disk image created. Focused documentation/link checks apply.
- Independent source review and executed-evidence readback found no unresolved
  material issue. Logging-only correction received focused self-review.
- Reused unchanged full-suite baseline: 96 files / 1,795 tests and all checks
  at 7c27a06; its CI passed. Required final-revision CI remains in force.

## Next

1. Prepare a narrowly scoped, reviewed continuation of the retained owned
   image with the corrected logging, preserving progress rather than creating
   another fresh database. The current launcher deliberately has no reopen API.
   Define exact image identity, attachment/cleanup checks and finite resource
   envelope before another execution; existing approval covered the completed run.
2. Target near-current headers, then first demonstrated full-block application.
   Stock 6.0.5 schedules no full blocks before a recent header (about 200 minutes
   from its clock under current defaults). Header-only early progress is normal.
3. Once applied history reaches fixtures at 100,000 / 1,000,000 / 1,500,000,
   implement bounded parent-chain and body comparison. Bind upper IDs, exact
   links and heights; body presence and /blocks/at are insufficient. Current
   full-state catch-up is not itself required for historical fixture acceptance.

## Open questions

- This run did not exercise 30-minute endurance or the 8 GiB traffic trigger.
  Transaction application rate and storage to the fixtures remain unmeasured.
- Stuck supervisor/helper-crash ordering remain unproved. Socket/traffic
  sampling is not a firewall or independent hard deadline; some OS/JRE writes
  are outside the volume. Incoming proof/snapshot parsing remains possible.
- Full UTXO/genesis/no-bootstrap/retain-all is the selected experiment route,
  not a normative requirement that every eventual user retain all Ergo blocks.
  Independent conservation/history/order verification and unavailable evidence
  never establishing omission remain binding. No alternate trust route selected.
- Stay with this instance for continuation: control and evidence context is
  fresh. This is an efficiency recommendation, not measured model performance.
- Estimate **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback dominate. Header progress alone closes no product gate.