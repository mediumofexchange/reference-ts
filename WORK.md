# Current work

Updated: 2026-09-05

## Goal

A finished, working protocol whose claim layer is Construction's shielded pool
(§C1.2), built in this order: specification → executable adversarial model of
§C2/§C2b/§C3 over notes → the pool's claim layer → sequencing, recovery and
presentation over notes → wallet → witness venue write side. No release
deadline; each step is done when its rule, its model check and its adversarial
tests agree.

## Status

- Step 1 (specification) delivered: `pool-v1.md` pins `moe/pool/v1` bit for
  bit, one adversarial review applied. Step 2 (model) delivered for §C2/§C2b:
  `model/sequencing.ts`, twelve checks, two rules earned (C2.6.1, C2.8).
  Decision "pool-v1 pins the shielded pool, and the sequencing model earns two
  rules" (`DECISIONS.md`).
- Implementation branch `feat/sequencing-model` on `main` (`4efe773`).
  Companion specification branch `spec/pool-v1` at `4172c5b`, on `main`
  (`8d5055e`). Both local, unmerged. Merge order: spec first.
- The transparent path stays frozen; the experiment stays until the v1
  circuits replace it.

## Evidence

- `npx vitest run model/sequencing.test.ts`: 12 passed (27 s, Node 24.6.0).
  Eight rule-following configurations (honest; slow blocks; drops; crash and
  restart; darkness; withholding; everything at lag 2; lag 0) over 60 seeds
  each: no violation of P1 continuity, P2 double spend, P3 contradicted
  receipt, P4 one in flight, P5 every receipt final (clean setting). Two
  departures each found their counterexample within 300 seeds and are kept as
  regression vectors: `leadFloor: 1` gives P5 (the same-block erasure);
  `restartFrom: "witnessed"` gives P3 (the dropped tail).
- `npx tsc --noEmit` clean with `model/` included.
- Spec links OK (`scripts/check-links.mjs`).
- Full `npm run check` last run on `main` `4efe773` (green on CI, three jobs).

## Next

1. Promote the circuits: write `src/pool/circuits/{notes,issue,spend,burn}.nr`
   to pool-v1's layouts (2-in/2-out with padding, per-backing conservation,
   depth 32), compile with the pinned toolchain, record source hashes,
   `bytecode(k)` and `vk(k)` in pool-v1 §12. Adversarial review
   (circuit-sensitive).
2. The pool's claim layer in `src/pool/`: note tree, SHA-256 spent-set SMT with
   compressed proofs, statement frames, admission against one committed view,
   history hash, snapshot digest, receipt fields, with pool-v1 as the test
   oracle and the experiment's adversarial cases ported.
3. Extend the model with the pool's admission (nullifier set, anchors), then
   §C3 over notes when v2 defines its objects.

## Open questions

- Review still owed: the C2 re-derivation against the directory (C2.4.5, C2.7)
  has been exercised by the model but not read independently.
- v1 leaves the non-service grade inert and snapshot redemption without a
  venue leg (pool-v1 §5.4); v2 must define the demand, lock, adoption record
  and swap together. Decide whether v1 backings should exist at all before v2,
  given the non-atomic crossing.
- Spent-set proof cost on a phone; flat versus tree directory in the profile.
- Proof backend and setup provenance remain provisional.
