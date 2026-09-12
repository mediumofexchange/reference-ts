# Current work

Updated: 2026-09-12

## Goal

Successor restoration now connects real capsule recovery to exact local v3
record evidence in a fresh process. It authenticates signed directories,
snapshot preimages, headers and ordered local records before scanning; a
replica cannot replace the independently selected fixture checkpoint or supply
a separate spent list. Results are unspendable candidates with unresolved
coverage, never a full-replay or current-range claim.

Implementation main includes 41d82af, fast-forwarded from
feat/successor-restoration-evidence. Companion money-from-first-principles/main
remains 60f380c; normative
content stays 7ea0ee8. No normative, runtime, circuit, key, dependency or
configuration change. Independent review and final acceptance passed.

## Status

- [Restoration experiment](docs/POOL_DEPLOYMENT_PROBES.md#restoration-from-exact-local-evidence):
  issue 10, payment 7/change 3, later payment 5/receiver change 2. Fresh processes
  recover the appropriate change without request records, payer secrets or
  original operator callbacks. Burn's nullifier/change positions also exercised.
- Current selection rejects stale and same-sequence alternative packages.
  Missing/reordered/substituted records and capsules return no partial results.
  Retained independent bytes survive source loss; wrong seed/no matches never
  imply complete zero balance. Current/stale request journals cannot override
  evidence; the fixture IPC rejects journal fields. Imports/recovery refuse.
## Evidence

- `npm run check:pool:restoration`: 14 focused groups passed, independently rerun.
  Actual-source adversarial review closed without material issues; burn and
  unauthenticated terms cases added and read back. [Report](docs/pool-restoration-evidence-verification.json)
  records LF-normalized source hashes and exact experiment limits.
- Tests deliberately retain synthetic proofs/history/terms/authority, accept
  authenticated invalid supply totals and unverified terms as local evidence,
  and keep all candidates unspendable. No deployed availability, authenticated
  venue range, full replay, certified path or durable invoice-restoration claim.
- Reuse unchanged full/runtime/real-proof baseline main 3f07307: all seven
  hosted CI jobs passed, run 34715502862, verified this session. New experiment
  runs in the existing Linux/Windows delivery CI command. Final
  `npm run check:pool:delivery`, docs and diff checks passed. Main has no required
  branch checks/rules. Verify latest push parity and hosted CI on resumption.

## Existing local product and custody boundary

- Configured v2 supports one initial constant-payout backing, real-proof local
  payments and independent public audit. Exact saved retries need no artifacts;
  new verification uses real pins. Venue and digest authentication are modeled.
- Encrypted offline handoff freezes the source and binds one exact destination.
  Mark the paper export historical before activating the matching unfrozen
  restore; lost replies stay with that destination. Old exports cannot resume
  after activity. Continuous recovery after active-device loss is not delivered.
- [Device custody contract](docs/POOL_WALLET_DEVICE.md) selects Windows account,
  protected flat directory, BitLocker OS volume/PIN startup and OS spill/backup
  controls. Read-only preflight always has qualified=false and manual evidence.
  [Observed report](docs/pool-wallet-device-verification.json): automatic fail;
  directory ACL refused, BitLocker/PIN and Secure Boot unavailable. No host
  controls or secrets changed. Physical theft, cross-account, power-loss,
  backup-isolation and continuous-recovery qualification require separate authority.

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
2. Define the complete initial-segment public-package replay boundary: terms,
   configuration/key authority, proof/state replay and authenticated current
   record ranges. Reuse the v3 codecs and restoration cases; commit reviewed
   normative gaps before dependent runtime code. Adoption remains unset.
3. Device qualification needs separately authorized provisioning/test hardware;
   do not alter this workstation's controls. Imported-note selection,
   consolidation, external publication and applied Ergo-history evidence remain open.

## Open questions

- Reassessed 2026-09-12: roughly **50% done / 50% remaining**, plausible done
  range **40-60%**. This experiment connects reusable boundaries but does not
  materially move that coarse estimate or close runtime recovery gates.
- Largest blocks: runtime recovery and authenticated evidence/publication,
  qualified device custody/continuous recovery and supported user operation.
- Stay with this instance for the next public-package boundary: its current
  context includes the exact authentication/replay gap and reusable sources.
  This is an efficiency recommendation, not measured model performance.
