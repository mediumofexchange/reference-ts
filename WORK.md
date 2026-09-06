# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized pushing and merging reviewed, verified work.

## Status

- Merged into `main`: `e68d9db`, from `feat/pool-checkpoint-finality` (base
  `fceb9ff`). Whole-scope checkpoint validation is implemented, independently
  reviewed and fully verified. Next is opening construction for new service.
- `readPoolCheckpoint` validates an exact held checkpoint and all required
  canonical imports. Every backing's predecessor is selected before proof
  replay; later checkpoints of the same segment preserve its finalized prefix.
- The iterative dependency plan checks local witnessed ranks, verifies each
  checkpoint once, and imports only prefixes computed by this validator.
  Complete replayed directories and historical authority finalize the scope
  together. A later term ending does not undo historical finality.
- Missing directory, scope or history evidence stops validation. Invalid live
  history never licenses fallback. Authenticated absence and whole-scope lapse
  need no usable history. Required bytes are owned before proof verification;
  changed venue views and unexpected verifier exceptions remain visible.
- This is a read-only historical finality API, not current spendability or a
  signing service. Canonical opening construction for new service remains next.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, circuit or proof-key changes; existing authority model rules
  already express this slice (C2.10.3–5, pool-v2 §10).

## Evidence

- Full `npm run check` passed: 67 files / 1,224 tests, docs, typecheck, build,
  installed tarball consumer (including checkpoint export), crash/restart pilot
  and witness retry checks. The updated handoff also passed `check:docs`.
- Initial focused suite passed: 4 files / 101 tests; the full check includes
  four additional boundary cases and verifier exception variants.
- Independent adversarial source review covered canonical selection, transitive
  imports, iterative traversal/ranks, continuity, snapshot binding, copying and
  venue stability. Its verifier-exception diagnostic finding was fixed and
  independently rechecked; no blockers remain. Reviewer ran no tests.
- 27 runtime cases cover genesis, missing first signed sequence, exact held
  identity, selective scope, stale openings, rewritten/truncated prefixes,
  proof variants, withheld/invalid ancestors, split/rejoin and reappointment,
  lapse, takeover index, duplicate/tampered preimages, malformed lengths,
  repeated statements, aliasing, and venue/backend failures.
- Prior unchanged circuit evidence: 153 circuit/proof checks and 24 real ZK
  proofs in `docs/pool-v2-verification.json`. Circuits were not rerun.

## Next

1. Construct canonical openings for new segments before any child checkpoint
   exists, and integrate admission/signing with record-derived authority and
   the schedule. Keep historical checkpoint finality distinct from currency.
2. Integrate receipt classification and durable admission/receipt/commitment
   journaling, then port the experiment's crash/retry cases. Presentation,
   note delivery and wallet sync follow their specified objects.

## Open questions

- No protocol choice or independent review remains unresolved for this slice.
- Existing Ergo latest/exact reads may expose partially fetched refreshes;
  bounded predecessor reads refuse unsettled views. Snapshot isolation and
  consistent changed-view errors in standalone PoolAuthorityView remain owed.
- Checkpoint planning reuses the descent reader per backing, including its
  evidence copies and authority reads. Profile large shared histories before
  adding a reusable immutable read context; do not weaken per-backing checks.
- Full C2 re-derivation against the directory, authenticated setup/build
  provenance, target measurements, note delivery and transitive history
  availability remain release requirements.
