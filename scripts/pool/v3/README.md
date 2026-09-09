# Six successor proof relations

Run `npm run check:pool:v3` from the repository root. This compiles and proves
all six relations against one shared `notes.nr` and the existing pinned
Poseidon2 helper. It implements the proof layouts in
[pool-v3.md at d57ddb0](https://github.com/mediumofexchange/money-from-first-principles/blob/d57ddb0/pool-v3.md).

V3 is an incomplete construction: no configuration hash, approved artifact
identity, runtime support or backing adoption is defined. These sources are
conformance tooling outside `src/`; they do not replace the v2 circuits.
The compiler writes temporary projects only under ignored `scratch/` and
the check records observed source/bytecode/key hashes, checks and metrics in
`scratch/pool-v3-results.json`. It reuses the existing parameter cache and
runs Barretenberg with one worker thread. The hashes are observations, not
configuration pins. Final pinning requires separate review.

The suite verifies every public-input position under each amended key,
equal-count spend/burn substitution in both directions, separately provable
metadata, and integer overflow with ABI range encoding bypassed while ACIR
stays identical. Hostile note witnesses recompute dependent hashes, paths
and sums where needed. Four-output and widened-conservation cases accompany
demand's canonical padding and request's refresh. The source orders are
issue 11, spend 15, burn 15, demand 16, settle 17 and request 7.

Domain and capsule fixtures are synthetic. The capsules exercise opaque
public-vector hashing only; no fixture claims receiver decryption. There is
no v3 statement parser/key router, issuance authorization, admission/replay,
lock enforcement, finality, wallet restoration or complete venue evidence
in this check. The existing delivery suite covers its separate cryptographic
seam. Those tests and real-proof conformance do not close runtime gates.
