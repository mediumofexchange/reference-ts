# Current work

Updated: 2026-09-09

## Goal

Build the shielded-pool protocol. Next: **F3 delivery/restoration**, then F4
fee shape, before freezing `pool-v3.md`. The review follow-up fixes the last
slice's confirmed findings and aligns request replay/refresh in the model.

## Status

- Implementation: `main` (slice branch `fix/recovery-review-followup`):
  `a31e7cf` fixes spent-set inputs; `f28ac2b` aligns the model.
  Runtime remains pinned v2; `PoolStore` refuses silence clauses. No circuit,
  key, configuration or CI change.
- Specification: `main`, `a166161`, pushed and clean (companion branch
  `spec/recovery-lock-clarification`). C3.7 now explicitly bars settlement
  from consuming another demand's standing lock. The existing model already
  enforced it. Expired demands remain standing; replay/adoption indices are
  unchanged. See the follow-up in the [decision](DECISIONS.md).
- Reviewing the prior spent-set optimization reproduced a regression: an
  actual 31-byte array with an own `length = 32` retained an earlier call's
  last byte in a shared hash frame. Validation now reads intrinsic brand and
  length. Key conversion also reads indexed bytes, preventing an overridden
  iterator from selecting a different key than the bytes being hashed.
- C2b.5.1–2 model follow-up: request identity binds an explicit unsigned
  64-bit refresh; counting retains the first witnessed index per identity
  and backing, so copies cannot renew an aged-out request. Holder reproof
  with a new refresh works under an unchanged anchor; tags still count once.
  Seed derivation/counter persistence and the v3 circuit remain unimplemented.
- Corrected v3 map omissions for zero padding anchors, refresh bounds and
  derivation, and the settle lock guard; corrected the decision's stale A22
  claim. All v2 frames, accumulator shape and identities remain unchanged.

## Evidence

- New frame regression tests failed on the prior code; all original 1,674
  tests passed in that run. Focused corrected frame/lock tests pass (50).
- Independent frame review: 1,000 leaf/node comparisons against node:crypto,
  all 257 empty hashes, forged lengths/prototypes, proxies, detached/resizable
  views, Buffers and cross-realm arrays; indexed-key fix read back with a
  24-key tree under hostile getters/iterators. No material findings remain.
- Independent review of spec `6995082..7a510f1` found the lock ambiguity;
  exact corrective diff read back and approved. Regression covers another
  lock live at/before its deadline, expiry after it, and no other lock.
- Request model independent review/readback passed after correcting an invalid
  first copy shadowing later valid proof evidence, strict judging-index reads,
  and malformed public-field handling. Eight request regressions pass.
  Full `npm run check` passes: 90 files / 1,686 tests, build, installed-package
  consumer, pilot and pool-store crash checks. Cross-repository links pass.
  GitHub CI for this delivery must be checked separately from local results.
  `check:pool`
  is not required locally: no production circuit, key, proof relation or
  pool configuration changed.

## Next

1. **F3 delivery/restoration:** decide whether seed restoration changes the
   note/relation or stays outside the circuit. Acceptance: seed plus public
   evidence restores notes with payer and original operator gone; reviewed
   encryption/address design, discovery, key separation, retry and output
   association; decision and specification committed before dependent code.
2. **F4 fee shape:** measure a direct three-output candidate before selecting
   bounds, preserving per-backing conservation. Then v3 layouts and runtime
   over `src/pool/`, with the models as oracle (P6).
3. Remaining model alignment: demand nullifier/tag distinctness and zero
   padding anchor; real ideal authorization for withdrawal instead of public
   field equality; acceptance read with its demand; separate evidence-chain
   contexts and position. These are not runtime recovery evidence.
4. Before freezing v3, reconcile Construction invariant 24/§C3's signed,
   attributable-presentment wording with C3.2–3's unsigned holding proof and
   fresh presenter key. This pre-existing contradiction is explicit debt,
   not a new signature requirement. See the decision's follow-up review.
5. P2 testnet chunk publication, P4 authenticated range completeness and
   inclusion latency, P5 phone proving. Retain the offline Ergo probe,
   `scratch/pool-v3` and build/browser caches.

## Open questions

- About **42% done / 58% remaining**, plausible done range **32–52%**.
  This slice fixes correctness and the model, not a new usable holder path.
  Largest blocks: F3/F4, v3 circuits/runtime, wallet/transport, witness
  publication and complete authenticated range reads, deployment assurance.
  See [estimate scope](docs/PRODUCTION_REQUIREMENTS.md#progress-estimate).
- A22: measure a cheaper spent-set shape before v3. It must retain a root
  determined by the set alone and recomputable per statement; a conventional
  insertion-ordered indexed tree does not automatically meet that condition.
- A8: Ergo range completeness has no selected authenticated source. Missing
  committed evidence is unresolved; cached verdicts are no substitute.
- Copied journals, rollback, custody/backup, same-index custom venues,
  setup/build provenance and external write acceptance remain release gates.
