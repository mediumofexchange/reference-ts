# pool-v2 circuits

These sources implement the issue, spend and burn relations in the companion
specification's `pool-v2.md` §§1, 3–5 and 7. The rest of the claim layer —
the host hash, notes, the note tree, the scope tree, the spent set, the
frames, the segment with its import, admission and replay, and the receipt —
is the TypeScript beside them in `src/pool/`. A valid circuit proof alone
does not authorize an issuance, establish that an anchor belongs to the
accepted-root forest, or say which scope is in force; `segment.ts` does the
first two (§8, §10), and the sequencing layer over the witnessed record does
the third.

Run from the repository root after `npm ci`:

```sh
npm run check:pool
```

The check builds the package, compiles all three circuits with Noir
`1.0.0-beta.26`, derives Barretenberg `5.2.0` UltraHonk keys with
`verifierTarget: noir-recursive` (zero knowledge), compares
source/bytecode/key SHA-256s to `manifest.json`, and exercises real proofs,
every public input's binding — the segment identity's limbs included, which
no constraint reads — and hostile witnesses: wrong or foreign scope entries,
wrong links, wrong scope paths, inputs against the wrong slot's anchor, and
the v1 cases for ownership, membership, conservation and overflow. The
eleven-field spend permits two backings, two inputs including padding, each
against its own anchor, and two outputs; burn has thirteen fields and one
change output; issue has nine. It then runs `scripts/pool/admission.mjs`:
the wallet side derives owners, commitments, nullifiers, note paths and
scope paths with `dist/pool`'s host functions, proves with these circuits,
and a `Segment` admits, refuses, imports and replays through
`pool/barretenberg.ts`'s verifier — issuance under K's signature, a padded
spend, a re-proven resubmission, respends and unaccepted roots, a burn,
corrupted and cross-kind proofs, replay by a second verifier, then a
successor operator's segment opened from the first operator's checkpoint:
the discarded tail's root refused, a note from the first segment spent
against its certified root, a payment from the tail re-proven with its
nullifier unchanged, one spend against two anchors, and replay of the
successor segment from the checkpoint evidence.

`scripts/pool/fixtures.mjs` builds synthetic depth-32 note paths and a
depth-16 scope tree with the backend's host Poseidon2 hash. It is test
tooling, including roots that exercise high positions; it is not the
production note tree, scope tree or an accepted-history oracle. Those
independently hashed commitments, nullifiers, leaves and paths must agree
with the vendored Noir sponge for every successful proof.

Compilation runs in a child process because the WASM compiler's Windows path
adaptation changes Node's path functions. Generated programs and witnesses
are removed after each run. `scratch/pool-v2-results.json` records the checks,
timings, identities and exact cached parameter-file hashes. The backend
shares `scratch/private-payment-crs/` with the existing experiment and may
download missing parameters from its configured CDN. Hashes identify what
was used; they do not establish ceremony provenance or production trust.

The recorded Windows/Node 24.6.0 run is
[`docs/pool-v2-verification.json`](../../../docs/pool-v2-verification.json).
Its timings are desktop observations, not a phone/browser budget or a
production performance claim.

To review a deliberate source change before these identities are normative:

```sh
node scripts/pool/check.mjs --write-pins
```

This writes the manifest only after the full circuit suite passes. Review
the changed identities independently and record them in the specification.
Once v2 is instantiated, changed identities require a new construction and
successor backing. The compile-only command accepts a scratch directory:
`node scripts/pool/compile.mjs scratch/pool-build`.

The third-party Poseidon2 helper and license live in `vendor/`; sources use
LF endings under the repository's `.gitattributes` so their hashes survive
Windows checkouts. Circuit sources and their manifest ship with the package;
proving tools are development dependencies, not a supported wallet API.
