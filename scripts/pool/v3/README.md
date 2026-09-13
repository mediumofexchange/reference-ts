# Six successor proof relations

Run `npm run check:pool:v3` from the repository root. This compiles and proves
all six relations against one shared `notes.nr` and the existing pinned
Poseidon2 helper. It implements the proof layouts in
[pool-v3.md at d57ddb0](https://github.com/mediumofexchange/money-from-first-principles/blob/d57ddb0/pool-v3.md).

V3 is an incomplete construction: no approved configuration hash, artifact
identity, runtime support or backing adoption is defined. These sources are
conformance tooling outside `src/`; they do not replace the v2 circuits.
The compiler writes temporary projects only under ignored `scratch/` and
the check records observed source/bytecode/key hashes, checks and metrics in
`scratch/pool-v3-results.json`. It reuses the existing parameter cache and
runs Barretenberg with one worker thread. The hashes are observations, not
configuration pins. Final pinning requires separate review.

The local replay command additionally uses the independently held
`candidate-manifest.json` and [pool-v3 §11 at 916bffb](https://github.com/mediumofexchange/money-from-first-principles/blob/916bffb/pool-v3.md#11-configuration-and-backing-evidence-before-adoption).
It checks all six candidate source/toolchain/bytecode/key identities, the fixed
439-byte configuration and signed constant-root terms before local replay.
The candidate domain is derived from the configuration; issuance keys come
from the signed terms. The manifest cannot enable adoption. See the
[local replay evidence and limits](../../../docs/POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay).

Fresh readers additionally decode the canonical §12 evidence package at
specification `10dcf67`. One config/commitment/directory/snapshot/trail is
supported, with byte/item budgets and no first-match selection of conflicting
objects. The same local replay engine checks the contents; package framing
cannot establish complete dependencies, authenticated ranges or spendability.

The npm command verifies parameter cache/download lengths and SHA-256 hashes
with `../prepare-crs.mjs` before starting the suite. It checks both upstream
hosts on download failure; an empty or corrupt successful HTTP response is
never cached. These are the existing bb.js 5.2.0 test parameters recorded in
`docs/pool-v2-verification.json`; Barretenberg's own validation remains active.
A mismatched uncompressed cache fails explicitly. This does not establish
ceremony trust or approve a v3 configuration.

The suite verifies every public-input position under each amended key,
equal-count spend/burn substitution in both directions, separately provable
metadata, and integer overflow with ABI range encoding bypassed while ACIR
stays identical. Hostile note witnesses recompute dependent hashes, paths
and sums where needed. Four-output and widened-conservation cases accompany
demand's canonical padding and request's refresh. The source orders are
issue 11, spend 15, burn 15, demand 16, settle 17 and request 7.

Domain and capsule fixtures are synthetic. The capsules exercise opaque
public-vector hashing only; no fixture claims receiver decryption. There is
no v3 key router, issuance authorization, admission/replay,
lock enforcement, finality, wallet restoration or complete venue evidence
in this check. The existing delivery suite covers its separate cryptographic
seam. Those tests and real-proof conformance do not close runtime gates.

The separate `model/pool-v3-records.ts` codec follows
[pool-v3 §§5–6 at ca727f6](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks canonical statement/publication bytes and signature-message
binding. It has no proof verifier or adopted configuration; these circuit
fixtures and the byte fixtures do not yet form an admitted runtime path.
