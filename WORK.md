# Current work

Updated: 2026-09-06

## Goal

A finished, working protocol whose claim layer is Construction's shielded pool
(§C1.2), built in this order: specification → executable adversarial model of
§C2/§C2b/§C3 over notes → the pool's claim layer → sequencing, recovery and
presentation over notes → wallet → witness venue write side. No release
deadline; each step is done when its rule, its model check and its adversarial
tests agree.

## Status

- Steps 1–3 are merged and pushed. Implementation main at 7ac47c4 holds
  the sequencing model, pinned pool-v1 circuits, and src/pool/ admission,
  served trail and replay, including both claim-layer adversarial reviews.
  E declares the construction as clause 0x05; the transparent path refuses
  pool backings. Relevant decision: "The claim layer…" (DECISIONS.md).
- Specification main at 81516ba is pinned in the README. The companion
  spec/pool-v1-receipt branch was already merged: pool-v1 §7 fixes the
  receipt bytes and the commitment's directory contents. No specification
  change was needed for the receipt milestone.
- Step 4's receipt milestone is merged and pushed as main 53c9719
  (feat/pool-receipts): pool/receipt.ts signs §7's exact frame under
  moe/pool/v1/receipt, with after the last signed commitment's sequence
  directly (0 for none). Verification pins the caller's configuration and
  operator. Statement identity, exact admitted evidence, and inclusion in
  replayed history have separate predicates; none asserts witnessed finality.
- signPoolReceipt is a low-level envelope over a trusted Pool.admit
  result. Its caller must retain the original receipt on retries and make
  admission/receipts durable before exposing them. The pool sequencer,
  commitment schedule, journal and finality checks remain to be built.
- PoolSequencer investigation found a material specification conflict,
  recorded on docs/pool-sequencing-boundary in
  docs/POOL_SEQUENCING_BOUNDARY.md. Immutable original-operator binding
  conflicts with replacement; hidden mixed-backing spends and shared history
  lack authority/continuation rules for independent backing replacements.
  The model's public backing label abstracts away this problem. No normative
  change or sequencing implementation has been selected.

## Evidence

- A Node 24.6.0 host probe reproduced the conflict: a valid witnessed
  replacement names Q, while changing the pool operator refuses the backing,
  retaining the configuration refuses Q's receipts, and spend inputs name no
  backing. No proof verifier was invoked; exact limits are in the note.
  Independent specification review confirmed the conflict and options.
- Diagnostic documentation and model comments: npm run check:docs passed
  (19 linked files); git diff --check passed. Runtime behavior is unchanged.
- The receipt suite covers literal byte framing, every signed field, u64
  bounds, wrong domain/configuration/operator, malformed inputs, strict
  signatures (including a small-order forgery), Buffer ownership, all three
  statement kinds, exact evidence, re-proven retries and replayed prefixes.
- Receipt milestone's npm run check passed: 58 files / 1,079 tests, docs/links, typecheck,
  build, tarball consumer (including receipt imports) and local pilot.
- npm run check:pool passed; docs/pool-v1-verification.json: 111 checks,
  17 real ZK proofs of 14,656 bytes, including host/backend Poseidon2 agreement,
  admission/refusal and replay. The harness additionally signs and
  verifies receipts and replays a different valid proof of the same statement.
- Independent adversarial source review found no concrete security or
  correctness defects in the envelope, context/exports and receipt tests.
  Its separate test attempt was blocked by the sandbox; the successful
  full checks above provide execution evidence. Sequencing is outside this
  review's scope; the real-proof harness changes received self-review.

## Next

1. Maintainer decision on docs/POOL_SEQUENCING_BOUNDARY.md. Recommendation:
   preserve private spends and independent backing replacement; repair the
   configuration/authority/history boundary in the specification and model
   before implementing PoolSequencer. The other directions change the trust
   or liveness model and must not be silently chosen.
2. After that repair: PoolSequencer over Pool and LocalVenue, retained
   receipts, directory commitments, one in flight, handover and restart.
   Port C2 cases using directory absence proofs, never the retired opening
   claims or whole-state exhibits. Commitment sequences start at 1.
3. The durable pool journal (the experiment's crash/retry cases) and the
   receiver's acceptance check, retiring the experiment's host.

## Open questions

- Review still owed from before: the C2 re-derivation against the directory
  (C2.4.5, C2.7) has been exercised by the model but not read independently.
- Performance: host Poseidon2 costs about 1 ms per hash; appendAll makes
  wallet sync about two hashes per leaf and an operator's append 32 hashes.
  Montgomery arithmetic or the backend hash can address deployment needs.
- Nullifiers can be ground to share prefixes; the compact spent-set trie's
  resulting single-child chains are bounded by the grinding work.
- v1 leaves the non-service grade inert and snapshot redemption without a
  venue leg (pool-v1 §5.4); v2 must define the demand, lock, adoption record
  and swap together.
- Proof backend and setup provenance remain provisional.
