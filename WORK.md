# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. The maintainer approved continuing the
checked design review's recommendations: bring device/venue feasibility and
recovery evidence forward before freezing v3. Production remains specification
→ adversarial model → implementation. Preserve immutable verifier authority,
independent replacement and one shielded production path.

## Status

- Implementation: `feat/pool-deployment-probes`, based on `53bcea0`.
- Companion specification: `main` at `3676757`; unchanged in this slice.
- Prior recovery work: `cada3bf`, merged/pushed with authorization on September
  8. The specification contract is `pool-recovery.md` at `3676757`.
- Runtime remains v2. PoolStore refuses silence clauses; no demand, settlement,
  recovery publication or wallet implementation has been added to `src/`.
- The design review and its independent check are in `decisions/archive/`:
  [review](decisions/archive/2026-09-08-whole-project-design-review.md),
  [check](decisions/archive/2026-09-08-whole-project-design-review-check.md).
  Continuing investigation is approved; unresolved protocol alternatives are
  not thereby selected and no v3 bytes have been fixed.

## This slice

- `model/pool-fault-boundary.test.ts`: nine executable F2 cases over the existing
  models. One otherwise valid signed checkpoint with a forged ideal proof
  blocks both scoped backings' snapshot/count/descent. Recurring invalid
  publications reset the clock; stopping opens the gap but leaves the snapshot
  blocked. Snapshot-only skipping does not repair the clock/count/descent.
  Corrupt or withheld replica evidence cannot undo a finalized payment.
- `scripts/pool/browser/`: reproducible synthetic v2 spend benchmark. Preparation
  compiles and checks all pinned artifacts, uses the recorded local parameter
  cache, and prepares three spend vectors. Browser checks spend bytecode/key,
  public-input identity, proof bounds and all nine proofs in ZK mode.
- `docs/pool-browser-verification.json`: first desktop Chromium baseline,
  nine verified proofs in about 61.6 seconds overall. Same-backing proving
  4.28–6.29 seconds; mixed-backing 6.79–9.30 seconds; proofs 14,656 bytes.
  No mobile, whole-browser peak-memory, wallet or venue result is implied.
- Commands: `npm run bench:pool:prepare`, then `npm run bench:pool:browser`.
  Server binds loopback only. A connected Android phone can use USB forwarding;
  no `adb` or Ergo transaction SDK is currently installed. Target phone/browser
  was requested from the maintainer and remains unspecified.

## Evidence

- Model suite: 5 files / 139 tests passed on Node 24.6.0; typecheck passed.
- Browser preparation reproduced the pinned issue/spend/burn bytecode and keys.
  All nine browser spend proofs verified; raw timings and limitations recorded.
- Full `npm run check` passed on Node 24.6.0: 77 files / 1,507 tests, docs,
  typecheck, build, installed package, payment pilot and pool-store crash checks.
  Vitest required the usual sandbox escalation for esbuild's parent lookup.
- Focused tooling review found preparation could leave a stale manifest and
  requested explicit target/checked-circuit reporting; these are addressed.
- Browser rejected a mismatched verifier target before proving. HTTP checks
  confirmed declared assets 200, private WORK.md 403 and unknown assets 404.
- No push, merge or publication is authorized by this continuation.

## Next

1. Model candidate A in the [fault proposal](docs/POOL_FAULT_RECOVERY_PROPOSAL.md),
   including non-carrying clock resets and delayed fault evidence; compare its
   verification dependencies with prospective fault publication before selection.
2. Resolve the rule across descent/count/clock/force/adoption before normative
   changes. A bad download is not fault proof; missing preimages still block.
3. Run the benchmark on the named target phone, measure complete Ergo publication
   using a pinned SDK/node, and prototype authenticated note delivery/restoration.
4. Settle measured statement bounds and complete evidence retention, then freeze
   v3 layouts and implement recovery with the existing model as oracle.

## Open questions

- `model/pool-recovery.ts` implements the approved C3/C2b contract over ideal
  cryptography, including demand/lock/settlement, non-service, gap, adoption and
  return. The previous independent adversarial review fixed twelve findings;
  its disposition is in the September 7 contract decision. The new F2 evidence
  is the reason to revisit invalid-checkpoint handling specifically.
- Prior full check: 76 files / 1,498 tests, build/package/pilot/store crash checks
  passed. It does not establish deployment feasibility or complete assurance.
- Data availability must include proofs, issuance signatures, terms, ancestry
  and recoverable openings. Public inputs alone do not establish valid state.
- SQLite ownership assumes one journal per operator key/venue; copied journals,
  coordinated rollback and custody/backup procedures remain open.
- Scope authority assumes complete stable venue snapshots; same-index mutation
  during custom synchronous adapter callbacks has no generation token.
- Setup/build provenance, full C2 re-derivation, history scaling, retention,
  note delivery, wallet restore and venue write-side acceptance remain gates.
