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

- Steps 1 and 2 are merged and pushed: specification `main` `1d38815`
  (`pool-v1.md` with §12's circuit pins), implementation `main` `8b4015c`
  (circuits, `check:pool`, the sequencing model).
- Step 3, the claim layer, is on branch `feat/pool-claim-layer` (from
  `8b4015c`): `src/pool/` holds `field.ts`, `poseidon2.ts` (pure TypeScript,
  pinned to Barretenberg's vectors), `notes.ts`, `note-tree.ts`,
  `spent-set.ts`, `statement.ts` (configuration, pool identity, statement
  bytes/hash/record, public-input parsing, history hash, snapshot digest),
  `pool.ts` (`Pool`: register, admit, trail, directory, replay) and
  `barretenberg.ts` (the bb.js verifier and hash, optional peer dependency).
  `backing.ts` gained E's construction clause `0x05`; the transparent ledger
  refuses a pool backing. Decision: "The claim layer: E declares the
  construction as clause 0x05…" (`DECISIONS.md`).
- The receipt and commitment envelopes over the pool's fields are deferred to
  step 4, as pool-v1 §12 says; `AcceptedStatement` carries the fields §7 lists.
- No specification change was needed; the spec pin stays `1d38815`.

## Evidence

- `npm run check:pool` (Node 24.6.0, Windows): 106 checks, 17 real ZK proofs
  of 14,656 bytes; identities matched the manifest; the claim-layer run
  (`scripts/pool/admission.mjs`) admitted a real issuance, padded spend and
  burn built with the host functions, answered a re-proven resubmission with
  the prior record, refused a respend, an unaccepted root, another key's
  issuance and corrupted, cross-kind and truncated proofs, and replayed the
  trail with a second verifier. Host Poseidon2 agreed with the backend for
  1–8 inputs. Recorded in `docs/pool-v1-verification.json`.
- `npm run check`: 57 files / 1,058 tests (46 new in `test/pool-*.test.ts`),
  docs and links, typecheck, build, tarball consumer, pilot all passed.
- Independent adversarial review of the slice was commissioned in two lanes
  (primitives; frames/admission). Findings and their fixes: see the commit
  after this handoff, or "Open questions" if any remain owed.

## Next

1. Apply any review findings still open, then merge `feat/pool-claim-layer`
   (fast-forward) and push, per the maintainer's standing authorization for
   this session's work.
2. Step 4 begins with the specification: the sequencing layer's receipt and
   commitment envelopes over pool-v1 §7's fields (receipt: `i`,
   `statementHash`, `historyHash`, evidence hashes, the sequence of the
   commitment last signed; commitment: the directory of snapshot digests),
   written in `pool-v1.md` §12's "still required" slot, then `Sequencer` over
   `Pool` with the model's §C2/§C2b cases ported from the frozen suite.
3. The durable pool journal (the experiment's crash/retry cases) and the
   receiver's acceptance check, retiring the experiment's host.

## Open questions

- Performance: the host Poseidon2 costs about 1 ms per hash, so a note-tree
  append is ~35 ms; fine for tests and a small pool, not for a wallet
  syncing millions of leaves. Options: Montgomery arithmetic in
  `poseidon2.ts`, or the backend's hash behind the same interface.
- The spent-set proof map's bit numbering follows the Notation (bit 0 most
  significant); pool-v1 §8 could say so beside the map's definition.
- Review still owed from before: the C2 re-derivation against the directory
  (C2.4.5, C2.7) has been exercised by the model but not read independently.
- v1 leaves the non-service grade inert and snapshot redemption without a
  venue leg (pool-v1 §5.4); v2 must define the demand, lock, adoption record
  and swap together.
- Proof backend and setup provenance remain provisional.
