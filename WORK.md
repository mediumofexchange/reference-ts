# Current work

Updated: 2026-09-12

## Goal

The local PoolStore v2 service/client slice is complete: separate processes
demonstrate accepted submissions, durable exact retries, lost commit replies,
old-process fencing and restored local publication. Next is a two-wallet v2
payment path with durable pending requests and receiver fulfillment.

Delivery branch: reference-ts/main; these changes follow d8829dd, whose CI
34690932138 passed. Check CI for the final service commit after delivery.
Companion: money-from-first-principles/main at 7ea0ee8, unchanged.
Runtime remains the README-pinned v2 profile; no normative change.

## Status

- [Pool service](docs/POOL_SERVICE.md): bounded loopback HTTP commands and
  typed client, separate wallet/admin credentials, canonical frames, explicit
  missing evidence, request-bound receipts and caller-owned verification.
- The fenced Store summary returns copied status without constructing proof
  histories on each poll. Independent adversarial review found this cost in
  the original status implementation; the fix and nearby cases were read back.
  No unresolved material findings remain for the service or acceptance harness.
## Evidence

- [Service evidence](docs/pool-service-verification.json): final `npm run check`
  passed, including 99 files / 1,808 tests, build, installed-package consumer,
  pilot, pool-store crash checks, separate-process service and spent-set checks.
  Focused cases cover real HTTP stalls, redirects, byte limits, wrong-context
  receipts, status aliasing and status without history copying.
- Acceptance uses public fixture keys, an ideal proof verifier and a known
  local venue ledger. It proves neither external finality nor wallet privacy,
  deployment readiness or abrupt service-process crash recovery. Existing
  store-crash evidence remains separate. Node 20 root imports stay supported;
  the SQLite store and HTTP server require Node 24.

### Ergo measurement closed; node stopped

- [Retained continuation](docs/ergo-node-sync-resume-verification.json) restarted
  the standard Ergo 6.0.5 / Temurin 21.0.12.1+1 database with corrected logging.
  It was manually stopped after 415,386 ms; sampled headers reached 97,923,
  peers reached three, traffic was 418,472,522 bytes and output 1,905 bytes.
  All sampled full heights were null. No applied history or ancestry claim.
- The last API sample was about 55 seconds before stop. The automatic result
  remains unresolved because the stop was external; final worker checks were
  not reached. Owner cleanup plus independent checks established an empty job,
  absent processes/mapping, exclusive image access and matching GPT identity.
- Retain the detached fixed 20 GiB image and actual run reports for inspection:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. ResumeSync's original configuration
  pin is spent; blindly repeating that one-time command will refuse admission.
- Resume checks passed: native 56 (including a bounded real image read), disk
  79, sync profile 25 and PowerShell resume 12; read-only preflight passed.
  Independent source and partial-result review found no material contradiction.
- Background sync is permitted, but no unattended run has been started. The
  one-time bounded launcher is not a full-sync service. Further setup must be
  justified separately from wallet progress; completing sync is not a blocker
  for the next slice. Standard packages work; custom candidates were removed.

## Next

1. Build a local two-wallet v2 CLI: issue → request → pay → verify → fulfill
   once → burn, including restart and exact retry. Persist the receiver's
   fresh secret/request before sharing only its owner. Persist the complete
   pending statement before submission and derive v2 randomness as specified.
2. Deliver opening and statement/segment identity privately. Verify receipts
   against caller-owned authority and distinguish acceptance from finality.
   Use explicit bulk fixture evidence with the existing checkpoint reader for
   local finality; missing evidence must remain unavailable.
3. Acceptance: lost replies, restored pending requests, changed-proof retries,
   invoice replay rejection and receiver secrets absent from service traffic.
   Review the sensitive wallet/state changes independently before delivery.
   The delivery restore worker uses a synthetic v3 view; it cannot establish
   v2 wallet restoration or justify adding capsules to v2. Keep frozen pilot
   and receiver evidence until equivalent crash/fulfillment cases pass.
4. Independently applied Ergo history remains open. When available at fixture
   heights 100,000 / 1,000,000 / 1,500,000, compare bounded parent links and
   bodies against pinned upper IDs. Body presence alone proves no ancestry.

## Open questions

- Full recovery, authenticated bulk evidence/external finality and publication,
  custody/rollback and practical wallet operation remain major product gates.
  Initial journal replay retains its current cost; HTTP limits are not whole-
  process or proof-worker quotas. No live deployment or real funds are involved.
- Estimate **45% done / 55% remaining**, plausible done range **35–55%**.
  Local service delivery is useful progress within this coarse range; it does
  not establish a usable private payment or close recovery/deployment gates.
- Stay with this instance for wallet integration: the service and durable
  retry context is fresh. This is an efficiency recommendation, not a measured
  comparison between models.
