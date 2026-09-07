# Current work

Updated: 2026-09-07

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer authorized merging/pushing the CI repair and continuing the
project. The repair is published; the next recovery contract has a material
choice described below, with no new normative rule adopted.

## Status

- `main` and `origin/main` are at `3711368`: CI repair `1ccb6e7` and wallet
  direction `3711368`, fast-forwarded from `fix/ci-document-links` and pushed.
- Current local branch: `docs/shielded-recovery-contract`, base `3711368`.
  Companion specification: `main` at `da80f85`; no changes in this slice.
- CI #46 (`34140840332`) is green across all five jobs. Runs #43–45 failed
  because three relative specification links required a sibling checkout.
  Pinned GitHub links fix it; the checker now rejects links outside each
  repository even when a sibling exists locally. Three regression cases
  cover the local blind spot. The proof job label now correctly says pool-v2.
- [Shielded recovery proposal](docs/POOL_RECOVERY_GAP.md) identifies C2b.3's
  inherited named-payee challenge as incompatible with the actual private
  spend shape. Existing real-proof split and merge fixtures establish the
  counterexamples. Recommended policy: recover finalized snapshot holdings;
  retire spend-based redirection and its window in the later shielded
  construction. No unwitnessed-tail rescue. This awaits maintainer decision.
- [Wallet direction](docs/WALLET_DIRECTION.md) records the unified wallet and
  fixed-creditor promise proposal. Acceptance, settlement, recovery and
  core/profile placement remain choices; no new instrument is implemented.
- The current runtime remains `moe/pool/v2`. Its section 7.4 excludes
  presentation, silence recovery, venue-nullifier adoption and cross-operator
  settlement. PoolStore still refuses silence clauses.
- `readPoolReceiptStatus` (feature `be12f7c`) reads final, contradicted,
  abandoned, lapsed or pending at one record index. It preserves inclusion
  and historical contradictions, and reads carrying repair/scope boundaries.
  These receipt verdicts authorize neither recovery nor discard by themselves.
- Companion `da80f85` clarifies carrying repair boundaries and abandonment.
  The existing README pin and private authority model reflect those rules.

## Evidence

- `npm run check` passed on Node 24.6 for the CI repair: 75 files / 1,461 tests,
  docs, typecheck, build, installed package, payment pilot and pool-store crash
  checks. Two link regressions failed before the checker fix and pass after.
- GitHub CI #46 passed Linux Node 20, Linux Node 24, Windows Node 24, and both
  Linux/Windows real-proof jobs at `3711368`. Recovery analysis reuses those
  verified fixtures and the existing admission/import tests; no runtime changes.
- Independent recovery design review confirmed the split/merge/dependency
  gap and recommended preserving the prior no-tail-rescue decision. It also
  required positive owned-note inclusion (not arbitrary nullifier absence)
  and backer-owned replacement notes to preserve redemption supply. This
  reviews the design problem only, not a completed recovery construction.
- Proposal and handoff pass `npm run check:docs` and `git diff --check`.
- Existing receipt classification underwent independent adversarial review;
  fixed findings and dispositions are in `be12f7c`'s commit message.
- Real circuits are unchanged; pinned evidence is docs/pool-v2-verification.json.
- Windows esbuild requires execution outside the restricted sandbox.

## Next

1. Resolve the concrete policy choice in `docs/POOL_RECOVERY_GAP.md`: retire
   inherited payee redirection for shielded recovery, or deliberately reopen
   unwitnessed transaction rescue. Do not silently choose one reading.
2. On approval, specify the later-version presentation/recovery objects
   together (pool-v2 section 7.4), including owned-note proofs, settlement,
   supply-preserving adoption, duplicate refusal and same-index gap closure.
   Keep companion spec/implementation branches named here as work begins.
3. Model the approved rules adversarially, then implement and independently
   review. Wallet use follows: payee freshness, reproof after lapse, delivery,
   synchronization and service transport.

## Open questions

- Removing C2b.3's challenge behavior changes its stated protection for
  unwitnessed recipients even though prior policy rejects tail rescue. The
  exact loss allocation and retirement of that window need maintainer approval.
- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority assumes a complete, stable venue snapshot; same-index mutation
  during synchronous custom adapter callbacks has no generation token.
- Profile large histories before compaction or immutable read caches.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
