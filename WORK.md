# Current work

Updated: 2026-09-09

## Goal

Build the shielded-pool protocol. The v3 recovery choices are decided in the
contracts; `pool-v3.md` waits on F3 (delivery/restoration) and F4 (fee
shape), which move `configHash`. Next slice: **F3**.

## Status

- Implementation: `main`. Runtime remains pinned v2; `PoolStore` refuses
  silence clauses. No circuit, key, configuration or CI change.
- Specification: `main` (was `spec/pool-v3-choices`). Ten open choices of the
  v3 map are decided in `pool-recovery.md`, `pool-fault.md`,
  `pool-authority.md`, `construction.md` and one forward sentence of
  `pool-v2.md` §11 — see the [decision](DECISIONS.md) of 2026-09-09. No v2
  byte, circuit, key, bound or accumulator changed.
- The largest three: only a settlement or a withdrawal discharges a demand
  (the old deadline discharge would have excluded an honest checkpoint that
  witnessed a settlement admitted before the deadline); the release publishes
  no non-membership proof, since every reader of force replays the snapshot
  and holds the spent set; and the notice is the demand proof's public
  inputs, so the demand's identity is its `statementHash`.
- [v3 recovery map](docs/POOL_V3_RECOVERY_MAP.md) records each decision
  against its open item, and adds **A22**: with no proof published, whether
  the 256-high sparse accumulator is still the right shape.
- The spent set's framing cost is gone (`perf:` commit): 2.08 → 1.42 ms per
  insert, which is the bare-hash floor for its frame. What remains is the
  shape's — about 430 node hashes per insert — and is A22's to weigh.

## Evidence

- `npm run typecheck`, `npm test` (89 files, 1674 tests) and
  `npm run check:docs` pass on the merged tree; cross-repository links pass in
  both repositories. `npm run check:pool` was not rerun: no circuit, key or
  configuration changed.
- Two independent adversarial reviews of the specification change (opus lane,
  read-only). The first returned three blockers and nine material findings on
  the first commit, two blockers being defects in its own new sentences; the
  second read the fixes back and returned two blockers and eight material
  findings, none reopening a decision. All are resolved in
  `spec 7a510f1`; the dispositions are in the decision entry.
- One independent review of the spent-set change confirmed the bytes are
  unchanged, by inspection and by recompiling the pre-commit file and
  comparing 20,000 leaves, 20,000 nodes, all 257 empty subtrees and several
  sets against `node:crypto`. Its findings are fixed in the commit.
- Measured, this machine: `spentNode` 5.54 → 3.15 µs; a bare SHA-256 over the
  86-byte node frame 2.85 µs (`node:crypto` 2.42 µs); about 430 node hashes
  per insert, flat in `N`.

## Next

1. **F3, delivery and restoration.** The first question decides the rest: does
   restoration reach the note or the relation at all, or does it stay outside
   the circuit? If it reaches the note, it moves `configHash` and everything
   downstream. Design review F3 requires restoration from a seed plus public
   evidence, tested with the payer and the original operator gone, and a
   reviewed authenticated-encryption/address design with discovery, key
   separation, retry rules and output association. Acceptance: a decision
   entry with independent review, and the specification committed before code.
2. **F4, the fee shape.** Measure a direct three-output candidate before
   selecting bounds; preserve per-backing conservation.
3. Then `pool-v3.md`, then the runtime over `src/pool/` with the model as
   oracle (P6).
4. **Align the model** with the decided contracts. It does not check the
   demand's nullifier distinctness, models the withdrawal's authorization as
   public-field equality, reads acceptances without their demand, counts a
   republished request at its own index, and uses one evidence context without
   the position. Each is a small change with a test.
5. Probes needing a node or device: P2 chunked publication on a testnet node,
   P4 range completeness and inclusion latency, P5 phone proving. Retain the
   offline Ergo probe, `scratch/pool-v3` and the build/browser caches.

## Open questions

- Product estimate: about 42% done / 58% remaining; plausible done range
  32–52%. The contracts are now decided ahead of the layouts, which removes
  rework, but nothing a holder can use was built. Largest work: F3 and F4, the
  v3 specification and runtime/circuits, wallet and transport, witness
  publication, authenticated range reads (A8), deployment/security assurance.
  See [estimate scope](docs/PRODUCTION_REQUIREMENTS.md#progress-estimate).
- A22: whether the spent set should stay a 256-high sparse tree. An indexed
  Merkle tree over a sorted list would cost about 32 hashes per insert against
  430, and still proves absence. It is now a v3 layout choice, not a
  Construction change, provided the root stays a function of the set alone and
  recomputable per statement.
- A8: no authenticated source for C2.10.13's complete range on Ergo; the
  indexed node is a trust assumption until P4 selects a candidate.
- Missing committed evidence remains unresolved; intrinsic exclusion supplies
  no availability guarantee. Cached verdicts do not replace evidence.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
