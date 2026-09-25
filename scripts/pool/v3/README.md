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
specification `10dcf67`. One configuration and commitment are supported; the
selection's snapshot and trail are resolved by hash, and the other carrying
checkpoints' directories, snapshots and trails are its dependencies, with
byte/item budgets and no first-match selection of conflicting objects. The
same local replay engine checks the contents; package framing cannot
establish complete dependencies, authenticated ranges or spendability.
With a fixture venue, every carrying checkpoint of the original segment is
classified from its own trail, and under a declared silence clause the
no-commitment clock, the silence boundary and lapse by silence are read
from that walk (C2b.6.1, C2b.4.1). For a selection with imports,
a single-backing walk classifies all operator terms and requires each
segment's exact finalized predecessor. It imports the validated spent set,
output commitments, accepted roots and totals, then starts an empty local
output tree. Reappointment and same-operator restart use the same rule.
Imported wallet paths retain their source trees. Whole-read budgets cap this
path at 128 held checkpoints and 8192 replayed events, including failed
replays; a resumed checkpoint charges only its new positions, and a reader may
select other local budgets on its verifier (`importLimits`). A checkpoint
whose trail reproduces the last valid checkpoint's evidence hash at its length
resumes from a copy of that replayed state under the same replay context,
verifying only its new positions (C2.10.12, pool-v3 §7.1). Any other trail
replays in full with unchanged checks. A checkpoint's served trail may be the
prefix of any longer supplied trail of its segment whose decodable first n
records reproduce its evidence hash, and signed terms are resolved by backing
name from any strictly verifying field ([pool-v3 §12.1 at 786f962](https://github.com/mediumofexchange/money-from-first-principles/blob/786f962/pool-v3.md#121-a-package-is-not-a-complete-certificate)),
so a package needs one trail per chain of prefixes. `node scripts/pool/v3/replay-cost.mjs`
measures this path's time and bytes ([evidence](../../../docs/POOL_DEPLOYMENT_PROBES.md#replay-and-retention-cost)).
Silence-bearing imports read the independently answered publication
range, classify demand/withdrawal/release force against each original snapshot,
and preserve retirement after another segment resets the clock. A returning
segment adopts the complete block through its opening index in venue order,
retaining the exact proof and authorization bytes. Standing demands and locks
survive imports; settlement outputs restore from public fields and the seed.
Same-index fresh openings import the latest valid lower same-operator sequence
under [C2b.4.1 at fb7dd07](https://github.com/mediumofexchange/money-from-first-principles/blob/fb7dd07/pool-recovery.md#6-return).
Their inherited adoption indices preserve publications still owed, while gap
and publication-force reads stay strictly before the index.
The scope classifier also handles two-backing split/rejoin histories, shared
ancestry, per-backing adoption obligations and their exact publication union.
Configuration adoption remains unsupported. Import lapse authenticates scope
and terms independently of event history; live validity and exclusion retain
their complete evidence requirements. The local-only restoration scanner
continues to refuse imports.

Kind-7 package items carry existing §9 compact fault openings. When a checkpoint
is reached, the reader can authenticate its committed target proof without
unrelated event preimages and retain a `PROOF` fact in `faultEvidence`, including
on later refusal or lapse. Exact commitment, position and byte hashes identify
the observation. Every scoped term must match the reader's candidate configuration
and venue. Only a supported proof verifier's strict rejection produces a fact;
exceptions propagate. Facts never decide classification, state, clocks or receipt
status. Missing complete history still prevents exclusion and import descent.
The same inventory also reports strict signature failures for issue K, settlement
acceptance K, withdrawal presenter and settlement release presenter. K comes from
the target backing's signed scoped terms. A presenter's key comes from the exact
canonical demand statement whose hash the target names, carried in another compact
item. The dependency item's opening need not authenticate: its statement preimage
establishes identity, never demand admission or standing. Missing/mismatched demand
preimages suppress presenter observations while independent K failures remain.
Facts name the expected signer and role and attribute the committed bytes to the
operator. Signature checks do not require a valid or well-shaped proof. Unsupported
authorization widths, malformed targets, zero-owner acceptance messages, capsules
and admission failures remain outside this reporter.
Per-read local limits are 32 compact items, 1 MiB of backing
allocations and 1024 suffix entries per item; proof results are cached by exact
evidence identity. These limits do not change protocol bounds or grant finality.

A package containing one kind-10 receipt requests a seedless receipt read.
The checkpoint walks authenticate its opening, complete original scope and
held `after`, compare all five event fields, and apply receipt precedence
through the earliest scoped silence or term boundary. A transition carrying
any original backing counts, including one dropping the selected backing.
Held noncarrying and excluded checkpoints occupy sequences for repair reads.
The reader stops at proven inclusion;
later unavailable evidence cannot erase it. Other refusals retain already
proven contradictions in `receiptEvidence`. Adopted receipts name the new
segment and position while retaining original proof and authorization hashes.
Receipt results expose no wallet candidates or spending authority. Multiple
receipts per package and receipt reads without venue evidence are unsupported.

Signed non-service terms enable a seedless C2b.5.2 count in the audit. The
reader uses the canonical checkpoint strictly before the judging index,
including imported roots, spent tags and standing locks. It groups request
publications by statement identity at their first index, verifies any proof
variant available strictly before judgment, and counts distinct unserved
tags in the signed window. Handover preserves requests and changes the
incumbent. Across scope changes the selected backing retains its own clause;
sibling durations, thresholds and windows need not agree. Shared canonical
roots, spent tags and locks feed the same counter. Checkpoints at the judging
index and unadopted recovery publications cannot change its strictly earlier
state. A non-service clause needs no silence clause; without the former
there is no count. Missing range or ancestry evidence returns no audit.
The count shares the import work budget and fixture authority boundary.

The reader is the runtime's (`src/pool/v3/reader.ts` and `state.ts` in
`dist/`); `local-replay.mjs` layers imports, scopes, receipts, recovery force
and non-service counts over it, and reads each package's venue data through
the verifier's record factory, a `RecordVenue` (`FixtureVenue` by default).

To replay every group above a second time through `ErgoVenue`, run
`npm run check:pool:ergo-replay` (Node 24; it needs only the root
dependencies). CI uses `npm run check:pool:v3 -- --ergo` to include both
relation conformance and this read. Under `--ergo` every fixture names the
synthetic reference chain's venue identity; each fixture venue export is
written into blocks of that chain (index `i` is the block `i + 1` above the
anchor, lag 2 is depth 1, one transaction per record in insertion order), the
reader's own `ErgoVenue` verifies them from its own anchor context, and the
Ergo result must equal the fixture venue's with kind-4 ordinals as
transaction positions. Missing, unframable or root-mismatched sections stop
the clock and leave the range unresolved. Successful results carry
`ergo-venue-synthetic-chain` provenance; they establish no mainnet
authentication or spendability.
See the [Ergo venue guide](../../../docs/ERGO_VENUE_PROFILE.md#local-replay-through-the-venue).

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
in this check. `test/pool-v3-capsules.test.ts` covers the separate cryptographic
seam. Those tests and real-proof conformance do not close runtime gates.

The `src/pool/v3/records.ts` codec follows
[pool-v3 §§5–6 at ca727f6](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks canonical statement/publication bytes and signature-message
binding. It has no proof verifier or adopted configuration; these circuit
fixtures and the byte fixtures do not yet form an admitted runtime path.
