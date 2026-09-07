# Current work

Updated: 2026-09-07

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
Current slice: repair the reported CI failures and discuss a unified wallet
with non-circulating promises. New protocol rules remain proposals; pushing
this slice awaits explicit maintainer authorization.

## Status

- Local branch `fix/ci-document-links`, base `be12f7c`; companion specification
  remains `main` at `da80f85`, with no specification edits in this slice.
- CI runs #43, #44 and #45 fail on the same three relative links to the absent
  companion checkout in `docs/POOL_RECEIPT_REPAIR_GAP.md`. Replaced with pinned
  GitHub links. The link checker now rejects paths outside each repository
  root, even if the sibling checkout exists; three regression tests cover it.
  Corrected the proof job's stale pool-v1 display label to pool-v2.
- [Wallet direction](docs/WALLET_DIRECTION.md) records the maintainer's unified
  wallet requirements and a discussion draft for fixed-creditor promises.
  Acceptance, settlement, recovery and core/profile placement remain choices.
- Implementation merged into `main` from `feat/pool-receipt-status` (one
  commit, base `6dddb74`).
- Companion specification merged into `main` from
  `spec/pool-receipt-classification`, `da80f85`, base `bdd3599`; the README
  pins that revision.
- `readPoolReceiptStatus` (`src/pool/receipt-status.ts`) reads C2.10.9b's
  present verdict: final, contradicted, abandoned, lapsed (moved past, repair,
  scope boundary) or pending, with independent inclusion, contradiction and
  abandonment facts. It walks the operator's held commitments from `after`
  through bounded predecessor reads, stops at the earliest term end or the
  first checkpoint of another segment carrying a scope backing, passes over
  checkpoints carrying none of the scope (directory evidence only), relates
  and replays each checkpoint in ascending order ending at the first
  inclusion, and replays the transition only where neither inclusion nor a
  proven contradiction has decided. A failure carries the contradictions
  already proven.
- Two spec clarifications this session, flagged for the maintainer's
  confirmation (decision entry of 2026-09-07, second): the C2.10.9a boundary
  must carry a scope backing and its hole is any absent sequence between the
  segment's last held checkpoint and the boundary; C2.10.9b names abandonment
  and the verdict order. `readPoolReceiptRepair` follows the carriage reading
  (`no-carriage` reason; passed-over checkpoints occupy their sequences and
  are not holes).
- The private authority model has `classify` beside `classifyRepair`, shared
  canonical/compare helpers, and the `lapseWithoutCarriage` counterexample.
- PoolStore behavior, signed frames and circuits are unchanged; the store
  tests assert the verdict after repair, elective change and scope boundary.

## Evidence

- CI #45 (`34139357616`): all three `check` jobs stop in the docs check;
  both Linux and Windows real-proof jobs pass. #43 and #44 have the same
  missing-link errors. Local regressions reproduced the blind spot (two
  failures before the checker fix). Full `npm run check` passed on Node 24.6:
  75 files / 1,461 tests, docs, typecheck, build, package, pilot and store crash
  checks. Docs rechecked after adding the wallet draft. No push or merge yet.
- Prior feature verification on Node 24.6: 74 files / 1,458 tests (22
  `pool-receipt-status` cases, 15 model verdict cases, 3 store assertions),
  docs, typecheck, build, installed tarball consumer through the root and the
  `pool/receipt-status` subpath, pilot and pool-store crash harness.
- Independent adversarial review found no false verdict on a receipt whose
  `after` is consistent with the record; its two medium findings (an
  all-or-nothing batch erasing proven facts; the below-`after` read narrower
  than C2.10.9b) and three low ones were fixed; a second round found the
  relation walk still all-or-nothing and the transition replayed after a
  proven contradiction, both fixed. Dispositions are in the feature commit
  message.
- Real circuits are unchanged; pinned evidence is docs/pool-v2-verification.json.
- Windows esbuild requires execution outside the restricted sandbox.

## Next

1. Obtain explicit authorization to merge and push `fix/ci-document-links`,
   then verify the fresh GitHub CI run. Discuss the wallet draft before a normative
   proposal for non-circulating promises.
2. Specify later-version silence/presentation objects (pool-v2 §7.4) before
   implementing recovery over these verdicts, presentation, delivery, wallet
   synchronization and service transport.
3. Wallet-side use of `readPoolReceiptStatus`: a payee's freshness rule and
   resubmission after `lapsed`, re-proved under the carrying segment.

## Open questions

- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority assumes a complete, stable venue snapshot; same-index mutation
  during synchronous custom adapter callbacks has no generation token.
- Profile large histories before compaction or immutable read caches. The
  classifier replays each segment checkpoint in its range once per call.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
