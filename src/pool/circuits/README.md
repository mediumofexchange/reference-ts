# pool-v1 circuits

These sources implement the issue, spend and burn relations in the companion
specification's `pool-v1.md` §§1, 3–5. The rest of the claim layer — the
host hash, notes, the note tree, the spent set, the frames, and admission
with replay — is the TypeScript beside them in `src/pool/`. A valid circuit
proof alone does not authorize an issuance or establish that an anchor
belongs to accepted history; `pool.ts` does that (§6), and the sequencing
layer's receipt envelope is still separate work.

Run from the repository root after `npm ci`:

```sh
npm run check:pool
```

The check builds the package, compiles all three circuits with Noir
`1.0.0-beta.26`, derives Barretenberg `5.2.0` UltraHonk keys with
`verifierTarget: noir-recursive` (zero knowledge), compares
source/bytecode/key SHA-256s to `manifest.json`, and exercises real proofs,
every public input's binding, and hostile witnesses. The seven-field spend
permits two backings, two inputs including padding, and two outputs; burn
has nine fields and one change output. It then runs
`scripts/pool/admission.mjs`: the wallet side derives owners, commitments,
nullifiers and paths with `dist/pool`'s host functions, proves with these
circuits, and `Pool` admits, refuses and replays through
`pool/barretenberg.ts`'s verifier — issuance under K's signature, a padded
spend, a re-proven resubmission, respends and unaccepted roots, a burn,
corrupted and cross-kind proofs, and replay by a second verifier.

`scripts/pool/fixtures.mjs` builds synthetic depth-32 paths with the backend's
host Poseidon2 hash. It is test tooling, including roots that exercise high
positions; it is not the production note tree or an accepted-history oracle.
Those independently hashed commitments, nullifiers and paths must agree with
the vendored Noir sponge for every successful proof.

Compilation runs in a child process because the WASM compiler's Windows path
adaptation changes Node's path functions. Generated programs and witnesses
are removed after each run. `scratch/pool-v1-results.json` records the checks,
timings, identities and exact cached parameter-file hashes. The backend
shares `scratch/private-payment-crs/` with the existing experiment and may
download missing parameters from its configured CDN. Hashes identify what
was used; they do not establish ceremony provenance or production trust.

The recorded Windows/Node 24.6.0 run is
[`docs/pool-v1-verification.json`](../../../docs/pool-v1-verification.json):
106 checks and seventeen real proofs, each 14,656 bytes, including the
claim-layer run. Its timings are desktop observations, not a phone/browser
budget or a production performance claim.

To review a deliberate source change before these identities are normative:

```sh
node scripts/pool/check.mjs --write-pins
```

This writes the manifest only after the full circuit suite passes. Review
the changed identities independently and record them in the specification.
Once v1 is instantiated, changed identities require a new construction and
successor backing. The compile-only command accepts a scratch directory:
`node scripts/pool/compile.mjs scratch/pool-build`.

The third-party Poseidon2 helper and license live in `vendor/`; sources use
LF endings under the repository's `.gitattributes` so their hashes survive
Windows checkouts. Circuit sources and their manifest ship with the package;
proving tools are development dependencies, not a supported wallet API.
