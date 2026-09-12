# Current work

Updated: 2026-09-12

## Goal

The local two-wallet v2 fixture completes issue, request, pay, verify, fulfill
once and burn, including restored payer change. Independent review and the
full repository check passed. Next connect this
wallet flow to the pinned real prover and a separate public-only verifier,
then exercise abrupt wallet-process interruption at persistence boundaries.

Delivery: reference-ts/main; baseline 8991651 (CI 34692938742 passed), cleanup
commit 2ec7cc6. Companion money-from-first-principles/main at 7ea0ee8 is unchanged.
Runtime remains the README-pinned v2 profile; no normative bytes change.

## Status

- [Wallet](docs/POOL_WALLET.md): fresh durable receiver requests, root-derived
  v2 randomness, full pending statement and private output retention, input
  reservations, authenticated receipts and verified once-only invoice records.
- Separate wallet processes issue 10, pay 7, fulfill the receiver invoice,
  restore/verify payer change 3, then burn both holdings to outstanding zero.
  Lost replies, exact/changed-proof retry and missing evidence remain explicit.
- Review found discarded payer change in the first harness. Both output
  openings now persist before submission; change stays out of receiver delivery.
  Independent fix/nearby-privacy readback has no unresolved material findings.
- Cleanup removed 58 fully merged local branches across the four repositories
  and 360,689,609 bytes of verified old bundles, duplicate archives and logs.
  Active dependencies, proof artifacts, current Java and sync evidence remain.

## Evidence

- [Wallet evidence](docs/pool-wallet-verification.json): `npm run check` passed,
  including 100 files / 1,815 tests, build, installed package, pilot, store crash,
  service, two-wallet acceptance and spent-set checks. Seven wallet tests passed.
- Independent review inspected actual runtime/tests/harness, and separately
  probed request quantity and derivation boundaries. The earlier callback
  identity-mutation suspicion was retracted: decoded identity fields freeze.
- Local acceptance uses ideal proofs, public fixture obligor keys and a known
  LocalVenue ledger with explicit bulk evidence. It proves no external finality,
  real-proof wallet privacy, rollback protection or external-goods atomicity.
  Plaintext DB/WAL/backups are custody material. Restarts between CLI commands
  are not abrupt-crash evidence. Node 20 root imports remain supported;
  SQLite wallet and service require Node 24.
- The initial sandbox attempt failed before tests at bundler directory access;
  normal-user verification passed without changing tests or gates.

### Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): bounded
  Ergo 6.0.5 / Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms.
  Sampled headers reached 97,923; all sampled full heights were null. No applied
  history or ancestry claim. The automatic result is unresolved; final worker
  checks were not reached. Independent owner cleanup established no surviving
  processes/mapping, exclusive image access and matching GPT identity.
- Retain the detached fixed 20 GiB image and actual run reports:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. ResumeSync's original configuration pin
  is spent; blindly repeating the one-time command will refuse admission.
- Native resume 56, disk 79, sync profile 25 and PowerShell resume 12 checks
  passed; read-only preflight passed. Background sync is permitted but no
  unattended run is active. Full sync is independent of wallet progress.

## Next

1. Use the existing pinned v2 prover with the same durable wallet requests,
   pending statements and change handling. Acceptance: real proof issue/pay/
   receive/burn, exact retry after a lost reply, and a separate verifier checking
   public supply without wallet secrets. Avoid a second wallet/prover framework.
2. Add bounded abrupt wallet-process crash tests before/after request, pending,
   receipt and fulfillment commits; verify restored exact bytes and one local
   fulfillment. Port remaining real-proof receiver/public-audit cases before
   retiring the frozen private-payment experiment or transparent pilot.
3. Keep caller-owned authority and explicit checkpoint evidence. Local fixture
   files do not establish private network delivery or authenticated external
   finality. No capsules or successor C4 derivation may be added to v2.
4. Independently applied Ergo history remains open. At fixture heights 100,000,
   1,000,000 and 1,500,000 compare bounded parent links and bodies against pinned
   upper IDs. Body presence alone proves no ancestry; more sync preparation
   must be justified separately from wallet progress.

## Open questions

- Full recovery, authenticated bulk evidence/external finality and publication,
  supported custody/rollback, private delivery and practical devices remain
  major product gates. Local history replay/proof work is not bounded by HTTP
  limits. No live deployment, release or real funds are involved.
- Estimate **45% done / 55% remaining**, plausible done range **35–55%**.
  The wallet fixture adds reusable integration evidence within this coarse
  range; it does not close the usable private payment or recovery gates.
- Stay with this instance for real-proof wallet integration: wallet persistence,
  service and review context are fresh. This is an efficiency recommendation,
  not a measured model comparison.
