# Current work

Updated: 2026-09-07

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized merging and pushing completed work.

## Status

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

- Full `npm run check` passed on Node 24.6: 74 files / 1,458 tests (22
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

1. Specify later-version silence/presentation objects (pool-v2 §7.4) before
   implementing recovery over these verdicts, presentation, delivery, wallet
   synchronization and service transport.
2. Wallet-side use of `readPoolReceiptStatus`: a payee's freshness rule and
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
