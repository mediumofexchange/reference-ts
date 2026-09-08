# Pool fault recovery

Selected contract and evidence, 2026-09-08. The maintainer authorized the
recommendations: authenticated exclusion, the snapshot clock, continuation
from the last valid prefix, and existing receipt precedence. The normative
[contract](https://github.com/mediumofexchange/money-from-first-principles/blob/main/pool-fault.md)
amends Construction, authority and recovery for a later construction version.
Runtime remains pinned to v2.

## Selected rules and limits

`FaultWorld` has one clock, read from the snapshot, and an excluded checkpoint
does not end its segment. Rejected clocks and termination policies live in a
historical test helper; their counterexamples remain executable.

| Rule | Consequence and cost |
|---|---|
| C2.10.10: bind admitted evidence separately from semantic history | Replica substitutions cannot prove operator fault. Retain original proof and signature bytes; alternate proofs cannot classify the checkpoint. Evidence in a valid prefix is immutable. |
| C2.10.11–13: classify at the original record prefix | Excluded checkpoints are passed; missing evidence blocks. A held excluded sequence is occupied, never a repair hole. |
| C2b.6.1: the clock is the snapshot's | Only valid carrying checkpoints reset the backing's clock. Its duration prices a drop as darkness; clock verdicts require snapshot evidence. |
| C2.10.12: continue from the last valid prefix | A stale twin need not force a new segment. Excluded positions can be repaired before silence retires the segment. |
| C2.10.9c: fault decides no receipt | Existing precedence remains. A later construction compares admitted evidence hashes as well as position, statement and history. |

The model uses ideal proof and authentication tokens. It does **not** yet
implement the separate evidence chain, exact-byte receipt comparison, fault
certificate encoding or an authenticated production range service. Model these
before fixing v3 bytes. A receipt attesting bad evidence must be contradicted
if a later valid checkpoint uses different evidence for that same statement.
Current repair cases instead receipt the original valid proof, exclude a
hostile clone, then finalize the original admitted evidence.

## Classification and reader contract

The original failure remains in `pool-fault-boundary.test.ts`: under the old
contracts, one invalid carrying checkpoint blocked snapshot, count and descent
even after replacement; bad streams suppressed silence. Earlier finality
survived. Missing bytes still cannot justify rollback under the selected rules.

| Class | Evidence and consequence |
|---|---|
| Valid | Canonical descent, imports, replay, last-valid continuity and required recovery adoption pass. The empty opening is exempt from later adopted-block completeness. |
| Excluded | Exact operator-authenticated evidence fails deterministically. No state, import target, clock reset or receipt transition. |
| Unresolved | A directory, scope, trail, record interval or dependency is missing or mismatching. No verdict or rollback. Unsupported verifiers and operational failures do not prove fault. |
| Lapsed | Authenticated whole-scope term or historical silence evidence permits passing. Lapse takes precedence; failing evidence may still prove fault separately. |

`World.include` records witnessing and an initial diagnostic result, not
venue-certified validity. `FaultWorld.record` re-evaluates against earlier
indices plus lower same-operator sequences at its own index. Later facts do
not retrospectively fault an earlier finalized prefix.

`world.reader()` snapshots records, terms, revocations, publications and
available evidence. Readers share ideal immutable identities, not verdicts.
Each owns its withheld/mismatching facets. Memoization lasts one read; cycles
refuse. Refresh changed record facts, including same-index revocation.
Future-index queries are hypothetical, not complete future-record evidence.

Every dependent read passes evidenced exclusions and refuses unresolved
checkpoints. Publications retain force at their original prefix; return adopts
all force through its opening index. The semantic observer alone reads hidden
note openings to check supply, authority and consumption.

## Dependencies and rejected alternatives

The snapshot clock removes extra classification of non-carrying checkpoints
merely to reset the clock. Whole-scope and transitive ancestry dependencies
remain. Reads still need complete record intervals, directory carriage/absence,
and carrying-checkpoint classification evidence. Later resets do not remove
historical silence boundaries.

Historical A″, term-only, all-history and bad-carrying reset tests preserve
unrelated stale/fresh commitments suppressing redemption and recursive evidence
dependencies. Historical R7 preserves the honest twin's forced restart and
abandoned tail. No intrinsic rule can distinguish withheld preimages from
honest replica loss. Availability, retention and bounded cold reads remain
separate gates; cached verdicts cannot replace evidence or fresh snapshots.

## What the actual v2 bytes establish

`pool-fault-evidence.test.ts` uses real SHA-256 and Ed25519 with the oracle
proof verifier. It establishes that substituted failing proof/signature bytes
reject replay while the original trail still validates the checkpoint; a
separate signed receipt does not attribute its bytes to that checkpoint; and
alternate valid proofs preserve semantic history while idempotent admission
returns original receipts and evidence. It does not test proof-system soundness.

C2.10.10 selects a separate evidence chain beside semantic history. A linear
chain needs later recurrence inputs for an interior-event certificate: three
32-byte digests per later evidence event, before target bytes, framing,
directory proof and ancestry. A tree could reduce suffix cost. No v3 encoding,
production retention bound or node acceptance is established here.

## Review and next boundary

The earlier [checked design review](../decisions/archive/2026-09-08-whole-project-design-review-check.md)
and [fault review](../decisions/archive/2026-09-08-pool-fault-review.md) retain
independent findings. The [proposal](https://github.com/mediumofexchange/money-from-first-principles/blob/a6edadc/pool-fault.md)
and [its review dispositions](https://github.com/mediumofexchange/reference-ts/blob/b6a0970/docs/POOL_FAULT_RECOVERY.md)
remain immutable history.

Adoption review corrected explicit receipt evidence comparison, last-valid
rather than excluded-prefix evidence immutability, empty-opening and adopted
statement exceptions, and the overbroad claim of no cross-scope dependencies.
It also removed stale operator-wide clock wording. Exact evidence mismatch
changes comparison fields, not statement identity or verdict precedence.

| Tests in `model/` | Evidence |
|---|---|
| `pool-fault-boundary.test.ts`, `pool-fault.test.ts` | Original failure, selected remedy, unresolved rollback and reversed-verdict departures. |
| `pool-fault-reader.test.ts` | Independent readers, arrival order, retention, scope evidence, repair and same-index revocation. |
| `pool-fault-clock.test.ts`, `pool-fault-dependency.test.ts` | Historical clock costs, strict boundaries, term lapse, force and adoption. |
| `pool-fault-liability.test.ts`, `pool-fault-evidence.test.ts` | Receipt precedence, stale twins and real v2 authentication limits. |
| `pool-fault-alternatives.test.ts` | Selected defaults versus historical departures: drop, redemption, return, disjoint scopes, silence, continuation and statement replacement. |
| `pool-recovery-return.test.ts`, `pool-silence.test.ts` | Historical retirement, adoption, receipt precedence and unsafe return under `forgetSilence`. |

Next: model exact evidence binding and receipt comparison, with alternate valid
proofs, bad committed evidence, immutable valid prefixes, missing/substituted
bytes and repaired unfinalized positions. Independently review before v3
layouts. Measure retention/retrieval, authenticated note delivery/restoration,
custody and pinned-node publication. Current verification belongs in
[`WORK.md`](../WORK.md).
