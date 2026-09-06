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

- Steps 1 and 2 are merged and pushed: specification `main` `1d38815`
  (`pool-v1.md` with §12's circuit pins), implementation `main` `8b4015c`
  (circuits, `check:pool`, the sequencing model).
- Step 3, the claim layer, is built (branch `feat/pool-claim-layer` from
  `8b4015c`, merged to `main` by fast-forward once the checks below passed):
  `src/pool/` holds `field.ts`, `poseidon2.ts` (pure TypeScript,
  pinned to Barretenberg's vectors), `notes.ts`, `note-tree.ts`,
  `spent-set.ts`, `statement.ts` (configuration, pool identity, statement
  bytes/hash/record, public-input parsing, history hash, snapshot digest),
  `pool.ts` (`Pool`: register, admit, trail, directory, replay) and
  `barretenberg.ts` (the bb.js verifier and hash, optional peer dependency).
  `backing.ts` gained E's construction clause `0x05`; the transparent ledger
  refuses a pool backing. Decision: "The claim layer: E declares the
  construction as clause 0x05…" (`DECISIONS.md`).
- Two independent adversarial reviews (primitives; frames and admission)
  were applied in the same branch: served backings and the configuration are
  copies, the note tree is not reachable, the verifier's derived identities
  are checked against the configuration, `admit` demands exactly `true`, a
  zero quantity is malformed on the host, the spent set is a compact trie
  (a few objects per key instead of 256 nodes), `appendAll` syncs a leaf
  list at about two hashes per leaf, sparse arrays are refused, the empty
  subtrees are handed out as copies, `ByteReader` refuses non-bytes, and the
  pilot profile and `replayLog` refuse a pool backing.
- Step 4's first action is done in the specification: `pool-v1.md` §7 fixes
  `receiptBytes` (`moe/pool/v1/receipt`) and what the commitment's directory
  carries; §1 names `Poseidon2::hash`; §8's map wording is exact. Spec
  revision `81516ba` (branch `spec/pool-v1-receipt`, merged to `main` by
  fast-forward with this work); the README pins it. The reference does not
  yet sign receipts; `AcceptedStatement` carries §7's fields.

## Evidence

- `npm run check:pool` (Node 24.6.0, Windows): 106 checks, 17 real ZK proofs
  of 14,656 bytes; identities matched the manifest; the claim-layer run
  (`scripts/pool/admission.mjs`) admitted a real issuance, padded spend and
  burn built with the host functions, answered a re-proven resubmission with
  the prior record, refused a respend, an unaccepted root, another key's
  issuance and corrupted, cross-kind and truncated proofs, and replayed the
  trail with a second verifier. Host Poseidon2 agreed with the backend for
  1–8 inputs. Recorded in `docs/pool-v1-verification.json`.
- `npm run check`: 57 files / 1,068 tests (56 in `test/pool-*.test.ts`),
  docs and links, typecheck, build, tarball consumer, pilot all passed.
- The unit tests pin one commitment, nullifier and anchor the pinned
  circuits proved under (`claimLayer` in `docs/pool-v1-verification.json`),
  beside Barretenberg's permutation vector and ten recorded hash outputs.
- Review findings not taken: none. Notes recorded as open questions below.

## Next

1. Step 4, the sequencing layer over notes: `src/pool/receipt.ts` signing
   `receiptBytes` per pool-v1 §7 (context `moe/pool/v1/receipt`, `after` =
   the sequence of the commitment last signed, 0 for none), then a
   `PoolSequencer` over `Pool` and `LocalVenue` — register, submit with a
   receipt, commit over `directory()` under `moe/commitment/v2`, one in
   flight (C2.4.3), the lead floor and handover schedule (C2.5.3, C2.6.1),
   restart from the latest signed commitment (C2.8) — porting the model's
   §C2/§C2b cases and the frozen suite's, rule by rule. Update the README's
   spec pin to the merged `spec/pool-v1-receipt` revision when the receipt
   lands.
2. The durable pool journal (the experiment's crash/retry cases) and the
   receiver's acceptance check, retiring the experiment's host.

## Open questions

- Performance: the host Poseidon2 costs about 1 ms per hash; `appendAll`
  makes a wallet's sync about two hashes per leaf (a million leaves in
  minutes), and an operator's append 32 hashes. Montgomery arithmetic in
  `poseidon2.ts`, or the backend's hash behind the same interface, is the
  remedy when a deployment needs more.
- Nullifiers can be ground to share prefixes; the spent-set trie then holds
  a chain of single-child branches per shared prefix, bounded by the work
  spent grinding. Acceptable for a reference; a deployment prices it.
- Review still owed from before: the C2 re-derivation against the directory
  (C2.4.5, C2.7) has been exercised by the model but not read independently.
- v1 leaves the non-service grade inert and snapshot redemption without a
  venue leg (pool-v1 §5.4); v2 must define the demand, lock, adoption record
  and swap together.
- Proof backend and setup provenance remain provisional.
