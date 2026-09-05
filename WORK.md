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
- The model/specification work is already on both local `main` branches:
  implementation `6c223b3`, specification `4172c5b`.
- Active implementation branch `feat/pool-v1-circuits`, circuit commit
  `b90eb4a` on `main` `6c223b3`:
  pool-v1 issue/spend/burn sources, depth-32 membership, 2-in/2-out padding,
  per-backing conservation, reproducible source/bytecode/VK manifest, real
  proof tests, package source verification and Linux/Windows CI jobs.
- Companion branch `spec/pool-v1-circuit-pins` at `1d38815`, based on
  `main` `4172c5b`: pool-v1 §12 records the source revision and all source,
  bytecode and VK hashes. README pins it. Both branches remain local,
  unpushed and unmerged; merge order: specification first.
- The transparent path stays frozen. The experiment remains until admission,
  replay and crash cases move into the pool implementation too.

## Evidence

- The model's 12 checks passed again inside `npm run check` (Node 24.6.0).
  Eight rule-following configurations (honest; slow blocks; drops; crash and
  restart; darkness; withholding; everything at lag 2; lag 0) over 60 seeds
  each: no violation of P1 continuity, P2 double spend, P3 contradicted
  receipt, P4 one in flight, P5 every receipt final (clean setting). Two
  departures each found their counterexample within 300 seeds and are kept as
  regression vectors: `leadFloor: 1` gives P5 (the same-block erasure);
  `restartFrom: "witnessed"` gives P3 (the dropped tail).
- `npm run check:pool`: 97 checks, 10 real ZK proofs, 14,656 bytes each;
  fresh compilation reproduced every source, bytecode and VK identity.
  Full evidence and parameter-cache hashes: `docs/pool-v1-verification.json`.
- Independent circuit review found no circuit defects. Test review found
  two sets of non-isolating hostile witnesses; fixed, rerun and independently
  confirmed. No circuit-review findings remain.
- `npm run check`: 51 files / 1,012 tests passed (95.38 s), typecheck/build,
  docs, installed tarball including source hashes, and pilot all passed.
  Vitest needed execution outside the sandbox after a parent-directory
  access denial; no check was weakened. New CI jobs have not run remotely.
- `npm run check:privacy`: 8 journal tests, 38 experiment checks and 9 real
  proofs passed; shared compiler extraction preserved all experiment pins.

## Next

1. The rest of the pool's claim layer in `src/pool/`: canonical fields and
   statement/configuration frames, note tree, SHA-256 spent-set SMT with
   compressed proofs, statement frames, admission against one committed view,
   history hash, snapshot digest, receipt fields, with pool-v1 as the test
   oracle and the experiment's adversarial cases ported.
2. Extend the model with the pool's admission (nullifier set, anchors), then
   §C3 over notes when v2 defines its objects.

## Open questions

- Review still owed: the C2 re-derivation against the directory (C2.4.5, C2.7)
  has been exercised by the model but not read independently.
- v1 leaves the non-service grade inert and snapshot redemption without a
  venue leg (pool-v1 §5.4); v2 must define the demand, lock, adoption record
  and swap together. Decide whether v1 backings should exist at all before v2,
  given the non-atomic crossing.
- Spent-set proof cost on a phone; flat versus tree directory in the profile.
- Proof backend and setup provenance remain provisional. The recorded SRS
  hashes describe cached files, not ceremony provenance or consumed prefixes.
