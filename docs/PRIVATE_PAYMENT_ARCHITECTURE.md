# One implementation, the shielded pool

Decision, feasibility evidence and consolidation map, revised 2026-09-05.

## Direction

Construction's core claim layer is the shielded pool (§C1.2): one pool per
operator, notes with receiver-generated secrets, anchor-independent
nullifiers, spend and burn statements with conservation proofs, a lit boundary
for issuance and burn, supply by replay from genesis, and a spent-set
accumulator with non-membership proofs. **E** declares the construction and
its version, and an upgrade is a successor backing (§C1.3). The transparent
ledger, the accumulator and Chaumian signatures are Extensions profiles.

This repository builds that core, in this order:

1. **Specification.** Pin the pool's concrete statement layouts, hash
   functions, spent-set accumulator, multi-input shape and proof-system
   identity in Construction, from the experiment's evidence. Done in part
   (§C1.2–C1.4, numbered §C2/§C2b); the concrete layouts are the next spec
   slice.
2. **Adversarial model.** An executable model of §C2, §C2b and §C3 over the
   pool representation — two operators, two backings, a holder, delayed and
   dropped publications, replacement, restart, incomplete views — checking
   safety and conditional progress separately and keeping counterexamples as
   regression vectors. This replaces panel rounds with checks that re-run.
3. **The pool's claim layer** in `src/`: circuits promoted from the experiment
   to the normative layouts, the note tree, the spent-set accumulator,
   admission against one committed view.
4. **Sequencing, recovery and presentation over notes**, rule by rule,
   porting each adversarial case from the frozen transparent suite as its rule
   lands, and deleting the transparent code when the pool path passes them.
5. **The wallet**: a balance, a send button, a policy list (Construction §C5);
   note delivery, backups, restore, note selection and consolidation.
6. **The witness venue's write side** (Ergo), once the commitment format is
   final.

There is no release deadline. Each step is finished when its specification
rule, its model check and its adversarial tests agree.

## Feasibility candidate

The executable candidate (`experiments/private-payment/`, contract in
`RESEARCH.md`) uses Noir `1.0.0-beta.26`, Barretenberg `5.2.0` and a pinned
Poseidon2 helper: three small entry circuits sharing one note relation — issue,
spend and burn. A note commits to pool, full 256-bit backing identity, a
bounded quantity, receiver-generated ownership material and randomness. A
spend proves membership, ownership, same-asset conservation and valid outputs
while exposing a nullifier independent of the chosen anchor. Full identities
use two range-constrained 128-bit limbs; quantities use 64-bit bounds and
widened sums. Issuance requires K's signature over a framed public statement
bound to the pool, backing and pinned circuit identities.

The prover, verification-key derivation and verifier use
`verifierTarget: 'noir-recursive'`; the backend's legacy `keccak: true`
option disables zero knowledge and is not acceptable. The experiment forces one
WASM worker. The backend downloads structured reference parameters; the
experiment records their hashes as observations, not as setup verification.
Production needs a reviewed account of the backend's setup and soundness
assumptions, authenticated distribution, and build provenance.

Alternatives considered: signed transparent logs (fail the privacy
requirement), plain blind-signature cash (no public conservation), other
circuit backends (Halo2, snarkjs — still alternatives if device measurements or
review disqualify this one). The Zcash note/nullifier model and the Penumbra
shielded pool are precedents, not imported code.

### What the experiment establishes

Recorded run (Intel i7-5500U, Windows, Node 24.6.0; re-run 2026-09-05):
14,656-byte proofs in 1.1–1.7 s, 96 ms warm verification, ~560 MiB peak RSS,
29.8 s fresh setup including download. Two assets, issuance, private payment,
receiver control, return to the issuer and burn; a separate process verifies
only public evidence; competing submissions, exact saved-proof retries after
restart, and process termination on both sides of the commit boundary.
Adversarial checks: unauthorized issuance, wrong owners and paths, cross-asset
substitution, inflation, range overflow, wrong contexts, malformed proofs,
duplicate commitments, double spends under a new anchor, a valid proof over an
unaccepted root, a valid truncated history against a pinned checkpoint, and
two valid histories with equal note roots but different spent sets. These are
small-tree desktop observations: enough to continue the design, not to certify
deployment.

### What the experiment lacks, and the specification now requires

- A **spent-set accumulator with non-membership** (invariant 23, §C2b.3). The
  experiment keeps a plain set.
- **Witnessed commitments** binding the ordered statements (§C2.4); the
  experiment's history hash is the caller's checkpoint, not a witnessed one.
- **Multi-input statements**, note selection and consolidation (§C1.2
  packing).
- Demand by `H(nullifier)`, spent-pending locks, and the non-service object's
  membership proof (§C1.2, §C3, §C2b.5).
- Note delivery, backups, metadata protection, and any anonymity-set
  measurement.

## Consolidation map

| Existing part | Treatment |
|---|---|
| `backing.ts`, `bytes.ts`, `keys.ts`, `contexts.ts`, canonical identity tests | Retain. Add the pool's **E** declaration (construction, version, circuit and verification-key identities, pool identity) before issuing pool backings. Never reuse old identifiers with new rules. |
| `commitment.ts`, `commitment-directory` tests | Retain the directory. The pool's commitment adds the note-tree root, the spent-set root and the statement-log binding (invariant 23). |
| `venue.ts`, `LocalVenue` | Retain the interface: finality rule, lag, record rises in sequence, exact-sequence read (§C2.3). |
| `pilot-store.ts` journal pattern | Carry forward: durable commands, exact retries, transactional admission. The pilot's `pilot-wire.ts`, `pilot-http.ts` and CLI are retired with a pool equivalent. |
| `ledger.ts`, `oplog.ts`, `messages.ts`, `sequencer.ts`, `presentation.ts`, `replacement.ts`, `recovery.ts`, `fault.ts` and their tests | **Frozen.** The transparent profile's implementation. A differential oracle and case library; each case is ported as its rule lands over notes; the code is deleted when the pool path passes them. Do not port the exhibit walk or the opening claim (retired, Construction Appendix). |
| `ergo.ts` and its tests | Keep as the venue direction; not exported from the root barrel; rewritten for the final commitment format at step 6. |
| Research circuits, `host.mjs`, `journal.mjs` | Promote the relation into `src/` at step 3 against the normative layouts; keep the adversarial cases; retire the standalone host and receiver APIs then. Do not keep a second storage framework. |
| Website and organization profile | Describe the direction and the experimental status accurately; change the onboarding story only when a wallet exists. |

No live-value migration is assumed. If any implementation is later used with
real claims, its retirement is a successor backing with a swap. Deleting a
database or changing a verifier under the same identity is not a migration.
