# Current work

Updated: 2026-09-07

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer approved finalized-snapshot recovery without spend-based
redirection on 2026-09-07. That decision is adopted; do not ask for it again.

## Status

- Implementation branch: `feat/shielded-recovery-boundary`, based on
  `docs/shielded-recovery-contract` at `f8244a1` (parent `3711368`).
- Companion specification: `spec/shielded-recovery-finality`, committed as
  `dcce2dc`, base `da80f85`. Specification committed before model work.
- Construction C2b.3a–c now requires finalized positive holdings, ownership
  and immutable-nullifier evidence; unwitnessed spends cannot create recovery
  holdings or redirect redemption. The shielded challenge window is retired.
- C2b.3b/4 preserves existing consent and supply rules: valid recovery
  settlements consume notes and commit to backer-owned replacement notes;
  redemption leaves outstanding unchanged. Return adopts both effects.
  Bare nullifier publication cannot settle or destroy claims.
- Extensions retains the transparent profile's existing limited challenge.
  Construction's appendix records the retired rule and its cost. Pool-v2
  section 7.4 explicitly remains unsupported: no frames, circuits, keys,
  admission behavior or durable store support changed.
- Eight cases in `model/pool-recovery.test.ts` exercise the approved finality
  boundary using the existing authority model: splits, merged inputs, chains,
  conflicting proofs, false/zero inclusion, missing history and replacement.
  These are ideal-cryptography inclusion observations, not recovery proofs or
  an executable settlement/adoption mechanism.
- Decision is indexed in `decisions/2026-09.md`; README pins `dcce2dc` and
  states the runtime exclusion. `docs/POOL_RECOVERY_GAP.md` is marked resolved;
  `docs/PROTOCOL_RULES.md` distinguishes the model and transparent oracle.
- Published implementation `main`/`origin/main` remains `3711368`. CI repair
  `1ccb6e7` and wallet direction `3711368` were merged/pushed with authorization;
  CI #46 (`34140840332`) passed all five jobs.
- [Wallet direction](docs/WALLET_DIRECTION.md) records native assets and
  non-circulating promises in one wallet. That instrument's acceptance,
  settlement, key recovery and core/profile placement remain proposals.

## Evidence

- Independent review approved the actual specification diff and the eight
  model cases without blocking findings. It explicitly did not certify a
  recovery construction. The forged-opening case checks ideal-token identity,
  not an implemented ownership proof. Review obligations for later proofs,
  settlement, adoption and return ordering remain.
- Focused `npx vitest run model/pool-recovery.test.ts`: 8/8 passed.
- Full `npm run check` passed on Node 24.6: 76 files / 1,469 tests, docs,
  typecheck, build, installed package, payment pilot and pool-store crash
  checks. Specification links and `git diff --check` also passed.
- Baseline verification: 75 files / 1,461 tests on local Node 24.6; CI #46
  also passed Linux Node 20/24, Windows Node 24 and both real-proof jobs.
- Real circuits are unchanged; pinned evidence is docs/pool-v2-verification.json.
- Windows esbuild requires execution outside the restricted sandbox.

## Next

1. Specify the later-version presentation/recovery objects together (pool-v2
   section 7.4): owned-note proofs, demand/accept/release, settlement, pending
   locks, non-service evidence, supply-preserving adoption, duplicate refusal
   and same-index gap closure. The finalized-holdings policy is already approved.
2. Extend the adversarial model to those objects before implementing them,
   then independently review the implementation. Wallet use follows: payee
   freshness, reproof after lapse, delivery, synchronization and transport.

## Open questions

- The policy is fixed, but the later construction's exact proof/record formats,
  multi-backing atomicity and return adoption remain to be designed together.
  No new v2 recovery path may be enabled to shortcut that work.
- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority assumes a complete, stable venue snapshot; same-index mutation
  during synchronous custom adapter callbacks has no generation token.
- Profile large histories before compaction or immutable read caches.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
