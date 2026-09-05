# One private payment implementation

Decision and feasibility evidence, 2026-09-05. The maintainer approved moving
toward one extensible product with privacy and public supply verification,
and authorized this release contract and real-proof experiment. This records
the engineering direction; it does not silently amend the normative protocol
or approve these research circuits for live value.

## Direction

Build one wallet, one operator transition engine and one independently runnable
verifier around a common shielded-note model. Begin with constant-payout roots
and no reliance graph. Keep public immutable backing terms, authorized issuance,
exact conservation and holder-controlled spending. Hide ordinary note ownership,
asset and amount cryptographically. Make the privacy disclosures at issuance,
redemption and recovery explicit before the private profile becomes normative.

The transparent pilot supplies useful durability and retry experience. It is
not the product architecture to expand indefinitely. The larger reference
contains valuable protocol rules and adversarial cases, but its account state
and recovery machinery cannot simply be relabeled as private notes. Every reused
mechanism must preserve its security meaning under the new claim representation.

The [release contract](PRODUCTION_REQUIREMENTS.md) makes availability, recovery,
usable wallet behavior and privacy release conditions alongside monetary safety.
Removing those requirements would change the intended product. Deferring extra
payout forms, multiple venue integrations and alternative privacy constructions
reduces scope without removing them.

## Selected feasibility candidate

The executable candidate uses Noir `1.0.0-beta.26`, Barretenberg `5.2.0` and
the upstream Poseidon2 helper pinned in the experiment. There are three small
entry circuits sharing one note relation: issue, spend and burn. Issuance also
requires the obligor's signature over a framed public statement bound to the
pool, backing and locally pinned circuit/verification-key identities. Spending
has no issuer or operator authorization shortcut.

A note commits to pool, full 256-bit backing identity, bounded quantity,
receiver-generated ownership material and randomness. A spend proves membership,
ownership, same-asset conservation and valid outputs, while exposing a unique
nullifier. That nullifier does not depend on the chosen accepted root. Full
identities use two range-constrained 128-bit limbs rather than reduction modulo
the proof field. Quantities use 64-bit bounds and widened conservation sums.
The [research specification](https://github.com/mediumofexchange/money-from-first-principles/blob/edbc3f37831d63b3bdd7ac8d6bac40fdd481b671/private-payment-research.md)
defines the candidate relation and public input ordering.

Public supply follows by induction from empty state: only verified, authorized
issuance introduces claims; private transfers conserve them; verified burns
subtract them. The public verifier reconstructs every accepted root and nullifier
set. Accepting arbitrary operator-provided roots would break this argument,
even if every individual membership proof verified correctly. A valid history
prefix proves its own state, not that it is the latest state. A note-tree root
does not bind which earlier notes were spent. The experiment therefore also
commits to the ordered public statements in a configuration-seeded history hash;
the caller's expected checkpoint binds that hash along with tree root and count.

The prover, verification-key derivation and verifier all explicitly use
`verifierTarget: 'noir-recursive'`. In the pinned backend, the legacy
`keccak: true` option selects a mode with zero knowledge disabled; it is not
an acceptable privacy option. This was checked in the
[versioned backend source](https://github.com/AztecProtocol/aztec-packages/blob/v5.2.0/barretenberg/ts/src/barretenberg/backend.ts).
The experiment forces one WASM worker instead of relying on a platform-specific
native binary. Noir documents its [JavaScript compilation interface](https://noir-lang.org/docs/reference/NoirJS/noir_wasm/functions/compile);
the pinned versions were tested together rather than assumed compatible.

This backend uses downloaded structured reference parameters. The experiment
records hashes of the actual files it used, but those hashes are observations,
not an independent setup verification. Production needs a reviewed account of
the backend's setup/soundness assumptions, authenticated distribution and
dependency/build provenance. A standard backend does not audit custom circuits.

Alternatives considered were signed transparent logs, plain blind-signature
cash, and other circuit backends. Transparent logs fail the intended privacy
requirement. Blind signatures alone do not give a stranger proof that a mint
has not issued additional unrecorded claims; adding public conservation would
be a substantial construction of its own. The
[Zcash note/nullifier model](https://zips.z.cash/protocol/protocol.pdf) and
[Penumbra shielded pool](https://protocol.penumbra.zone/main/shielded_pool.html)
are useful precedents, not code imported or security inherited by this project.
[snarkjs](https://github.com/iden3/snarkjs) and
[Halo2](https://github.com/zcash/halo2) remain backend alternatives if device
measurements or review disqualify this candidate. Do not build a generic backend
framework before such a concrete need appears.

## What now runs

See the [reproduction instructions](../experiments/private-payment/README.md)
and [recorded machine-readable run](../experiments/private-payment/results/2026-09-05-windows.json).
The experiment exercises two assets, issuance, private payment, receiver control,
return to the issuer and burn. A separate process verifies only public evidence.
It also tests competing submissions, exact saved-proof retries after restart,
and abrupt process termination on both sides of the commit boundary.

Adversarial checks cover unauthorized issuance, wrong owners and paths,
cross-asset substitution, inflation, range overflow, wrong contexts, malformed
proofs, duplicate commitments and double spends under a new accepted anchor.
A cryptographically valid proof over an unaccepted root is rejected by admission.
A valid truncated history is rejected against a separately supplied expected
checkpoint. The test caller supplies that checkpoint; no independent finality
service is implemented. Another test constructs two valid histories with the
same note-tree root and event count but different spent notes, then rejects
one against the other's expected history hash. This prevents a checkpoint
from silently authenticating only the created outputs.

The recorded run on an Intel i7-5500U Windows laptop, Node 24.6.0, produced
14,656-byte proofs in approximately 1.1–1.7 seconds, with about 559 MiB peak
process RSS. A warm spend verification took 96 ms; starting a separate process
and auditing five events took 9.7 seconds with cached setup parameters. Initial
backend setup, including a fresh parameter download, took 29.8 seconds.
These are small-tree desktop observations from one final acceptance run, not
phone, browser or sustained-throughput benchmarks. Peak RSS includes
the prover process and does not establish a safe mobile memory budget. This is
promising enough to continue the design, not enough to certify deployment.

## Consolidation map

| Existing part | Treatment in the single product |
|---|---|
| `src/backing.ts`, `bytes.ts`, `keys.ts`, contexts and canonical identity tests | Retain well-tested primitives. Add a deliberate private evidence encoding/version before issuing private backings. Never reuse old identifiers with new rules. |
| `src/ledger.ts`, `oplog.ts`, `messages.ts`, conservation tests | Extract applicable invariants into the note transition engine. Transparent balances cease to be the production claim representation; preserve transparent fixtures only where they test a remaining purpose. |
| `src/pilot-store.ts`, `pilot-wire.ts`, `pilot-http.ts`, CLI and process demo | Carry forward durable commands, exact retries, transactional admission and crash cases. Replace the pilot-specific public entry points and configuration once the wallet/operator path provides their acceptance coverage. Avoid a permanent pair of ledgers. |
| Research circuits and `host.mjs` | Review and promote the relation into the production source/build, with typed and bounded external APIs. Replace full-history admission replay with authenticated state and a specified checkpoint/bootstrap scheme. Retire this harness once the production acceptance test supersedes it. |
| Research `journal.mjs` | Demonstrates proof work outside SQL plus sequence checks inside the transaction. Do not keep a second generic storage framework; integrate the proven pattern into the one operator store. |
| Witness, finality, recovery, demand and withdrawal code | Preserve the protocol obligations and attack cases. Adapt only after proving how evidence and authority work for hidden notes. Do not copy transparent recovery scans into the new wallet. |
| Ergo and other venue/profile machinery | Maintain existing correctness while its supported role remains. Freeze feature growth until the production profile selects a witness path; remove unsupported public surfaces with that consolidation. |
| Website and organization profile | Continue accurately describing experimental status. Change the onboarding story when one installable wallet/operator path actually replaces the pilot. |

No live-value migration is assumed. If any implementation is later used with
real claims, retirement needs an explicit holder-authorized migration that
preserves supply and finality. Deleting an old database or changing a verifier
under the same identity cannot be a migration mechanism.

## Next coherent build

First, specify the private evidence setting and its immutable version/circuit
binding, then implement one durable wallet-to-operator payment path against it.
That slice should include encrypted note delivery, saved outgoing requests,
receiver invoice binding, restart/restore, note selection and a bounded
multi-input shape. Move the accepted relation into production code and replace
the pilot payment path as those tests move; do not add another wallet product.

Before exposing live value, finish the chosen independent witness publication,
authenticated checkpoint and spentness evidence, replicated data retrieval,
and private redemption/recovery path. Compare the same flow on a low-end phone
and supported browser, including setup download and restore from a realistic
history. Agree the target workload and resource budget before those measurements.

The remaining material choices are the production privacy/disclosure model,
evidence/version upgrade policy, witness trust and availability assumptions,
and the remedy available after operator failure. They must become explicit
normative rules with independent review; this experiment does not choose them
silently. Gate a release on that evidence, not on how many optional mechanisms
or tests the repository happens to contain.
